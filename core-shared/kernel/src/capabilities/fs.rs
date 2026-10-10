//! Concrete `fs` capability implementation (atomic, no business logic — red
//! line 3). Uses std/tokio fs; the isolation boundary means swapping the
//! underlying crate never touches plugins (docs/06 §5).

use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use fm_contracts::capability::{
    CapabilityError, FsApi, ListEntry, ReadChunkOut, ReadTextOut, StatOut, TextReadState,
    MAX_TEXT_READ_BYTES,
};

/// std-fs backed implementation of [`FsApi`].
pub struct StdFs;

/// Last-modification millis, or `None` when the platform reports no mtime
/// (some network filesystems) or it predates the epoch.
pub(crate) fn mtime_ms(meta: &fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

impl FsApi for StdFs {
    /// Non-recursive listing in natural, case-insensitive name order (`file 2`
    /// before `file 10`). The provider owns the order so a browser never sorts
    /// 100k names in the UI thread — see also `buildRows`, which groups by type
    /// while preserving this order.
    fn list(&self, dir: &str) -> Result<Vec<ListEntry>, CapabilityError> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir).map_err(CapabilityError::from_io)? {
            let entry = entry.map_err(CapabilityError::from_io)?;
            let path = entry.path();
            let meta = entry.metadata().map_err(CapabilityError::from_io)?;
            let is_dir = meta.is_dir();
            out.push(ListEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
                is_dir,
                size: if is_dir { None } else { Some(meta.len()) },
                modified_ms: if is_dir { None } else { mtime_ms(&meta) },
            });
        }
        out.sort_by(|a, b| {
            natord::compare_ignore_case(&a.name, &b.name).then_with(|| a.name.cmp(&b.name))
        });
        Ok(out)
    }

    fn stat(&self, path: &str) -> Result<StatOut, CapabilityError> {
        let meta = fs::metadata(path).map_err(CapabilityError::from_io)?;
        Ok(StatOut {
            path: path.to_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
            modified_ms: mtime_ms(&meta),
        })
    }

    fn read_chunk(
        &self,
        path: &str,
        offset: u64,
        len: u64,
    ) -> Result<ReadChunkOut, CapabilityError> {
        let mut file = fs::File::open(path).map_err(CapabilityError::from_io)?;
        let total = file.metadata().map_err(CapabilityError::from_io)?.len();
        use std::io::Seek;
        file.seek(std::io::SeekFrom::Start(offset))
            .map_err(CapabilityError::from_io)?;
        let mut buf = vec![0u8; len as usize];
        let n = file.read(&mut buf).map_err(CapabilityError::from_io)?;
        buf.truncate(n);
        Ok(ReadChunkOut {
            path: path.to_owned(),
            offset,
            data: buf,
            total,
        })
    }

    fn read_text(&self, path: &str) -> Result<ReadTextOut, CapabilityError> {
        let meta = fs::metadata(path).map_err(CapabilityError::from_io)?;
        if meta.is_dir() {
            return Err(CapabilityError::InvalidArgument(format!(
                "not a regular file: {path}"
            )));
        }
        let byte_length = meta.len();
        let out =
            |state: TextReadState, text: Option<String>, encoding: Option<String>| ReadTextOut {
                path: path.to_owned(),
                state,
                text,
                encoding,
                byte_length,
            };
        // Refuse the size before reading it: the ceiling exists so a 2 GB "text
        // file" cannot be pulled into the WebView by an accidental focus.
        if byte_length > MAX_TEXT_READ_BYTES {
            return Ok(out(TextReadState::TooLarge, None, None));
        }
        let bytes = fs::read(path).map_err(CapabilityError::from_io)?;
        match decode_text(&bytes) {
            Decoded::Text { text, encoding } => {
                Ok(out(TextReadState::Ok, Some(text), Some(encoding)))
            }
            Decoded::Binary => Ok(out(TextReadState::Binary, None, None)),
        }
    }
}

/// What [`decode_text`] decided.
enum Decoded {
    Text { text: String, encoding: String },
    Binary,
}

/// Decode bytes that are supposed to be text.
///
/// Order matters and is the whole point (roadmap P7-19): a BOM is a fact, so it
/// wins; valid UTF-8 is a fact, so it wins next; only a file that is neither goes
/// to `chardetng` for a *guess*, and a guess that still yields garbage is reported
/// as binary rather than as text full of U+FFFD. Both jobs belong to maintained
/// libraries (`chardetng` + `encoding_rs`, the same pair Firefox uses) — this
/// function contains no heuristic of its own beyond the binary veto.
fn decode_text(bytes: &[u8]) -> Decoded {
    // A byte-order mark is unambiguous — and must be checked before the NUL scan,
    // because UTF-16 text is full of NUL bytes by construction.
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_with(encoding_for_bom(bytes), bytes);
    }

    // Valid UTF-8, with or without a BOM (the mark is stripped, never shown). A
    // NUL body is still binary even though every byte happens to decode.
    if let Some(text) = strip_bom_utf8(bytes) {
        if looks_binary(&text) {
            return Decoded::Binary;
        }
        return Decoded::Text {
            text,
            encoding: "UTF-8".to_owned(),
        };
    }

    // Not UTF-8: let the detector guess from the whole (already size-capped) body.
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    // The detector answers with the *replacement* encoding when it has no guess at
    // all; and its single-byte fallback (windows-1252) is only believable when the
    // bytes actually read as text, which is what `decode_with` vetoes.
    if encoding.name() == "replacement" {
        return Decoded::Binary;
    }
    decode_with(encoding, bytes)
}

/// The BOM cases, as `encoding_rs` encodings (which decode and strip the mark).
fn encoding_for_bom(bytes: &[u8]) -> &'static encoding_rs::Encoding {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        encoding_rs::UTF_16LE
    } else {
        encoding_rs::UTF_16BE
    }
}

/// Decode `bytes` with `encoding` and veto the result if it is mostly garbage.
fn decode_with(encoding: &'static encoding_rs::Encoding, bytes: &[u8]) -> Decoded {
    let (cow, _used, _had_errors) = encoding.decode(bytes);
    // `windows-1252` and friends decode *anything*, so the decoder's own error
    // flag is not enough: a replacement-character wall is the honest tell of a
    // wrong guess, and a wrong guess is shown as binary, not as garbage text.
    if looks_binary(&cow) {
        return Decoded::Binary;
    }
    Decoded::Text {
        text: cow.into_owned(),
        encoding: encoding.name().to_owned(),
    }
}

/// A UTF-8 file with an optional BOM, as text — or `None` when it is not valid
/// UTF-8.
fn strip_bom_utf8(bytes: &[u8]) -> Option<String> {
    let body = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    std::str::from_utf8(body).map(str::to_owned).ok()
}

/// Whether decoded text is actually garbage: control bytes a text file would not
/// carry, or a wall of U+FFFD from a wrong encoding guess.
fn looks_binary(text: &str) -> bool {
    if text.contains('\0') {
        return true;
    }
    let sample = text.chars().take(8_192);
    let mut odd = 0usize;
    let mut total = 0usize;
    for ch in sample {
        total += 1;
        if ch == '\u{FFFD}' || (ch.is_control() && !matches!(ch, '\t' | '\n' | '\r')) {
            odd += 1;
        }
    }
    // Half garbage is not a text file. Below that it may legitimately be a
    // badly-tagged one, and showing it beats refusing it.
    total > 0 && odd * 2 > total
}

/// Return the user's home directory as a canonical string (best effort).
pub fn home_dir() -> String {
    // Tauri's resolver is the canonical source at runtime; this is a portable
    // fallback for headless tests and pre-window boot.
    if let Some(h) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        return Path::new(&h).to_string_lossy().into_owned();
    }
    ".".to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decoded(bytes: &[u8]) -> (String, String) {
        match decode_text(bytes) {
            Decoded::Text { text, encoding } => (text, encoding),
            Decoded::Binary => panic!("expected text, got binary"),
        }
    }

    #[test]
    fn plain_utf8_is_recognised_without_a_guess() {
        let (text, encoding) = decoded("第一行\nsecond line\n".as_bytes());
        assert_eq!(text, "第一行\nsecond line\n");
        assert_eq!(encoding, "UTF-8");
    }

    #[test]
    fn a_utf8_bom_is_stripped_not_shown() {
        let bytes = [0xEF, 0xBB, 0xBF]
            .into_iter()
            .chain(
                "表头\n"
                    .chars()
                    .flat_map(|c| c.encode_utf8(&mut [0u8; 4]).bytes().collect::<Vec<u8>>()),
            )
            .collect::<Vec<u8>>();
        let (text, encoding) = decoded(&bytes);
        assert_eq!(encoding, "UTF-8");
        assert!(
            text.starts_with("表头"),
            "BOM leaked into the body: {text:?}"
        );
        assert!(!text.contains('\u{FEFF}'));
    }

    #[test]
    fn non_utf8_text_is_decoded_by_the_detector() {
        // GBK bytes for the same sentence: only a detector + decoder can read it.
        let (gbk, _, _) = encoding_rs::GBK.encode("中文乱码测试\n");
        assert!(
            std::str::from_utf8(&gbk).is_err(),
            "fixture must not be UTF-8"
        );
        let (text, encoding) = decoded(&gbk);
        assert_eq!(text, "中文乱码测试\n");
        assert!(
            encoding.contains("GBK") || encoding.contains("gb18030"),
            "got {encoding}"
        );
    }

    #[test]
    fn utf16_with_a_bom_is_not_mistaken_for_binary() {
        // Built by hand: `Encoding::encode` deliberately maps the UTF-16 *labels*
        // to UTF-8 output, so it cannot produce the fixture. A real file carries
        // the mark, and the BOM check is what keeps UTF-16LE's NUL bytes from
        // reading as binary.
        let mut bytes = vec![0xFF, 0xFE];
        bytes.extend("utf16 中文\n".encode_utf16().flat_map(u16::to_le_bytes));
        let (text, encoding) = decoded(&bytes);
        assert_eq!(text, "utf16 中文\n", "the mark must be stripped, not shown");
        assert_eq!(encoding, "UTF-16LE");
    }

    #[test]
    fn binary_bytes_are_a_state_not_garbage_text() {
        let mut png = vec![0x89, b'P', b'I', b'H', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend((0..200).map(|i| (i % 253) as u8));
        assert!(matches!(decode_text(&png), Decoded::Binary));
        assert!(matches!(decode_text(&[0u8; 64]), Decoded::Binary));
    }

    #[test]
    fn an_empty_file_is_text() {
        let (text, encoding) = decoded(b"");
        assert_eq!(text, "");
        assert_eq!(encoding, "UTF-8");
    }

    /// The cap protects the WebView, so it is enforced before reading — and the
    /// size is still reported, which is what lets the panel say "太大" with a number.
    #[test]
    fn an_oversized_file_is_refused_by_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt");
        std::fs::write(&path, vec![b'a'; (MAX_TEXT_READ_BYTES + 1) as usize]).unwrap();
        let out = StdFs.read_text(&path.to_string_lossy()).unwrap();
        assert_eq!(out.state, TextReadState::TooLarge);
        assert_eq!(out.text, None);
        assert_eq!(out.byte_length, MAX_TEXT_READ_BYTES + 1);
    }

    #[test]
    fn a_directory_is_a_caller_error_not_a_state() {
        let dir = tempfile::tempdir().unwrap();
        let err = StdFs.read_text(&dir.path().to_string_lossy()).unwrap_err();
        assert!(
            matches!(err, CapabilityError::InvalidArgument(_)),
            "{err:?}"
        );
    }

    #[test]
    fn a_real_gbk_file_round_trips_through_read_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cn.txt");
        let (gbk, _, _) = encoding_rs::GBK.encode("价格表\n合计 12,345 元\n");
        std::fs::write(&path, &gbk).unwrap();
        let out = StdFs.read_text(&path.to_string_lossy()).unwrap();
        assert_eq!(out.state, TextReadState::Ok);
        assert_eq!(out.text.as_deref(), Some("价格表\n合计 12,345 元\n"));
        assert!(out.encoding.unwrap().contains("GBK"));
        assert_eq!(out.byte_length, gbk.len() as u64);
    }
}
