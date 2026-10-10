//! Atomic capability layer (docs/01 §4, docs/02 §5).
//!
//! This module is the ONLY place third-party Rust crates (rusqlite / blake3 /
//! notify / ...) are referenced — the isolation boundary (docs/06 §5). It builds
//! concrete implementations, wraps them in the cordis `Service` markers from
//! `fm-contracts`, and can publish them into a kernel `Context` for backend DI
//! as well as expose them to Tauri commands for the frontend.

pub mod db;
pub mod file_kind;
pub mod fs;
pub mod hash;
pub mod resource;
pub mod shell_ops;
pub mod shell_thumb;
pub mod sys;
pub mod watch;

use std::sync::Arc;

use cordis_core::Context;
use cordis_core::service::ServicePublishError;
use fm_contracts::capability::{
    DbCapability, FileKindCapability, FsCapability, FsResourceCapability, HashCapability,
    ShellFileOperationCapability, ShellThumbnailCapability, SysCapability,
};

pub use db::SqliteDb;
pub use file_kind::FileKinds;
pub use fs::{StdFs, home_dir};
pub use hash::StreamingHash;
pub use resource::Resources;
pub use shell_ops::ShellOps;
pub use shell_thumb::ShellThumbs;
pub use sys::Sys;
pub use watch::{FsWatcher, WatchError, WatchHub};

/// The concrete capability implementations, built once at boot and shared
/// between the cordis kernel (backend DI) and the Tauri command layer
/// (frontend invoke). Cheap to clone (all `Arc` inside).
#[derive(Clone)]
pub struct CapabilitySet {
    /// Filesystem operations.
    pub fs: Arc<StdFs>,
    /// Streaming hashing.
    pub hash: Arc<StreamingHash>,
    /// Windows Shell system thumbnails (`shell.thumbnail.read`).
    pub shell_thumb: Arc<ShellThumbs>,
    /// Windows Shell file operations (`shell.fileOperation`) — the only writer
    /// of user files in this app.
    pub shell_ops: Arc<ShellOps>,
    /// Extension → kind classification (`file.kind`); pure, no platform calls.
    pub file_kinds: Arc<FileKinds>,
    /// Read-only, handle-bound preview data channel (`fs.*Resource`).
    pub resource: Arc<Resources>,
    /// Volume space + cancellable recursive scans (`sys.*`).
    pub sys: Arc<Sys>,
    /// Per-store SQLite storage.
    pub db: Arc<SqliteDb>,
}

impl CapabilitySet {
    /// Build the capability set. `db_path` may be `":memory:"` (tests).
    pub fn new(db_path: &str) -> Result<Self, fm_contracts::CapabilityError> {
        Ok(Self {
            fs: Arc::new(StdFs),
            hash: Arc::new(StreamingHash),
            shell_thumb: Arc::new(ShellThumbs::new()),
            shell_ops: Arc::new(ShellOps::new()),
            file_kinds: Arc::new(FileKinds::new()),
            resource: Arc::new(Resources::new()),
            sys: Arc::new(Sys::new()),
            db: Arc::new(SqliteDb::open(db_path)?),
        })
    }

    /// Publish all capabilities as cordis Services on `ctx` so backend plugins
    /// can resolve them via DI.
    ///
    /// Must run inside a fiber's `apply` (a generation that admits
    /// registrations) — the kernel bootstraps a dedicated provider fiber for
    /// this. The returned `ServicePublication` handles are dropped here on
    /// purpose: per the cordis consumer guide, dropping a publication leaves its
    /// generation cleanup *armed*, so the services stay visible until the
    /// provider fiber is disposed at kernel teardown (deterministic, no leak).
    pub fn publish(&self, ctx: &Context) -> Result<(), ServicePublishError> {
        // The Shell operation provider owns the event path: it runs its COM work
        // on private STA threads, which need a runtime handle to hand events back
        // to cordis. `Handle::current()` is only valid inside the runtime, which
        // `publish` is (the boot fiber applies on a worker). Capturing it here
        // rather than at `start` time is what keeps a bulk copy that outlives the
        // boot sequence able to report at all.
        self.shell_ops.attach(ctx.clone(), tokio::runtime::Handle::current());
        // A scan publishes `scan:*` from its own worker threads, so it needs the
        // same runtime handle the Shell provider does.
        self.sys.attach(ctx.clone(), tokio::runtime::Handle::current());
        let _fs = ctx.provide::<FsCapability>(Arc::new(FsCapability::new(self.fs.clone())))?;
        let _hash =
            ctx.provide::<HashCapability>(Arc::new(HashCapability::new(self.hash.clone())))?;
        let _db = ctx.provide::<DbCapability>(Arc::new(DbCapability::new(self.db.clone())))?;
        let _thumb = ctx.provide::<ShellThumbnailCapability>(Arc::new(
            ShellThumbnailCapability::new(self.shell_thumb.clone()),
        ))?;
        let _ops = ctx.provide::<ShellFileOperationCapability>(Arc::new(
            ShellFileOperationCapability::new(self.shell_ops.clone()),
        ))?;
        let _kinds =
            ctx.provide::<FileKindCapability>(Arc::new(FileKindCapability::new(
                self.file_kinds.clone(),
            )))?;
        let _resource = ctx.provide::<FsResourceCapability>(Arc::new(
            FsResourceCapability::new(self.resource.clone()),
        ))?;
        let _sys =
            ctx.provide::<SysCapability>(Arc::new(SysCapability::new(self.sys.clone())))?;
        Ok(())
    }
}
