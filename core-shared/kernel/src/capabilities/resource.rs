//! The preview resource channel (`fs.openResource` / `fs.readResource` /
//! `fs.closeResource`, roadmap P7-20).
//!
//! Why this exists at all: a viewer in the WebView must not be handed a bare
//! `file:`/asset URL (that would make the whole disk addressable from any panel),
//! and it must not receive a large file as one base64 payload. So the host keeps
//! the bytes, and the frontend gets an **opaque, path-bound, short-lived handle**
//! plus bounded ranged reads through it.
//!
//! What a handle is *not*: it is not a capability ticket for the filesystem — it
//! names one already-validated regular file, it expires, it dies on
//! `fs.closeResource`, and it can only ever be read in ≤
//! [`MAX_RESOURCE_CHUNK_BYTES`] slices. Nothing here writes, lists, or follows a
//! caller-supplied path after open time.
//!
//! Cancellation is honest: there is no interruptible read at the OS level, so a
//! fast viewer cancels by discarding the answer. The request token therefore only
//! travels through untouched (see [`crate::capabilities::fs`]'s chunk channel for
//! the same shape), and `eof`/`total` always describe the bytes actually read.

use std::collections::HashMap;
use std::io::{Read, Seek};
use std::path::Path;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine as _;
use fm_contracts::capability::{
    CapabilityError, FsResourceApi, ReadResourceIn, ReadResourceOut, ResourceIn, ResourceOut,
    MAX_RESOURCE_CHUNK_BYTES, RESOURCE_TTL_MS,
};

use crate::capabilities::file_kind::kind_of_extension;

/// How many handles may be alive at once. Previews are one-at-a-time by design
/// (the zone shows one selection), and a leaked handle should be rare — the cap
/// is what turns a consumer that forgot to close into a bounded problem instead
/// of an unbounded file table.
const MAX_LIVE_RESOURCES: usize = 16;

/// One live handle.
struct Entry {
    /// The path bound at open time. Reads re-open it per chunk rather than holding
    /// an OS handle: a preview can last minutes, and a long-open file handle on
    /// Windows would block the very rename/delete the file-ops plugin offers.
    path: String,
    /// Size at open time — the clamp reference, refreshed when a read sees less.
    byte_length: u64,
    /// Monotonic deadline; refreshed by every successful read (an *untouched*
    /// handle expires, an actively viewed one does not).
    deadline: Instant,
    /// Opaque id, also the map key.
    id: String,
}

/// The handle table. `Arc<Mutex<..>>` so the cordis service and the Tauri command
/// layer share one view, matching how [`super::shell_ops::ShellOps`] owns its own
/// in-flight state.
#[derive(Clone)]
pub struct Resources {
    inner: Arc<Mutex<Table>>,
    /// Test seam: [`Resources::new`] always uses [`RESOURCE_TTL_MS`].
    ttl: Duration,
}

#[derive(Default)]
struct Table {
    entries: HashMap<String, Entry>,
    next_id: u64,
}

impl Default for Resources {
    fn default() -> Self {
        Self::new()
    }
}

impl Resources {
    /// Build the channel with the contract's TTL.
    #[must_use]
    pub fn new() -> Self {
        Self::with_ttl(Duration::from_millis(RESOURCE_TTL_MS))
    }

    /// With an explicit TTL. Only [`Resources::new`] and tests call this; the
    /// production lifetime is the contract constant, not a per-caller choice.
    fn with_ttl(ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Table::default())),
            ttl,
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Table> {
        self.inner.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Drop expired handles. Called before every decision that touches capacity,
    /// so a table full of stale entries never refuses a legitimate open.
    fn sweep(table: &mut Table, now: Instant) {
        table.entries.retain(|_, entry| entry.deadline > now);
    }

    /// Wall-clock milliseconds, for the DTO's `expiresMs` only. The expiry check
    /// itself is monotonic ([`Instant`]) so a system clock change cannot extend or
    /// cut a live preview.
    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

impl FsResourceApi for Resources {
    /// Bind a handle to one existing regular file.
    ///
    /// The path is validated here and nowhere else in this channel: a directory
    /// gets `invalid argument`, a missing file gets `not found`, and later reads
    /// never accept a path again.
    fn open(&self, req: &ResourceIn) -> Result<ResourceOut, CapabilityError> {
        let path = req.path.trim();
        if path.is_empty() {
            return Err(CapabilityError::InvalidArgument(
                "invalid argument: path 为空".to_owned(),
            ));
        }
        let meta = std::fs::metadata(path).map_err(CapabilityError::from_io)?;
        if meta.is_dir() {
            return Err(CapabilityError::InvalidArgument(format!(
                "not a regular file: {path}"
            )));
        }
        let byte_length = meta.len();
        let extension = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_lowercase())
            .unwrap_or_default();
        let mime = kind_of_extension(&extension).1.map(str::to_owned);

        let mut table = self.lock();
        Self::sweep(&mut table, Instant::now());
        if table.entries.len() >= MAX_LIVE_RESOURCES {
            return Err(CapabilityError::InvalidArgument(format!(
                "too many open previews: at most {MAX_LIVE_RESOURCES} resources may be live"
            )));
        }
        table.next_id += 1;
        let id = format!("res-{:x}-{:x}", table.next_id, Self::now_ms());
        let deadline = Instant::now() + self.ttl;
        table.entries.insert(
            id.clone(),
            Entry {
                path: path.to_owned(),
                byte_length,
                deadline,
                id: id.clone(),
            },
        );
        Ok(ResourceOut {
            handle: id,
            path: path.to_owned(),
            byte_length,
            mime,
            expires_ms: Self::now_ms() + u64::try_from(self.ttl.as_millis()).unwrap_or(u64::MAX),
        })
    }

    /// Read one bounded slice through a live handle.
    ///
    /// An unknown or expired handle is an **error, never an empty answer**: a
    /// viewer that silently receives zero bytes would show a blank preview and no
    /// reason, which is the failure mode this channel exists to avoid.
    fn read(&self, req: &ReadResourceIn) -> Result<ReadResourceOut, CapabilityError> {
        let (path, bound_total) = {
            let mut table = self.lock();
            let now = Instant::now();
            match table.entries.get_mut(&req.handle) {
                None => {
                    Self::sweep(&mut table, now);
                    return Err(CapabilityError::NotFound(format!(
                        "not found: unknown or expired resource handle {}",
                        req.handle
                    )));
                }
                Some(entry) if entry.deadline <= now => {
                    let id = entry.id.clone();
                    table.entries.remove(&id);
                    return Err(CapabilityError::NotFound(format!(
                        "not found: resource handle {id} has expired"
                    )));
                }
                Some(entry) => {
                    entry.deadline = now + self.ttl;
                    (entry.path.clone(), entry.byte_length)
                }
            }
        };

        let offset = req.offset;
        let length = clamp_length(req.length, offset, bound_total);
        let data = read_slice(&path, offset, length)?;

        // A short read past the bound size means the file moved underneath the
        // handle (truncated, rewritten). Report the size that is true *now* rather
        // than the one captured at open time, and rebind the handle to it so the
        // next clamp is correct too.
        let mut total = bound_total;
        if offset + (data.len() as u64) < bound_total {
            if let Ok(meta) = std::fs::metadata(&path) {
                total = meta.len();
            }
        }

        let mut table = self.lock();
        if let Some(entry) = table.entries.get_mut(&req.handle) {
            entry.deadline = Instant::now() + self.ttl;
            entry.byte_length = total;
        }

        Ok(ReadResourceOut {
            handle: req.handle.clone(),
            offset,
            data: base64::engine::general_purpose::STANDARD.encode(&data),
            total,
            eof: offset + data.len() as u64 >= total,
            request_token: req.request_token.clone(),
        })
    }

    /// Revoke a handle. `false` for an unknown id — closing twice is a normal race
    /// between a re-render and an unmount, not a failure to report.
    fn close(&self, handle: &str) -> Result<bool, CapabilityError> {
        let mut table = self.lock();
        Ok(table.entries.remove(handle).is_some())
    }
}

/// The bytes a bounded ranged read may return: never more than the chunk ceiling,
/// and never past the end of what the handle was bound to.
fn clamp_length(requested: u64, offset: u64, total: u64) -> usize {
    let remaining = total.saturating_sub(offset);
    usize::try_from(requested.min(remaining).min(MAX_RESOURCE_CHUNK_BYTES))
        .unwrap_or(MAX_RESOURCE_CHUNK_BYTES as usize)
}

/// Read `length` bytes starting at `offset`. `length` is already clamped, so this
/// allocates at most one chunk.
fn read_slice(path: &str, offset: u64, length: usize) -> Result<Vec<u8>, CapabilityError> {
    if length == 0 {
        return Ok(Vec::new());
    }
    let mut file = std::fs::File::open(path).map_err(CapabilityError::from_io)?;
    file.seek(std::io::SeekFrom::Start(offset))
        .map_err(CapabilityError::from_io)?;
    let mut buf = vec![0u8; length];
    let mut filled = 0;
    while filled < length {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {}
            Err(err) => return Err(CapabilityError::from_io(err)),
        }
    }
    buf.truncate(filled);
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn written(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let path = dir.join(name);
        std::fs::write(&path, bytes).expect("fixture writable");
        path.to_string_lossy().to_string()
    }

    fn open(resources: &Resources, path: &str) -> ResourceOut {
        resources
            .open(&ResourceIn {
                path: path.to_owned(),
            })
            .expect("opens")
    }

    fn read(resources: &Resources, handle: &str, offset: u64, length: u64) -> ReadResourceOut {
        resources
            .read(&ReadResourceIn {
                handle: handle.to_owned(),
                offset,
                length,
                request_token: None,
            })
            .expect("reads")
    }

    #[test]
    fn a_handle_binds_one_existing_regular_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let resources = Resources::new();
        let path = written(dir.path(), "note.txt", b"hello");

        let out = open(&resources, &path);
        assert_eq!(out.path, path, "the handle echoes what it is bound to");
        assert_eq!(out.byte_length, 5);
        assert_eq!(out.mime.as_deref(), Some("text/plain"));
        assert!(
            out.expires_ms > Resources::now_ms(),
            "the deadline is in the future"
        );
        assert!(
            !out.handle.contains("note.txt") && !out.handle.contains('\\'),
            "a handle is an opaque token, never a path"
        );

        let missing = resources.open(&ResourceIn {
            path: dir.path().join("gone.txt").to_string_lossy().to_string(),
        });
        let err = missing.expect_err("a vanished row must not open");
        assert!(
            err.to_string().starts_with("not found:"),
            "wire contract: {err}"
        );

        let directory = resources.open(&ResourceIn {
            path: dir.path().to_string_lossy().to_string(),
        });
        let err = directory.expect_err("a folder is not previewable bytes");
        assert!(
            err.to_string().starts_with("invalid argument:"),
            "wire contract: {err}"
        );

        let blank = resources
            .open(&ResourceIn {
                path: "   ".to_owned(),
            })
            .expect_err("nothing to bind");
        assert!(
            blank.to_string().starts_with("invalid argument:"),
            "wire contract: {blank}"
        );
    }

    #[test]
    fn reads_are_bounded_and_walk_to_the_end() {
        let dir = tempfile::tempdir().expect("tempdir");
        let blob: Vec<u8> = (0..MAX_RESOURCE_CHUNK_BYTES + 1024)
            .map(|i| (i % 251) as u8)
            .collect();
        let path = written(dir.path(), "big.bin", &blob);
        let resources = Resources::new();
        let out = open(&resources, &path);

        // A request far above the ceiling is clamped, not rejected and not honoured.
        let first = read(&resources, &out.handle, 0, 1024 * 1024 * 1024);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&first.data)
            .expect("base64");
        assert_eq!(bytes.len() as u64, MAX_RESOURCE_CHUNK_BYTES);
        assert!(!first.eof, "the file is longer than one chunk");
        assert_eq!(first.total, blob.len() as u64);
        assert_eq!(bytes, blob[..MAX_RESOURCE_CHUNK_BYTES as usize]);

        let second = read(&resources, &out.handle, MAX_RESOURCE_CHUNK_BYTES, u64::MAX);
        let tail = base64::engine::general_purpose::STANDARD
            .decode(&second.data)
            .expect("base64");
        assert_eq!(second.offset, MAX_RESOURCE_CHUNK_BYTES);
        assert!(second.eof, "the last chunk says so");
        assert_eq!(tail.len(), blob.len() - MAX_RESOURCE_CHUNK_BYTES as usize);
        assert_eq!(tail, &blob[MAX_RESOURCE_CHUNK_BYTES as usize..]);

        // Past the end: an empty answer that still reports eof, never an error.
        let beyond = read(&resources, &out.handle, blob.len() as u64 + 4096, 1024);
        assert!(beyond.eof);
        assert!(beyond.data.is_empty());
    }

    #[test]
    fn a_dead_handle_is_an_error_never_blank_bytes() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = written(dir.path(), "a.txt", b"abc");
        let resources = Resources::with_ttl(Duration::from_millis(20));
        let out = open(&resources, &path);

        std::thread::sleep(Duration::from_millis(60));
        let err = resources
            .read(&ReadResourceIn {
                handle: out.handle.clone(),
                offset: 0,
                length: 8,
                request_token: None,
            })
            .expect_err("expiry must be visible");
        assert!(
            err.to_string().starts_with("not found:"),
            "wire contract: {err}"
        );

        let unknown = resources
            .read(&ReadResourceIn {
                handle: "res-nope".to_owned(),
                offset: 0,
                length: 8,
                request_token: None,
            })
            .expect_err("an invented handle is not a preview");
        assert!(unknown.to_string().starts_with("not found:"));
    }

    #[test]
    fn closing_revokes_and_a_full_table_refuses() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = written(dir.path(), "a.txt", b"abc");
        let resources = Resources::new();

        let out = open(&resources, &path);
        assert!(resources.close(&out.handle).expect("close answers"));
        assert!(
            !resources.close(&out.handle).expect("a double close"),
            "closing twice is a race, not a failure"
        );
        assert!(
            resources
                .read(&ReadResourceIn {
                    handle: out.handle.clone(),
                    offset: 0,
                    length: 8,
                    request_token: None,
                })
                .is_err(),
            "a closed handle reads nothing"
        );

        for _ in 0..MAX_LIVE_RESOURCES {
            open(&resources, &path);
        }
        let err = resources
            .open(&ResourceIn { path: path.clone() })
            .expect_err("the table is capped");
        assert!(
            err.to_string().starts_with("invalid argument:"),
            "wire contract: {err}"
        );
    }

    #[test]
    fn an_active_preview_is_not_expired_by_its_own_reading() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = written(dir.path(), "a.txt", b"abcdef");
        let resources = Resources::with_ttl(Duration::from_millis(80));
        let out = open(&resources, &path);

        for _ in 0..4 {
            std::thread::sleep(Duration::from_millis(30));
            let read = resources
                .read(&ReadResourceIn {
                    handle: out.handle.clone(),
                    offset: 0,
                    length: 3,
                    request_token: Some("tok".to_owned()),
                })
                .expect("a viewed handle stays alive");
            assert_eq!(
                read.request_token.as_deref(),
                Some("tok"),
                "the token travels back so a viewer can drop stale answers"
            );
        }
        assert_eq!(open(&resources, &path).byte_length, 6);
    }

    #[test]
    fn mime_comes_from_the_frozen_kind_table() {
        let dir = tempfile::tempdir().expect("tempdir");
        let resources = Resources::new();
        for (name, expected) in [
            ("p.png", Some("image/png")),
            ("d.pdf", Some("application/pdf")),
            ("s.svg", Some("image/svg+xml")),
            ("x.unknownext", None),
            ("noextension", None),
        ] {
            let path = written(dir.path(), name, b"x");
            assert_eq!(open(&resources, &path).mime.as_deref(), expected, "{name}");
        }
    }
}
