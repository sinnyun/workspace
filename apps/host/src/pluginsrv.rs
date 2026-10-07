//! Frontend plugin serving (docs/03 §8, roadmap P0-6/P2-4) and watch ownership.
//!
//! Discovery: scan plugin root directories for `<plugin>/manifest.json`, keep the
//! ones that declare a `frontend.entry`. Serving: the `plugin://` URI scheme
//! handler resolves `plugin://plugin/<name>/<relpath>` to a file under that
//! plugin's directory (path-traversal guarded). Watchers created by
//! `watch.subscribe` are retained here so they live until dropped.
//!
//! Two roots are scanned: the bundled resource dir (read-only, shipped plugins)
//! and the app data dir (user-writable, drop-in plugins) — the mechanism behind
//! "install a frontend plugin = drop it in a folder" (docs/03 §8).

use std::path::{Component, Path, PathBuf};

use fm_contracts::PluginManifest;
use serde_json::Value;

/// One discovered frontend plugin: its manifest and the directory it lives in.
#[derive(Debug, Clone)]
pub struct FrontendPlugin {
    /// Validated manifest.json (schema + semantics, docs/02 §2).
    pub manifest: PluginManifest,
    /// Plugin root directory (contains manifest.json).
    pub dir: PathBuf,
}

/// Discovers and serves frontend plugins. File watching is owned separately by
/// [`fm_kernel::capabilities::WatchHub`] (the notify watcher is not `Sync`, so it
/// must not live in Tauri's managed state).
pub struct PluginServer {
    plugins: Vec<FrontendPlugin>,
}

impl PluginServer {
    /// Scan `roots` for plugins that declare a `frontend.entry`. Later roots win
    /// on name collision (user data dir overrides bundled).
    pub fn discover(roots: impl IntoIterator<Item = PathBuf>) -> Self {
        let mut by_name: Vec<FrontendPlugin> = Vec::new();
        for root in roots {
            let Ok(entries) = std::fs::read_dir(&root) else {
                continue;
            };
            for entry in entries.flatten() {
                let dir = entry.path();
                if !dir.is_dir() {
                    continue;
                }
                let manifest_path = dir.join("manifest.json");
                let Ok(text) = std::fs::read_to_string(&manifest_path) else {
                    continue;
                };
                let Ok(manifest) = serde_json::from_str::<PluginManifest>(&text) else {
                    tracing::warn!(path = %manifest_path.display(), "skipping unparsable manifest");
                    continue;
                };
                if let Err(reason) = manifest.validate() {
                    tracing::warn!(path = %manifest_path.display(), reason, "skipping invalid manifest");
                    continue;
                }
                // Backend-only plugins are not served to the frontend.
                if manifest.frontend.is_none() {
                    continue;
                }
                let name = manifest.name.clone();
                if let Some(pos) = by_name.iter().position(|p| p.manifest.name == name) {
                    by_name[pos] = FrontendPlugin { manifest, dir };
                } else {
                    by_name.push(FrontendPlugin { manifest, dir });
                }
            }
        }
        Self {
            plugins: by_name,
        }
    }

    /// Manifests of all discovered frontend plugins (for `plugins_list_frontend`).
    pub fn list_frontend_manifest(&self) -> Vec<Value> {
        self.plugins
            .iter()
            .filter_map(|p| serde_json::to_value(&p.manifest).ok())
            .collect()
    }

    /// Resolve `plugin://plugin/<name>/<relpath>` to an absolute file path,
    /// rejecting traversal outside the plugin directory.
    pub fn resolve(&self, name: &str, relpath: &str) -> Option<PathBuf> {
        let plugin = self.plugins.iter().find(|p| p.manifest.name == name)?;
        let candidate = plugin.dir.join(relpath);
        // Guard against `..` traversal escaping the plugin dir.
        let base = plugin.dir.canonicalize().ok()?;
        let resolved = normalize(&candidate);
        if resolved.starts_with(&base) {
            Some(resolved)
        } else {
            tracing::warn!(name, relpath, "plugin path traversal rejected");
            None
        }
    }
}

/// Lexically normalize a path (resolve `.`/`..` without touching the fs), so
/// traversal checks work even for not-yet-existing files.
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
