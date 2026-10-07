//! Atomic capability contracts: `fs`, `hash`, `db`.
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
