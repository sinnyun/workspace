//! Atomic capability contracts: `fs`, `hash`, `thumb`, `db`.
//!
//! Each capability is a **synchronous** API trait (no business logic — red line
//! 3) plus a cordis [`Service`] marker the host publishes via DI. A backend
//! plugin resolves one with `ctx.try_service::<FsCapability>()` and calls it
//! in-process (not over IPC). Because the methods are sync, a plugin `apply`
//! poll or a Tauri command wraps the call in `tokio::task::spawn_blocking`.
//!
//! The host provides the concrete implementations (tokio fs / blake3 / rusqlite
//! — see docs/06-open-source-stack.md); `contracts` only fixes the shapes so
//! plugins never depend on the host.

use std::sync::Arc;

use cordis_core::Service;
use serde::{Deserialize, Serialize};

/// The `domain.action` capability names the host routes in `invoke_capability`.
/// Single Rust source of truth; the SDK's `Capabilities` const and the contract
/// test (P3-3) mirror these exactly.
pub mod names {
    pub const FS_HOME: &str = "fs.home";
    pub const FS_LIST: &str = "fs.list";
    pub const FS_STAT: &str = "fs.stat";
    pub const FS_READ_CHUNK: &str = "fs.readChunk";
    pub const FS_READ_TEXT: &str = "fs.readText";
    pub const HASH_COMPUTE: &str = "hash.compute";
    pub const THUMB_IMAGE: &str = "thumb.image";
    pub const WATCH_SUBSCRIBE: &str = "watch.subscribe";
    /// Prefix for the dynamic per-store db capabilities (`db.<store>.<op>`).
    pub const DB_PREFIX: &str = "db.";
}

/// Errors any atomic capability may return. Deliberately small and owned here
/// so plugins match on a stable, host-independent type.
#[derive(Debug, thiserror::Error)]
pub enum CapabilityError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("permission denied: {0}")]
    PermissionDenied(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("io error: {0}")]
    Io(String),
}

impl CapabilityError {
    /// Convenience for mapping a [`std::io::Error`] (used by host impls).
    pub fn from_io(err: std::io::Error) -> Self {
        match err.kind() {
            std::io::ErrorKind::NotFound => CapabilityError::NotFound(err.to_string()),
            std::io::ErrorKind::PermissionDenied => {
                CapabilityError::PermissionDenied(err.to_string())
            }
            std::io::ErrorKind::InvalidInput => CapabilityError::InvalidArgument(err.to_string()),
            _ => CapabilityError::Io(err.to_string()),
        }
    }
}

// ───────────────────────────── fs ─────────────────────────────

/// One directory entry returned by [`FsApi::list`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// Size in bytes; `None` for directories.
    pub size: Option<u64>,
    /// Unix epoch millis of last modification; `None` for directories and
    /// whenever the provider cannot read an mtime (a platform without mtimes,
    /// or a metadata lookup that failed). Lists carry it so a browser can show
    /// a column without one `fs.stat` per row.
    pub modified_ms: Option<i64>,
}

/// Metadata returned by [`FsApi::stat`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatOut {
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Unix epoch millis; `None` if the platform gives no mtime.
    pub modified_ms: Option<i64>,
}

/// A byte slice read from a file at an offset.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadChunkOut {
    pub path: String,
    pub offset: u64,
    pub data: Vec<u8>,
    /// Total file size at read time.
    pub total: u64,
}

/// Atomic filesystem operations. Sync; wrap in `spawn_blocking` at call sites.
pub trait FsApi: Send + Sync + 'static {
    /// List one directory (non-recursive).
    fn list(&self, dir: &str) -> Result<Vec<ListEntry>, CapabilityError>;
    /// Stat one path.
    fn stat(&self, path: &str) -> Result<StatOut, CapabilityError>;
    /// Read `len` bytes starting at `offset`.
    fn read_chunk(&self, path: &str, offset: u64, len: u64)
        -> Result<ReadChunkOut, CapabilityError>;
    /// Read a whole text file (bounded by callers to reasonable sizes).
    fn read_text(&self, path: &str) -> Result<String, CapabilityError>;
}

/// cordis `Service` marker for the `fs` capability.
pub struct FsCapability {
    api: Arc<dyn FsApi>,
}

impl FsCapability {
    pub fn new(api: Arc<dyn FsApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn FsApi> {
        &self.api
    }
}

impl Service for FsCapability {
    const NAME: &'static str = "capability.fs";
}

// ───────────────────────────── hash ─────────────────────────────

/// Supported hash algorithms (kept minimal; extend only when needed).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HashAlgo {
    Blake3,
    Sha256,
}

/// Atomic hashing. Implementations stream large files in chunks (R7).
pub trait HashApi: Send + Sync + 'static {
    /// Hash the file at `path`, streaming. Returns lowercase hex.
    fn file(&self, path: &str, algo: HashAlgo) -> Result<String, CapabilityError>;
    /// Hash an in-memory buffer. Returns lowercase hex.
    fn bytes(&self, data: &[u8], algo: HashAlgo) -> String;
}

/// cordis `Service` marker for the `hash` capability.
pub struct HashCapability {
    api: Arc<dyn HashApi>,
}

impl HashCapability {
    pub fn new(api: Arc<dyn HashApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn HashApi> {
        &self.api
    }
}

impl Service for HashCapability {
    const NAME: &'static str = "capability.hash";
}

// ───────────────────────────── thumb ─────────────────────────────

/// A decoded + downscaled image, ready for an `<img>` `src`.
///
/// The payload is a `data:` URL rather than raw bytes because the browser
/// plugin has no way to turn `Vec<u8>` into an image without a Blob/base64 step
/// of its own — so the host does it once. That keeps thumbnails behind the same
/// permission gate as every other capability (no `file://`/asset-protocol URL
/// reaching past `permissions.capabilities`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbOut {
    /// `data:<mime>;base64,<png>` of the downscaled image.
    pub data_url: String,
    pub mime: String,
    /// Longest edge actually produced, in pixels (<= the requested one).
    pub edge: u32,
}

/// Image thumbnails. Deliberately **not** part of `fs`: a directory listing must
/// stay cheap, so decoding is opt-in per visible row and gated per plugin.
pub trait ThumbApi: Send + Sync + 'static {
    /// Decode the image at `path` and return it downscaled so its longest edge
    /// is at most `edge` pixels. `InvalidArgument` for a non-image extension;
    /// `Io` when the file cannot be read or decoded.
    fn image(&self, path: &str, edge: u32) -> Result<ThumbOut, CapabilityError>;
}

/// cordis `Service` marker for the `thumb` capability.
pub struct ThumbCapability {
    api: Arc<dyn ThumbApi>,
}

impl ThumbCapability {
    pub fn new(api: Arc<dyn ThumbApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn ThumbApi> {
        &self.api
    }
}

impl Service for ThumbCapability {
    const NAME: &'static str = "capability.thumb";
}

// ───────────────────────────── db ─────────────────────────────

/// Atomic per-store key/value + JSON-row storage. Each logical `store` is an
/// isolated partition (R6); the host backs it with sqlite in WAL mode.
///
/// Values are opaque JSON so `contracts` stays schema-free; a plugin owns the
/// meaning of the rows in its own store.
pub trait DbApi: Send + Sync + 'static {
    /// Store a JSON value under `key` in `store`.
    fn put(&self, store: &str, key: &str, value: &serde_json::Value)
        -> Result<(), CapabilityError>;
    /// Fetch the JSON value at `key`, or `None`.
    fn get(&self, store: &str, key: &str) -> Result<Option<serde_json::Value>, CapabilityError>;
    /// List `(key, value)` rows in `store`, ordered by key.
    fn list(&self, store: &str) -> Result<Vec<(String, serde_json::Value)>, CapabilityError>;
    /// Append a JSON row to an ordered log under `key` in `store`.
    fn append(&self, store: &str, key: &str, value: &serde_json::Value)
        -> Result<(), CapabilityError>;
    /// Read the ordered log at `key` (oldest first).
    fn read_log(&self, store: &str, key: &str)
        -> Result<Vec<serde_json::Value>, CapabilityError>;
    /// Delete `key` from `store`.
    fn delete(&self, store: &str, key: &str) -> Result<(), CapabilityError>;
}

/// cordis `Service` marker for the `db` capability.
pub struct DbCapability {
    api: Arc<dyn DbApi>,
}

impl DbCapability {
    pub fn new(api: Arc<dyn DbApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn DbApi> {
        &self.api
    }
}

impl Service for DbCapability {
    const NAME: &'static str = "capability.db";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn keys<T: Serialize>(v: &T) -> Vec<String> {
        match serde_json::to_value(v).unwrap() {
            Value::Object(map) => {
                let mut ks: Vec<String> = map.keys().cloned().collect();
                ks.sort();
                ks
            }
            other => panic!("expected an object, got {other}"),
        }
    }

    /// The wire field names are the contract (`fm-contract-dump` publishes them,
    /// the TS SDK mirrors them). An `Option` must stay present as `null` — adding
    /// `skip_serializing_if` here would silently widen the TS interface.
    #[test]
    fn dto_field_names_are_camel_case_and_complete() {
        assert_eq!(
            keys(&ListEntry {
                name: String::new(),
                path: String::new(),
                is_dir: false,
                size: None,
                modified_ms: None,
            }),
            vec!["isDir", "modifiedMs", "name", "path", "size"]
        );
        assert_eq!(
            keys(&StatOut {
                path: String::new(),
                is_dir: false,
                size: 0,
                modified_ms: None,
            }),
            vec!["isDir", "modifiedMs", "path", "size"]
        );
        assert_eq!(
            keys(&ThumbOut {
                data_url: String::new(),
                mime: String::new(),
                edge: 0,
            }),
            vec!["dataUrl", "edge", "mime"]
        );
        assert_eq!(
            serde_json::to_value(HashAlgo::Blake3).unwrap(),
            json!("blake3")
        );
    }

    #[test]
    fn list_entry_round_trips_optional_metadata() {
        let entry = ListEntry {
            name: "a.txt".into(),
            path: "/tmp/a.txt".into(),
            is_dir: false,
            size: Some(12),
            modified_ms: Some(1_700_000_000_000),
        };
        let back: ListEntry = serde_json::from_str(&serde_json::to_string(&entry).unwrap()).unwrap();
        assert_eq!(entry, back);

        let dir = ListEntry {
            name: "sub".into(),
            path: "/tmp/sub".into(),
            is_dir: true,
            size: None,
            modified_ms: None,
        };
        assert_eq!(
            serde_json::to_value(&dir).unwrap()["modifiedMs"],
            Value::Null
        );
    }
}
