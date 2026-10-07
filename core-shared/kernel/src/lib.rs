//! Backend core for the file manager (roadmap P1-2 / P1-3 / P1-6).
//!
//! This crate is deliberately **Tauri-free** so the whole backend vertical slice
//! — atomic capabilities, the cordis-rs kernel bootstrap, and the static backend
//! plugin registry — can be built and integration-tested headlessly with
//! `cargo test`. The Tauri host (`apps/host`) is a thin shell that depends on this
//! crate and layers the event bridge + command dispatch on top.
//!
//! Layout:
//! - [`capabilities`] — concrete atomic capability implementations (fs/hash/db/
//!   watch) and the isolation boundary for third-party crates (docs/06 §5).
//! - [`kernel`] — cordis root Context, capability provider fiber, boot/teardown.
//! - [`logger`] — cordis native Logger → `tracing` bridge (P5-3 observability).
//! - [`registry`] — statically-linked backend plugins as type-erased spawn fns.

pub mod capabilities;
pub mod kernel;
pub mod logger;
pub mod registry;

pub use kernel::{CapabilityProvider, Kernel};
