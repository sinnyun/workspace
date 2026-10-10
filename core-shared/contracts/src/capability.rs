//! Atomic capability contracts: `fs`, `hash`, `shell`, `db`.
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
    /// Preview resource channel (roadmap P7-20): open a read-only, path-bound,
    /// short-lived handle, read bounded slices through it, revoke it.
    pub const FS_OPEN_RESOURCE: &str = "fs.openResource";
    pub const FS_READ_RESOURCE: &str = "fs.readResource";
    pub const FS_CLOSE_RESOURCE: &str = "fs.closeResource";
    pub const HASH_COMPUTE: &str = "hash.compute";
    /// Windows Shell system thumbnails (docs/plugin-functional/
    /// plugin-windows-thumbnails.md). Replaces the old `thumb.image`, which
    /// decoded and downscaled images in the app — the app never generates
    /// thumbnails, it only asks the Shell for the system's own.
    pub const SHELL_THUMBNAIL_READ: &str = "shell.thumbnail.read";
    /// Start a bulk Shell file operation (`IFileOperation`): copy / move / rename
    /// / create / delete. Returns an ack; the truth arrives as events.
    pub const SHELL_FILE_OPERATION: &str = "shell.fileOperation";
    /// Ask a running Shell file operation to stop (best effort).
    pub const SHELL_CANCEL_FILE_OPERATION: &str = "shell.cancelFileOperation";
    /// Open a path with its system default handler.
    pub const SHELL_OPEN_PATH: &str = "shell.openPath";
    /// Show a path in the system file manager.
    pub const SHELL_REVEAL_ITEM: &str = "shell.revealItemInDir";
    /// Native file open dialog.
    pub const SHELL_PICK_FILE: &str = "shell.pickFile";
    /// Native folder open dialog.
    pub const SHELL_PICK_DIRECTORY: &str = "shell.pickDirectory";
    /// Classify a path into one stable [`FileKind`].
    pub const FILE_KIND: &str = "file.kind";
    pub const WATCH_SUBSCRIBE: &str = "watch.subscribe";
    /// Volume space metadata (`sys.disk.list`).
    pub const SYS_DISK_LIST: &str = "sys.disk.list";
    /// Start a cancellable recursive size scan (`sys.scan.start`).
    pub const SYS_SCAN_START: &str = "sys.scan.start";
    /// Ask a live scan to stop (`sys.scan.cancel`).
    pub const SYS_SCAN_CANCEL: &str = "sys.scan.cancel";
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
    /// Read a file as text, decoding it (see [`ReadTextOut`]). Never returns the
    /// raw bytes of a binary file pretending to be text.
    fn read_text(&self, path: &str) -> Result<ReadTextOut, CapabilityError>;
}

/// Why a text read is not simply "the file's contents".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TextReadState {
    /// Decoded text is in `text`.
    Ok,
    /// Bigger than [`MAX_TEXT_READ_BYTES`]: refused rather than shipped whole
    /// into the WebView. A caller that needs more uses `fs.readChunk`.
    TooLarge,
    /// Not text at all (a bitmap, an archive, a compiled binary). Reported as a
    /// state, not an error, because the UI has a normal thing to say about it.
    Binary,
}

/// `fs.readText` answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadTextOut {
    pub path: String,
    pub state: TextReadState,
    /// The decoded body; `None` unless `state` is [`TextReadState::Ok`].
    pub text: Option<String>,
    /// The encoding actually used, normalised to an `encoding_rs` name
    /// (`UTF-8`, `GBK`, `windows-1252`, `UTF-16LE`, …). `None` with no text.
    pub encoding: Option<String>,
    /// Size of the file on disk at read time.
    pub byte_length: u64,
}

// ───────────────────────── preview resource channel (P7-20) ─────────────────────────

/// The largest slice one `fs.readResource` answer carries. A viewer assembles a
/// preview from repeated ranged reads, so this bounds one IPC message rather than
/// the whole file — which is the point: nothing here ships a large file to the
/// WebView in one go, and nothing hands the WebView a bare `file:` path.
pub const MAX_RESOURCE_CHUNK_BYTES: u64 = 512 * 1024;

/// How long an untouched handle stays valid. Expiry is the backstop for a
/// consumer that vanished without calling `fs.closeResource` (a reloaded
/// WebView, a disabled plugin); the normal path is still an explicit close.
pub const RESOURCE_TTL_MS: u64 = 5 * 60 * 1000;

/// The largest file the preview channel will assemble for a viewer. Chunking
/// bounds one *message*; this bounds the whole preview, because a viewer needs
/// the bytes contiguous in the WebView to work at all. Past it the panel says
/// 文件过大 rather than paging a 2 GB archive into memory — one shared ceiling,
/// same reasoning as [`MAX_TEXT_READ_BYTES`] (roadmap P7-21/22).
pub const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;

/// `fs.openResource` input: exactly one path, bound at open time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceIn {
    pub path: String,
}

/// `fs.openResource` answer. `handle` is an opaque token — it is not a URL, not
/// a path, and useless to anyone who did not just ask for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceOut {
    pub handle: String,
    /// The bound path, echoed so the UI can label the resource it holds.
    pub path: String,
    /// File size captured at open time; ranged reads are clamped to it.
    pub byte_length: u64,
    /// Extension-derived MIME type (`image/png`, `application/pdf`, …), `None`
    /// when nothing can be said for the extension.
    pub mime: Option<String>,
    /// Wall-clock deadline after which the handle is refused.
    pub expires_ms: u64,
}

/// `fs.readResource` input. `length` is clamped to
/// [`MAX_RESOURCE_CHUNK_BYTES`] rather than rejected: a viewer asking for more
/// gets the next chunk boundary, not an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResourceIn {
    pub handle: String,
    pub offset: u64,
    pub length: u64,
    /// Dropped as soon as a newer request for the same handle exists — the
    /// channel has no interruptible read at the OS level, so cancellation is
    /// expressed by the consumer no longer accepting the answer.
    #[serde(default)]
    pub request_token: Option<String>,
}

/// `fs.readResource` answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadResourceOut {
    pub handle: String,
    pub offset: u64,
    /// Standard-alphabet base64 of the slice — the same transport the thumbnail
    /// channel already uses. One bounded chunk per message, never a whole file
    /// (roadmap P7-20 forbids full-file base64, and `Vec<u8>` would serialise as
    /// a JSON array of numbers, which is *larger* than base64).
    pub data: String,
    /// Size of the file behind this handle.
    pub total: u64,
    /// `offset + decoded_len(data) >= total`.
    pub eof: bool,
    #[serde(default)]
    pub request_token: Option<String>,
}

/// The read-only, path-bound, short-lived preview channel.
///
/// Deliberately a *separate* service from [`FsApi`]: adding these methods to
/// `FsApi` would make every existing filesystem consumer carry preview
/// semantics, and the resource table needs its own lifetime rules.
pub trait FsResourceApi: Send + Sync + 'static {
    /// Bind a handle to one existing regular file. `InvalidArgument` for a
    /// directory or a path that does not exist; `NotFound` when it is gone.
    fn open(&self, req: &ResourceIn) -> Result<ResourceOut, CapabilityError>;
    /// Read one bounded slice through a live handle. An unknown, expired or
    /// closed handle is an error, never an empty answer.
    fn read(&self, req: &ReadResourceIn) -> Result<ReadResourceOut, CapabilityError>;
    /// Revoke a handle. `false` for an unknown or already-revoked id — closing
    /// twice is a normal race, not a failure.
    fn close(&self, handle: &str) -> Result<bool, CapabilityError>;
}

/// cordis `Service` marker for the preview resource channel.
pub struct FsResourceCapability {
    api: Arc<dyn FsResourceApi>,
}

impl FsResourceCapability {
    pub fn new(api: Arc<dyn FsResourceApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn FsResourceApi> {
        &self.api
    }
}

impl Service for FsResourceCapability {
    const NAME: &'static str = "capability.fsResource";
}

/// Largest body `fs.readText` will return. Deliberately a contract constant, not
/// a per-plugin option: one shared ceiling is what makes "超限" mean the same
/// thing in every panel (roadmap P7-19).
pub const MAX_TEXT_READ_BYTES: u64 = 4 * 1024 * 1024;

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

// ─────────────────────── shell.thumbnail ───────────────────────

/// How hard the provider may try when the system has no cached thumbnail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ThumbnailPolicy {
    /// `WTS_INCACHEONLY`: only return what Windows already cached. A miss is a
    /// normal, presentable outcome — nothing gets extracted.
    CacheOnly,
    /// Let the Shell run the registered thumbnail handler on a miss, which is
    /// also what writes the system cache. Default.
    #[default]
    Extract,
}

/// What happened, as a stable category the UI can map to Chinese text. This is
/// carried in the **value**, not in an error, because a cache miss or an
/// unsupported file type is a normal answer rather than a failure of the call.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ThumbnailState {
    /// A system thumbnail came back; `data_url` is set.
    Ready,
    /// Cache-only policy and nothing cached (or the Shell reported no cache).
    CacheMiss,
    /// No Windows Shell on this platform — the app shows type icons.
    UnsupportedPlatform,
    /// No registered handler produces a thumbnail for this file.
    UnsupportedType,
    /// The account cannot read the file.
    Denied,
    /// The file is gone.
    Missing,
    /// Extraction ran out of its time budget.
    Timeout,
    /// The consumer cancelled (scrolled away, directory changed, plugin off).
    Cancelled,
    /// Anything else the Shell reported.
    Error,
}

/// A Windows Shell thumbnail, already an `<img>`-ready `data:` URL.
///
/// The image bytes come from the Shell (its cache or its registered handler);
/// the app never decodes the original file, draws, or downscales it. Encoding
/// the Shell-provided bitmap as PNG is serialisation for transport only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellThumbnailOut {
    pub state: ThumbnailState,
    /// `data:image/png;base64,<png>` when [`ThumbnailState::Ready`], else `None`.
    pub data_url: Option<String>,
    pub mime: Option<String>,
    /// Longest edge actually returned, in pixels (0 when there is no image).
    pub edge: u32,
    /// Whether the answer came straight from the system cache.
    pub from_cache: bool,
}

/// Platform shell thumbnails. Sync; the host runs it on a dedicated STA thread
/// because `IThumbnailCache` is COM (docs/plugin-functional/
/// plugin-windows-thumbnails.md).
pub trait ShellThumbnailApi: Send + Sync + 'static {
    /// Ask the Shell for the thumbnail of `path` at longest edge `edge`.
    ///
    /// `InvalidArgument` when `edge` is out of `1..=MAX_EDGE` or `path` is
    /// blank; every other outcome — including a miss — arrives as a
    /// [`ShellThumbnailOut`] state.
    fn read(
        &self,
        path: &str,
        edge: u32,
        policy: ThumbnailPolicy,
    ) -> Result<ShellThumbnailOut, CapabilityError>;
}

/// cordis `Service` marker for the shell thumbnail capability.
pub struct ShellThumbnailCapability {
    api: Arc<dyn ShellThumbnailApi>,
}

impl ShellThumbnailCapability {
    pub fn new(api: Arc<dyn ShellThumbnailApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn ShellThumbnailApi> {
        &self.api
    }
}

impl Service for ShellThumbnailCapability {
    const NAME: &'static str = "capability.shellThumbnail";
}

/// Longest edge a caller may ask for. A grid card needs ~128px, so 512 already
/// covers retina; the cap bounds both Shell work and payload size.
pub const MAX_THUMBNAIL_EDGE: u32 = 512;

// ─────────────────────── shell file operations ───────────────────────
//
// The red line these types exist to hold (docs/plugin-functional/
// plugin-file-ops.md, roadmap P7-16/P7-17): the app never implements copy, move,
// rename or delete itself — `IFileOperation` does, including recycle-bin
// semantics, cross-volume moves and collision handling. These DTOs are only the
// *question* we ask the Shell and the *answer* it gives back.

/// What the Shell is asked to do with the selected items.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileOperationKind {
    /// Copy `sources` into `destination`.
    Copy,
    /// Move `sources` into `destination` (the Shell may copy+delete across volumes).
    Move,
    /// Rename one source to `new_name` in place.
    Rename,
    /// Create `new_name` (a directory) inside `destination`, or an empty file.
    Create,
    /// Delete `sources` — into the recycle bin unless `to_recycle_bin` is false.
    Delete,
}

/// How a name collision is resolved. The UI confirms *before* starting
/// (`awaiting-confirmation`, P7-18); this is what the Shell is told to do with
/// whatever still collides when it runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileConflictPolicy {
    /// Report the item as `exists` and change nothing. The conservative default:
    /// nothing the user has not explicitly agreed to is ever overwritten.
    #[default]
    Fail,
    /// Let the Shell auto-rename (`… - 副本`), so both copies survive.
    Rename,
    /// Replace the existing target. Only after the UI has confirmed it.
    Overwrite,
}

/// Where an operation has got to. `queued`/`running`/`cancelling` are transient;
/// the last four are terminal and only then is [`FileOperationResult`] emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileOperationState {
    Queued,
    Running,
    Cancelling,
    Completed,
    /// Some items succeeded, some did not — the UI must list the failures.
    PartialFailure,
    Failed,
    Cancelled,
}

/// Per-item verdict. `Renamed` is distinct from `Completed` because the actual
/// landing path differs from the one the user asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileItemOutcome {
    Completed,
    Renamed,
    Skipped,
    Failed,
    Cancelled,
}

/// Stable reason categories for anything that did not complete, so the UI maps
/// them to Chinese text instead of parsing Shell strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileFailureReason {
    NotFound,
    Denied,
    Exists,
    ReadOnly,
    DiskFull,
    /// The Shell itself cancelled (UAC declined, surrogate died, …).
    CancelledByShell,
    /// This platform has no Shell operation engine.
    Unsupported,
    Other,
}

/// `shell.fileOperation` input. The call starts the operation and returns
/// immediately — progress and the outcome arrive as events, because a bulk
/// Shell call can outlive any reasonable request timeout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationIn {
    pub op: FileOperationKind,
    /// Every selected source path. Rename/Create take exactly one.
    pub sources: Vec<String>,
    /// Target *directory* for Copy/Move. Absent for Rename/Create/Delete.
    #[serde(default)]
    pub destination: Option<String>,
    /// New name for Rename/Create (never a path).
    #[serde(default)]
    pub new_name: Option<String>,
    /// Delete goes to the recycle bin unless this is explicitly false (spec:
    /// 回收站默认). The Shell still honours the system "completely delete"
    /// policy, which is why this is a request, not a guarantee.
    #[serde(default = "default_recycle_bin")]
    pub to_recycle_bin: bool,
    #[serde(default)]
    pub conflict: FileConflictPolicy,
    /// Echoed into every progress/result event so a consumer can drop late
    /// answers from an operation it already stopped caring about.
    #[serde(default)]
    pub request_token: Option<String>,
}

fn default_recycle_bin() -> bool {
    true
}

/// `shell.fileOperation` ack: the operation is queued, nothing has happened yet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationOut {
    pub operation_id: String,
    pub state: FileOperationState,
    /// Items handed to the Shell.
    pub total: u32,
    /// Always `true` today, and stated rather than implied: `IFileOperation`
    /// reports no trustworthy percentage to us, so the UI shows indeterminate
    /// progress (or the Shell's own dialog) instead of a fabricated number.
    pub indeterminate: bool,
}

/// `shell:operation:progress` payload.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationProgress {
    pub operation_id: String,
    pub state: FileOperationState,
    #[serde(default)]
    pub request_token: Option<String>,
    /// Items the Shell has finished. Only meaningful when `indeterminate` is
    /// false — which the provider must not claim it can be.
    pub processed: u32,
    pub total: u32,
    pub indeterminate: bool,
    /// Display name of the item currently in flight, for a status line.
    #[serde(default)]
    pub current_name: Option<String>,
}

/// One item's verdict inside a terminal result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationItem {
    pub source: String,
    /// Where it actually landed (set for Copy/Move/Rename; the Shell's
    /// auto-rename can differ from the requested name).
    #[serde(default)]
    pub destination: Option<String>,
    pub outcome: FileItemOutcome,
    #[serde(default)]
    pub reason: Option<FileFailureReason>,
    /// The Shell's own message, kept for a details/reports affordance only —
    /// never used to decide behaviour.
    #[serde(default)]
    pub message: Option<String>,
}

/// `shell:operation:done` payload — the only place the truth about an operation
/// lands, and the reason the state machine has a `partial-failure` state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationResult {
    pub operation_id: String,
    pub state: FileOperationState,
    #[serde(default)]
    pub request_token: Option<String>,
    pub items: Vec<FileOperationItem>,
    /// A cross-volume Move was performed by the Shell as copy + delete. It
    /// succeeded, but the user is owed the distinction (P7-17: 须报告).
    pub cross_volume_move: bool,
}

/// `shell.pickFile` / `shell.pickDirectory` input.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickIn {
    #[serde(default)]
    pub title: Option<String>,
    /// Directory the dialog opens in (never a file).
    #[serde(default)]
    pub initial_dir: Option<String>,
    /// Extension filters; empty means "all files". Ignored by the directory picker.
    #[serde(default)]
    pub filters: Vec<PickFilter>,
    #[serde(default)]
    pub multiple: bool,
}

/// One named filter group in an open dialog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickFilter {
    pub description: String,
    /// Globs, e.g. `*.txt`.
    pub patterns: Vec<String>,
}

/// A picker answer: cancelled is a normal outcome, not an error.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickOut {
    /// Absolute paths; empty when `cancelled`.
    pub paths: Vec<String>,
    pub cancelled: bool,
}

/// Starts bulk Shell file operations and reports their outcome.
pub trait ShellFileOperationApi: Send + Sync + 'static {
    /// Queue `req` on the Shell engine. `InvalidArgument` for a request the UI
    /// should never have sent (no sources, Rename of several items, Move without
    /// a destination). Everything else — including "the Shell refused" — arrives
    /// through the result events.
    fn start(&self, req: &FileOperationIn) -> Result<FileOperationOut, CapabilityError>;
    /// Ask a running operation to stop. Best effort by construction: only items
    /// the Shell has not yet started can be stopped, and the terminal result
    /// reports which ones. Returns `false` for an unknown/finished id.
    fn cancel(&self, operation_id: &str) -> Result<bool, CapabilityError>;
}

/// cordis `Service` marker for the Shell file-operation capability.
pub struct ShellFileOperationCapability {
    api: Arc<dyn ShellFileOperationApi>,
}

impl ShellFileOperationCapability {
    pub fn new(api: Arc<dyn ShellFileOperationApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn ShellFileOperationApi> {
        &self.api
    }
}

impl Service for ShellFileOperationCapability {
    const NAME: &'static str = "capability.shellFileOperation";
}

// ───────────────────────────── file.kind ─────────────────────────────

/// What a path *is*, as one stable category the whole app branches on: icon
/// choice (P7-34), which previewer may be used (P7-21/22), and whether an action
/// even applies. Deliberately coarse — a per-extension registry would just move
/// the switchboard somewhere nobody tests.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FileKind {
    Directory,
    /// Plain prose/logs/config: decodable text with no code shape.
    Text,
    /// Source code and structured data (json, yaml, toml, …).
    Code,
    Markdown,
    Image,
    /// Vector graphics (`svg`): text on disk, an image on screen — kept separate
    /// because it must not be handed to a bitmap path.
    Vector,
    Video,
    /// Standalone audio, *or* a video container whose stream is audio (mp3/m4a).
    Audio,
    /// A video container the Shell may only iconise (mkv/avi).
    Container,
    Pdf,
    /// Archives and disk images that a previewer can list.
    Archive,
    /// Word / docx / odt.
    Document,
    /// Excel / xlsx / ods.
    Sheet,
    /// PowerPoint / pptx / odp.
    Presentation,
    Font,
    /// exe / dll / msi — never previewed, only revealed or opened with care.
    Executable,
    /// 3D model, CAD, or other specialist payload we can only iconise.
    Model,
    /// Anything else, including extensionless files.
    Unknown,
}

/// `file.kind` answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileKindOut {
    pub path: String,
    pub kind: FileKind,
    /// Lowercase extension without the dot; `""` when there is none.
    pub extension: String,
    /// Registered media type when one is known, else `None`.
    pub mime: Option<String>,
}

/// Path classification. `is_dir` comes from the caller's own stat: a browser
/// listing already knows it, and asking again would be a second syscall per row.
pub trait FileKindApi: Send + Sync + 'static {
    fn classify(&self, path: &str, is_dir: bool) -> Result<FileKindOut, CapabilityError>;
}

/// cordis `Service` marker for the type registry.
pub struct FileKindCapability {
    api: Arc<dyn FileKindApi>,
}

impl FileKindCapability {
    pub fn new(api: Arc<dyn FileKindApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn FileKindApi> {
        &self.api
    }
}

impl Service for FileKindCapability {
    const NAME: &'static str = "capability.fileKind";
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

// ─────────────────── disk / scan channel (P7-23) ───────────────────

/// How deep the delivered tree goes. Deeper directories still contribute their
/// bytes to the aggregate, but arrive as `childCount` instead of children — the
/// consumer draws a treemap, and 200 000 DOM/canvas nodes is neither readable
/// nor renderable. Mirrors `SCAN_TREE_DEPTH` (TS).
pub const SCAN_TREE_DEPTH: u32 = 2;

/// Entry ceiling for one scan. A mount holding tens of millions of files is not
/// something a UI panel can count to completion; when the ceiling is reached the
/// remaining directories are reported in `skipped` as `budget-exceeded` rather
/// than being silently treated as empty. Mirrors `SCAN_MAX_ENTRIES` (TS).
pub const SCAN_MAX_ENTRIES: u64 = 120_000;

/// Hard ceiling on recursion depth. Cycle protection is really "never follow a
/// symlink", but a depth bound also stops a pathological tree from eating the
/// work queue.
pub const SCAN_MAX_DEPTH: u32 = 128;

/// Minimum gap between two `scan:progress` emissions. Progress is proof of
/// life, not a per-directory firehose.
pub const SCAN_PROGRESS_INTERVAL_MS: u64 = 80;

/// `sys.disk.list` input. The path only selects which volume is *first* in the
/// answer; every volume the host can see is listed either way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskListIn {
    pub path: String,
}

/// One volume's space accounting. Bytes, never percentages: the panel has to be
/// able to say "总共 4.0 TB，可用 1.2 TB" without inventing a denominator.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskVolume {
    /// Mount point / root path as the platform names it (`C:\\`, `/data`).
    pub root_path: String,
    /// Volume label, empty when the platform has none.
    pub label: String,
    /// Filesystem name (`NTFS`, `ext4`, …), `unknown` when unreadable.
    pub filesystem: String,
    pub total_bytes: u64,
    /// `total_bytes - free_bytes`, i.e. what this volume is actually holding.
    pub used_bytes: u64,
    pub free_bytes: u64,
}

/// `sys.disk.list` answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskListOut {
    /// Echoed back so a consumer can tell the answer belongs to its request.
    pub path: String,
    pub volumes: Vec<DiskVolume>,
}

/// `sys.scan.start` input.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanIn {
    pub root_path: String,
}

/// Where a scan is. `queued` is the answer to `sys.scan.start` itself: nothing
/// has been read yet, so the call cannot report an entry count.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScanState {
    Queued,
    Running,
    Completed,
    Cancelled,
    Failed,
}

/// `sys.scan.start` answer: an id and nothing else. The truth is in the events.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanAck {
    pub scan_id: String,
    pub state: ScanState,
    pub root_path: String,
}

/// Why a directory did not contribute to the aggregate. A **stable code**, not
/// prose: the base's rule is that the UI writes the Chinese sentence, so the
/// wire must not carry user-facing text the panel would have to re-translate
/// (same division as [`FileFailureReason`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScanSkipReason {
    NotFound,
    Denied,
    InvalidArgument,
    ReadFailed,
    /// The entry budget ran out; everything still queued carries this.
    BudgetExceeded,
    /// Too deep to be a real tree a person can read.
    TooDeep,
    /// A link to a directory: never followed, so a symlink cycle cannot make the
    /// scan loop and cannot double-count the same subtree.
    SymlinkSkipped,
    /// Not a directory at all (a file appeared in the work queue).
    NotADirectory,
}

/// One skipped path plus its reason code.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanSkipped {
    pub path: String,
    pub reason: ScanSkipReason,
}

/// One node of the delivered aggregate tree.
///
/// `bytes` is a **subtree total** for a directory and a file size for a file, so
/// a consumer can rank children of any level without a second pass. `kinds`
/// splits those bytes by lower-case extension (no dot) — that is what lets the
/// panel say "这一层里 .psd 占了 40 GB" without walking the tree again.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub bytes: u64,
    /// Present on a directory deeper than [`SCAN_TREE_DEPTH`]: the number of
    /// immediate children, which are *not* in this payload.
    #[serde(default)]
    pub child_count: Option<u64>,
    #[serde(default)]
    pub children: Option<Vec<ScanNode>>,
    #[serde(default)]
    pub kinds: Option<std::collections::HashMap<String, u64>>,
}

/// `scan:progress` payload — counters only, never a percentage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgress {
    pub scan_id: String,
    /// Directory currently being listed; a display hint, not a cursor.
    pub path: String,
    pub entries: u64,
    pub bytes: u64,
    pub skipped: Vec<ScanSkipped>,
    pub state: ScanState,
}

/// `scan:done` payload. Terminal, and the only place the full tree lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanDone {
    pub scan_id: String,
    pub tree: ScanNode,
    pub skipped: Vec<ScanSkipped>,
    /// `true` → the tree is **partial** and the consumer must not present it as
    /// a complete accounting (and must not cache it).
    pub cancelled: bool,
    /// Set when children were cut at this depth, so the panel can say the tree
    /// is aggregated below it rather than "this directory has nothing".
    #[serde(default)]
    pub truncated_at_depth: Option<u32>,
    pub elapsed_ms: u64,
    pub entries: u64,
}

/// Volume metadata and cancellable recursive size scans.
///
/// A separate service from [`FsApi`] on purpose: a scan is a long-running job
/// with its own lifetime (id, cancel flag, worker threads), and folding it into
/// `fs` would make every directory listing carry job semantics.
pub trait SysApi: Send + Sync + 'static {
    /// Volume space for and around `req.path`.
    fn disks(&self, req: &DiskListIn) -> Result<DiskListOut, CapabilityError>;
    /// Start a scan. Validates the root *before* returning: a root that is not
    /// a readable directory is an error on the call, not a `scan:done` later —
    /// a queued job that can never report would leave the UI waiting.
    fn start_scan(&self, req: &ScanIn) -> Result<ScanAck, CapabilityError>;
    /// Ask a live scan to stop. `false` for an unknown or finished id.
    fn cancel_scan(&self, scan_id: &str) -> Result<bool, CapabilityError>;
}

/// cordis `Service` marker for the disk/scan capability.
pub struct SysCapability {
    api: Arc<dyn SysApi>,
}

impl SysCapability {
    pub fn new(api: Arc<dyn SysApi>) -> Self {
        Self { api }
    }
    pub fn api(&self) -> &Arc<dyn SysApi> {
        &self.api
    }
}

impl Service for SysCapability {
    const NAME: &'static str = "capability.sys";
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
            keys(&ShellThumbnailOut {
                state: ThumbnailState::Ready,
                data_url: None,
                mime: None,
                edge: 0,
                from_cache: false,
            }),
            vec!["dataUrl", "edge", "fromCache", "mime", "state"]
        );
        assert_eq!(
            serde_json::to_value(HashAlgo::Blake3).unwrap(),
            json!("blake3")
        );
        // The two enums the UI branches on are wire-visible names, too.
        assert_eq!(
            serde_json::to_value(ThumbnailPolicy::CacheOnly).unwrap(),
            json!("cacheOnly")
        );
        assert_eq!(
            serde_json::to_value(ThumbnailState::UnsupportedPlatform).unwrap(),
            json!("unsupported-platform")
        );
    }

    /// Shell file operations cross the same boundary as everything else here: the
    /// UI branches on these strings, so they are frozen alongside the DTOs.
    #[test]
    fn file_operation_wire_names_are_frozen() {
        assert_eq!(
            keys(&FileOperationIn {
                op: FileOperationKind::Copy,
                sources: vec![],
                destination: None,
                new_name: None,
                to_recycle_bin: true,
                conflict: FileConflictPolicy::default(),
                request_token: None,
            }),
            vec![
                "conflict",
                "destination",
                "newName",
                "op",
                "requestToken",
                "sources",
                "toRecycleBin"
            ]
        );
        assert_eq!(
            keys(&FileOperationOut {
                operation_id: String::new(),
                state: FileOperationState::Queued,
                total: 0,
                indeterminate: true,
            }),
            vec!["indeterminate", "operationId", "state", "total"]
        );
        assert_eq!(
            keys(&FileOperationResult {
                operation_id: String::new(),
                state: FileOperationState::Completed,
                request_token: None,
                items: vec![],
                cross_volume_move: false,
            }),
            vec!["crossVolumeMove", "items", "operationId", "requestToken", "state"]
        );
        assert_eq!(
            keys(&FileKindOut {
                path: String::new(),
                kind: FileKind::Unknown,
                extension: String::new(),
                mime: None,
            }),
            vec!["extension", "kind", "mime", "path"]
        );
        assert_eq!(
            serde_json::to_value(FileOperationKind::Copy).unwrap(),
            json!("copy")
        );
        assert_eq!(
            serde_json::to_value(FileOperationState::PartialFailure).unwrap(),
            json!("partial-failure")
        );
        assert_eq!(
            serde_json::to_value(FileKind::Vector).unwrap(),
            json!("vector")
        );
        assert_eq!(
            serde_json::to_value(FileFailureReason::CancelledByShell).unwrap(),
            json!("cancelled-by-shell")
        );
    }

    /// `toRecycleBin` defaults to *true*: a caller that omits it must not get an
    /// irreversible delete (spec: 回收站默认).
    #[test]
    fn delete_defaults_to_the_recycle_bin() {
        let req: FileOperationIn = serde_json::from_value(json!({
            "op": "delete",
            "sources": ["/tmp/a.txt"]
        }))
        .unwrap();
        assert!(req.to_recycle_bin);
        assert_eq!(req.conflict, FileConflictPolicy::Fail);
        assert_eq!(req.destination, None);
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
