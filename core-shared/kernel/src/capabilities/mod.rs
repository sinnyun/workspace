//! Atomic capability layer (docs/01 §4, docs/02 §5).
//!
//! This module is the ONLY place third-party Rust crates (rusqlite / blake3 /
//! notify / ...) are referenced — the isolation boundary (docs/06 §5). It builds
//! concrete implementations, wraps them in the cordis `Service` markers from
//! `fm-contracts`, and can publish them into a kernel `Context` for backend DI
//! as well as expose them to Tauri commands for the frontend.

pub mod db;
pub mod fs;
pub mod hash;
pub mod watch;

use std::sync::Arc;

use cordis_core::Context;
use cordis_core::service::ServicePublishError;
use fm_contracts::capability::{DbCapability, FsCapability, HashCapability};

pub use db::SqliteDb;
pub use fs::{StdFs, home_dir};
pub use hash::StreamingHash;
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
    /// Per-store SQLite storage.
    pub db: Arc<SqliteDb>,
}

impl CapabilitySet {
    /// Build the capability set. `db_path` may be `":memory:"` (tests).
    pub fn new(db_path: &str) -> Result<Self, fm_contracts::CapabilityError> {
        Ok(Self {
            fs: Arc::new(StdFs),
            hash: Arc::new(StreamingHash),
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
        let _fs = ctx.provide::<FsCapability>(Arc::new(FsCapability::new(self.fs.clone())))?;
        let _hash =
            ctx.provide::<HashCapability>(Arc::new(HashCapability::new(self.hash.clone())))?;
        let _db = ctx.provide::<DbCapability>(Arc::new(DbCapability::new(self.db.clone())))?;
        Ok(())
    }
}
