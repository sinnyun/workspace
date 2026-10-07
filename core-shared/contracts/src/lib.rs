//! Cross-layer contracts — the single Rust source of truth for shapes that
//! cross the kernel <-> plugin boundary.
//!
//! Backend plugins depend on **this crate only**, never on each other and never
//! on the host (docs/01-architecture.md §6, red line 1). Two things live here:
//!
//! 1. typed cordis [`Event`]s (`file:changed`, `history:updated`, ...);
//! 2. atomic **capability** contracts — the `Service` marker structs plus the
//!    synchronous API traits the host implements and publishes via DI.
//!
//! Capabilities are *atomic* (no business logic, red line 3) and *synchronous*:
//! callers that must not block (a cordis `apply` poll, a Tauri command) wrap the
//! call in `tokio::task::spawn_blocking`. Keeping the API sync means `contracts`
//! stays dependency-light and needs no `async_trait`.

pub mod capability;
pub mod events;
pub mod manifest;

pub use capability::{
    CapabilityError, DbApi, DbCapability, FsApi, FsCapability, HashApi, HashCapability, HashAlgo,
    ListEntry, ReadChunkOut, StatOut,
};
pub use events::{FileChanged, FileChangedArgs, HistoryUpdated, HistoryUpdatedArgs};
pub use manifest::PluginManifest;
