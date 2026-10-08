//! Concrete `fs` capability implementation (atomic, no business logic — red
//! line 3). Uses std/tokio fs; the isolation boundary means swapping the
//! underlying crate never touches plugins (docs/06 §5).

use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::UNIX_EPOCH;

use fm_contracts::capability::{CapabilityError, FsApi, ListEntry, ReadChunkOut, StatOut};

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

    fn read_text(&self, path: &str) -> Result<String, CapabilityError> {
        fs::read_to_string(path).map_err(CapabilityError::from_io)
    }
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
