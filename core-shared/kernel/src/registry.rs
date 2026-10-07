//! Backend plugin registry (roadmap P1-6).
//!
//! Statically-compiled backend plugins are registered here as type-erased spawn
//! closures. Each closure deserializes its manifest `backend.config`, prepares,
//! seals and spawns the plugin on the kernel Context. This is the hand-written
//! v1; P3-5 replaces it with `build.rs` codegen scanning `plugins/*/manifest.json`
//! so there is no manual drift.
//!
//! Config is embedded from each plugin's manifest at compile time via
//! `include_str!`, keeping the backend build-time-discovered (docs/03 §8) and
//! avoiding runtime file discovery for statically-linked plugins.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use cordis_core::{Context, FiberHandle, Plugin, PreparedPlugin};
use plugin_file_history_backend::{FileHistoryConfig, FileHistoryPlugin};

/// A boxed future producing a settled-or-pending fiber handle.
pub type SpawnFuture = Pin<Box<dyn Future<Output = anyhow::Result<FiberHandle>> + Send>>;

/// Type-erased spawn closure: `(ctx, config) -> future<handle>`.
pub type SpawnFn = Arc<dyn Fn(&Context, serde_json::Value) -> SpawnFuture + Send + Sync>;

/// One registered backend plugin: manifest name, embedded config, spawn closure.
pub type RegistryEntry = (String, serde_json::Value, SpawnFn);

const FILE_HISTORY_MANIFEST: &str =
    include_str!("../../../plugins/plugin-file-history/manifest.json");

/// Extract `backend.config` from an embedded manifest (empty object if absent).
fn backend_config(manifest: &str) -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(manifest)
        .ok()
        .and_then(|m| m.get("backend").and_then(|b| b.get("config")).cloned())
        .unwrap_or_else(|| serde_json::json!({}))
}

fn backend_name(manifest: &str, fallback: &str) -> String {
    serde_json::from_str::<serde_json::Value>(manifest)
        .ok()
        .and_then(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
        .unwrap_or_else(|| fallback.to_owned())
}

/// The compiled-in backend plugins, in spawn order.
pub fn backend_plugins() -> Vec<RegistryEntry> {
    vec![file_history_entry()]
}

fn file_history_entry() -> RegistryEntry {
    let name = backend_name(FILE_HISTORY_MANIFEST, "plugin-file-history");
    let config = backend_config(FILE_HISTORY_MANIFEST);
    let spawn: SpawnFn = Arc::new(|ctx: &Context, config: serde_json::Value| {
        let ctx = ctx.clone();
        Box::pin(async move {
            let cfg: FileHistoryConfig =
                serde_json::from_value(config).unwrap_or_default();
            let plugin = FileHistoryPlugin;
            let input = plugin
                .prepare(cfg)
                .map_err(|e| anyhow::anyhow!("file-history prepare failed: {e}"))?;
            let sealed = PreparedPlugin::from_input(plugin, input);
            let handle = ctx
                .spawn(sealed)
                .await
                .map_err(|e| anyhow::anyhow!("file-history spawn failed: {e:?}"))?;
            Ok(handle)
        })
    });
    (name, config, spawn)
}
