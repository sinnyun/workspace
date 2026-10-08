//! Tauri command layer: the frontend projection of atomic capabilities
//! (docs/02 §5). A single `invoke_capability` dispatch parses `domain.action`
//! (including dynamic `db.<store>.<op>`) and routes to the concrete capability.
//!
//! Blocking capability calls run on `spawn_blocking` so a Tauri async command
//! never blocks a runtime worker (mirrors the backend plugin discipline).

use std::sync::Arc;

use serde_json::Value;
use tauri::{Runtime, State};

use crate::pluginsrv::PluginServer;
use fm_contracts::capability::HashAlgo;
use fm_contracts::capability::names;
use fm_contracts::{FsApi, HashApi, ThumbApi};
use fm_kernel::capabilities::{CapabilitySet, WatchHub};
use fm_kernel::kernel::Kernel;

/// Shared application state managed by Tauri. Must be `Send + Sync` (Tauri
/// command state requirement); the non-`Sync` notify watcher lives in [`WatchHub`].
pub struct HostState<R: Runtime> {
    /// Concrete capabilities (also published to the kernel for backend DI).
    pub caps: CapabilitySet,
    /// The cordis kernel.
    pub kernel: Arc<Kernel>,
    /// Frontend plugin server (manifest discovery + `plugin://` file serving).
    pub plugins: Arc<PluginServer>,
    /// Watcher actor handle (owns notify watchers off-thread).
    pub watch: WatchHub,
    // `fn() -> R` (not `PhantomData<R>`) so the state stays `Send + Sync`: the
    // Wry runtime marker itself is neither, and Tauri command state must be both.
    _runtime: std::marker::PhantomData<fn() -> R>,
}

impl<R: Runtime> HostState<R> {
    /// Build host state from an already-constructed kernel and capability set.
    pub fn new(
        caps: CapabilitySet,
        kernel: Arc<Kernel>,
        plugins: Arc<PluginServer>,
        watch: WatchHub,
    ) -> Self {
        Self {
            caps,
            kernel,
            plugins,
            watch,
            _runtime: std::marker::PhantomData,
        }
    }
}

fn arg<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("missing string argument `{key}`"))
}

fn parse_algo(args: &Value) -> HashAlgo {
    match args.get("algo").and_then(|v| v.as_str()) {
        Some("sha256") => HashAlgo::Sha256,
        _ => HashAlgo::Blake3,
    }
}

/// Dispatch one `domain.action` capability call. Returns JSON.
#[tauri::command]
pub async fn invoke_capability(
    capability: String,
    args: Value,
    state: State<'_, HostState<tauri::Wry>>,
) -> Result<Value, String> {
    let caps = state.caps.clone();
    let name = capability.clone();

    // db.<store>.<op> is dynamic; parse the store from the name.
    if let Some(rest) = name.strip_prefix(fm_contracts::capability::names::DB_PREFIX) {
        let (store, op) = rest
            .split_once('.')
            .ok_or_else(|| format!("malformed db capability `{name}`"))?;
        let store = store.to_owned();
        let op = op.to_owned();
        let db = Arc::clone(&caps.db);
        return tokio::task::spawn_blocking(move || run_db(&db, &store, &op, &args))
            .await
            .map_err(|e| e.to_string())?;
    }

    match name.as_str() {
        names::FS_HOME => Ok(Value::String(fm_kernel::capabilities::home_dir())),
        names::FS_LIST => {
            let path = arg(&args, "path")?.to_owned();
            tokio::task::spawn_blocking(move || {
                caps.fs
                    .list(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::FS_STAT => {
            let path = arg(&args, "path")?.to_owned();
            tokio::task::spawn_blocking(move || {
                caps.fs
                    .stat(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::FS_READ_CHUNK => {
            let path = arg(&args, "path")?.to_owned();
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0);
            let len = args.get("len").and_then(|v| v.as_u64()).unwrap_or(4096);
            tokio::task::spawn_blocking(move || {
                caps.fs
                    .read_chunk(&path, offset, len)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::FS_READ_TEXT => {
            let path = arg(&args, "path")?.to_owned();
            tokio::task::spawn_blocking(move || {
                caps.fs
                    .read_text(&path)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::HASH_COMPUTE => {
            let path = arg(&args, "path")?.to_owned();
            let algo = parse_algo(&args);
            tokio::task::spawn_blocking(move || {
                caps.hash
                    .file(&path, algo)
                    .map_err(|e| e.to_string())
                    .map(Value::String)
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::THUMB_IMAGE => {
            let path = arg(&args, "path")?.to_owned();
            let edge = args
                .get("edge")
                .and_then(|v| v.as_u64())
                .unwrap_or(256)
                .min(u64::from(u32::MAX)) as u32;
            tokio::task::spawn_blocking(move || {
                caps.thumb
                    .image(&path, edge)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::WATCH_SUBSCRIBE => {
            let path = arg(&args, "path")?.to_owned();
            let ctx = state.kernel.ctx().clone();
            let watch = state.watch.clone();
            watch.subscribe(ctx, &path).map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        other => Err(format!("unknown capability `{other}`")),
    }
}

fn run_db(
    db: &Arc<fm_kernel::capabilities::SqliteDb>,
    store: &str,
    op: &str,
    args: &Value,
) -> Result<Value, String> {
    use fm_contracts::capability::DbApi;
    let key = arg(args, "key").or_else(|_| arg(args, "path"))?.to_owned();
    match op {
        "get" => {
            let v = db.get(store, &key).map_err(|e| e.to_string())?;
            Ok(v.unwrap_or(Value::Null))
        }
        "put" => {
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            db.put(store, &key, &value).map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        "list" => {
            // `list` with a `key`/`path` reads that key's ordered log (history);
            // without one, it lists the store's kv rows.
            if args.get("key").is_some() || args.get("path").is_some() {
                let log = db.read_log(store, &key).map_err(|e| e.to_string())?;
                serde_json::to_value(log).map_err(|e| e.to_string())
            } else {
                let rows = db.list(store).map_err(|e| e.to_string())?;
                serde_json::to_value(rows).map_err(|e| e.to_string())
            }
        }
        "append" => {
            let value = args.get("value").cloned().unwrap_or(Value::Null);
            db.append(store, &key, &value).map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        "readLog" => {
            let log = db.read_log(store, &key).map_err(|e| e.to_string())?;
            serde_json::to_value(log).map_err(|e| e.to_string())
        }
        "delete" => {
            db.delete(store, &key).map_err(|e| e.to_string())?;
            Ok(Value::Bool(true))
        }
        other => Err(format!("unknown db op `{other}`")),
    }
}

/// List discovered frontend plugin manifests (consumed by the shell loader).
#[tauri::command]
pub fn plugins_list_frontend(state: State<'_, HostState<tauri::Wry>>) -> Result<Vec<Value>, String> {
    Ok(state.plugins.list_frontend_manifest())
}

/// Subscribe the kernel watcher to a path; changes surface as `file:changed`.
#[tauri::command]
pub async fn watch_subscribe(
    path: String,
    state: State<'_, HostState<tauri::Wry>>,
) -> Result<(), String> {
    let ctx = state.kernel.ctx().clone();
    state.watch.subscribe(ctx, &path).map_err(|e| e.to_string())
}
