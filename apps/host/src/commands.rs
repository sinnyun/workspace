//! Tauri command layer: the frontend projection of atomic capabilities
//! (docs/02 §5). A single `invoke_capability` dispatch parses `domain.action`
//! (including dynamic `db.<store>.<op>`) and routes to the concrete capability.
//!
//! Blocking capability calls run on `spawn_blocking` so a Tauri async command
//! never blocks a runtime worker (mirrors the backend plugin discipline).
//!
//! `shell.openPath` / `shell.revealItemInDir` / `shell.pick*` are answered here
//! rather than by a kernel capability on purpose: `tauri-plugin-opener` and
//! `tauri-plugin-dialog` already do exactly what the contract asks (the system
//! default handler, the system reveal, the native open dialog), and re-implementing
//! them with `ShellExecuteW`/`IFileDialog` COM would mean a second apartment, a
//! second message pump and a second set of behaviours to debug — for no added
//! capability. The dialogs in particular must never run on the main thread: a modal
//! dialog there deadlocks the WebView that owns it, hence `spawn_blocking`.

use std::sync::Arc;

use serde::de::DeserializeOwned;
use serde_json::Value;
use tauri::{Runtime, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::pluginsrv::PluginServer;
use fm_contracts::capability::{
    DiskListIn, FileKindApi, FileOperationIn, FsResourceApi, HashAlgo, PickIn, PickOut,
    ReadResourceIn, ResourceIn, ScanIn, ShellFileOperationApi, SysApi,
};
use fm_contracts::capability::names;
use fm_contracts::{FsApi, HashApi, ShellThumbnailApi, ThumbnailPolicy};
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

/// A non-blank string argument. `shell.openPath` and friends answer the dev mock
/// exactly (`invalid argument: path 为空`), because a frontend that classifies on
/// the `invalid argument:` prefix must classify the same way in dev and in the
/// host — the reason text is what a user may actually be shown.
fn required_path(args: &Value) -> Result<String, String> {
    let path = arg(args, "path")?.to_owned();
    if path.trim().is_empty() {
        return Err("invalid argument: path 为空".to_owned());
    }
    Ok(path)
}

/// Decode a whole-`args` DTO. The DTOs *are* the wire format (camelCase, guards
/// by `fm-contract-dump`), so re-deriving the field names here would be a second
/// schema to keep in sync; a bad body is a caller bug, hence the frozen prefix.
fn parse_dto<T: DeserializeOwned>(args: &Value) -> Result<T, String> {
    serde_json::from_value(args.clone()).map_err(|err| format!("invalid argument: {err}"))
}

fn parse_algo(args: &Value) -> HashAlgo {
    match args.get("algo").and_then(|v| v.as_str()) {
        Some("sha256") => HashAlgo::Sha256,
        _ => HashAlgo::Blake3,
    }
}

/// Dispatch one `domain.action` capability call. Returns JSON.
///
/// `app` is injected by Tauri, not passed by the frontend: `shell.openPath` and
/// the dialogs are features of the running window (the dialog's parent, the
/// opener's process context), so they need the handle rather than an argument.
#[tauri::command]
pub async fn invoke_capability(
    app: tauri::AppHandle<tauri::Wry>,
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
        // The preview resource channel (P7-20): the WebView gets an opaque handle
        // and bounded chunks, never a `file:` URL and never a whole file. Reading a
        // chunk is disk work, so all three arms run off the runtime worker.
        names::FS_OPEN_RESOURCE => {
            let req = parse_dto::<ResourceIn>(&args)?;
            tokio::task::spawn_blocking(move || {
                caps.resource
                    .open(&req)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::FS_READ_RESOURCE => {
            let req = parse_dto::<ReadResourceIn>(&args)?;
            tokio::task::spawn_blocking(move || {
                caps.resource
                    .read(&req)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::FS_CLOSE_RESOURCE => {
            let handle = arg(&args, "handle")?.to_owned();
            tokio::task::spawn_blocking(move || {
                caps.resource
                    .close(&handle)
                    .map_err(|e| e.to_string())
                    .map(Value::Bool)
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
        names::SHELL_THUMBNAIL_READ => {
            let path = arg(&args, "path")?.to_owned();
            let edge = args
                .get("edge")
                .and_then(|v| v.as_u64())
                .unwrap_or(256)
                .min(u64::from(u32::MAX)) as u32;
            // The wire spelling is the contract's (`"cacheOnly"` / `"extract"`);
            // anything else — missing, null, a typo — falls back to the default
            // policy rather than failing the whole call.
            let policy = args
                .get("policy")
                .and_then(|v| serde_json::from_value::<ThumbnailPolicy>(v.clone()).ok())
                .unwrap_or_default();
            tokio::task::spawn_blocking(move || {
                caps.shell_thumb
                    .read(&path, edge, policy)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SHELL_FILE_OPERATION => {
            // The whole `args` object *is* the contract DTO: re-reading its fields
            // by hand here would be a second schema nobody checks.
            let req = parse_dto::<FileOperationIn>(&args)?;
            tokio::task::spawn_blocking(move || {
                caps.shell_ops
                    .start(&req)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SHELL_CANCEL_FILE_OPERATION => {
            // `cancel` publishes the `cancelling` tick through cordis, which needs
            // `block_on` — so it goes on a blocking thread like the operation itself.
            let operation_id = arg(&args, "operationId")?.to_owned();
            tokio::task::spawn_blocking(move || {
                caps.shell_ops
                    .cancel(&operation_id)
                    .map(Value::Bool)
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SYS_DISK_LIST => {
            let req = parse_dto::<DiskListIn>(&args)?;
            tokio::task::spawn_blocking(move || {
                caps.sys
                    .disks(&req)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SYS_SCAN_START => {
            // The ack is all this call ever returns; the tree arrives as `scan:done`.
            let req = parse_dto::<ScanIn>(&args)?;
            tokio::task::spawn_blocking(move || {
                caps.sys
                    .start_scan(&req)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SYS_SCAN_CANCEL => {
            let scan_id = arg(&args, "scanId")?.to_owned();
            tokio::task::spawn_blocking(move || {
                caps.sys
                    .cancel_scan(&scan_id)
                    .map(Value::Bool)
                    .map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::FILE_KIND => {
            let path = required_path(&args)?;
            // `isDir` is the caller's own stat (contract: a listing already knows
            // it, and asking again would be one syscall per row). Without a hint the
            // caller is classifying a single path, so the one extra stat is the price
            // of an answer instead of a guess from the extension.
            let hint = args.get("isDir").and_then(|v| v.as_bool());
            tokio::task::spawn_blocking(move || {
                let is_dir = match hint {
                    Some(is_dir) => is_dir,
                    None => caps.fs.stat(&path).map_err(|e| e.to_string())?.is_dir,
                };
                caps.file_kinds
                    .classify(&path, is_dir)
                    .map_err(|e| e.to_string())
                    .and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SHELL_OPEN_PATH => {
            let path = required_path(&args)?;
            let app = app.clone();
            tokio::task::spawn_blocking(move || {
                // Pre-flight the same way the dev mock does: a row that went stale
                // should read `not found:`, not launch a handler on a path that is
                // gone. Whether the target app then did anything useful is nobody's
                // claim to make (contract: `Ok(true)` = the Shell accepted it).
                caps.fs.stat(&path).map_err(|e| e.to_string())?;
                app.opener()
                    .open_path(path, None::<&str>)
                    .map(|()| Value::Bool(true))
                    .map_err(|err| format!("io error: {err}"))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SHELL_REVEAL_ITEM => {
            let path = required_path(&args)?;
            // No existence pre-flight: revealing is a read-only convenience, and the
            // mock agrees — refusing here would turn a double-click on a stale row
            // into an error dialog for an action that touches nothing.
            let app = app.clone();
            tokio::task::spawn_blocking(move || {
                app.opener()
                    .reveal_item_in_dir(path)
                    .map(|()| Value::Bool(true))
                    .map_err(|err| format!("io error: {err}"))
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SHELL_PICK_FILE => {
            let req = parse_dto::<PickIn>(&args)?;
            let app = app.clone();
            tokio::task::spawn_blocking(move || {
                serde_json::to_value(run_pick(&app, &req, false)).map_err(|e| e.to_string())
            })
            .await
            .map_err(|e| e.to_string())?
        }
        names::SHELL_PICK_DIRECTORY => {
            let req = parse_dto::<PickIn>(&args)?;
            let app = app.clone();
            tokio::task::spawn_blocking(move || {
                serde_json::to_value(run_pick(&app, &req, true)).map_err(|e| e.to_string())
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

/// Show a native open dialog and translate its answer into [`PickOut`].
///
/// Two spellings of one idea meet here: the contract's `filters[].patterns` are
/// globs (`*.txt`), the plugin's are extension lists. `*.txt` → `txt`; a pattern
/// that is not `*.<ext>` cannot be expressed by the dialog API, so it is dropped
/// rather than guessed at — a filter that quietly matched a different set of files
/// would hide exactly what the user opened the dialog to find. A group whose
/// patterns all drop is skipped, because an empty extension list is a filter that
/// matches nothing at all.
///
/// The folder dialog gets no filters: the contract says they are ignored there, and
/// passing them would let the platform decide what "ignored" looks like.
///
/// `blocking_pick_*` on purpose: the caller is already on a blocking thread, and the
/// callback form would mean parking a channel here for an answer the plugin can hand
/// back directly.
fn run_pick(app: &tauri::AppHandle<tauri::Wry>, req: &PickIn, folders: bool) -> PickOut {
    let mut builder = app.dialog().file();
    if let Some(title) = req.title.as_deref().filter(|t| !t.trim().is_empty()) {
        builder = builder.set_title(title);
    }
    // An empty or nonexistent directory is dropped rather than corrected: the
    // dialog opens wherever the user last went, which beats an error for a hint.
    if let Some(dir) = req.initial_dir.as_deref().filter(|d| !d.trim().is_empty()) {
        builder = builder.set_directory(dir);
    }
    if !folders {
        for filter in &req.filters {
            let extensions: Vec<String> = filter
                .patterns
                .iter()
                .filter_map(|pattern| glob_to_extension(pattern))
                .collect();
            if extensions.is_empty() {
                continue;
            }
            let refs: Vec<&str> = extensions.iter().map(String::as_str).collect();
            builder = builder.add_filter(filter.description.as_str(), &refs);
        }
    }
    let picked = if folders {
        if req.multiple {
            builder.blocking_pick_folders()
        } else {
            builder.blocking_pick_folder().map(|path| vec![path])
        }
    } else if req.multiple {
        builder.blocking_pick_files()
    } else {
        builder.blocking_pick_file().map(|path| vec![path])
    };
    // Cancelling is an outcome, not an error (contract): an `Err` would read to the
    // UI as a crash of a dialog the user simply closed.
    match picked {
        None => PickOut {
            paths: Vec::new(),
            cancelled: true,
        },
        Some(paths) => PickOut {
            paths: paths
                .iter()
                // A `file://` URI would mean a platform this app does not ship; a
                // desktop selection is always a filesystem path, and the contract's
                // `paths` are paths.
                .filter_map(|path| path.as_path())
                .map(|path| path.to_string_lossy().into_owned())
                .collect(),
            cancelled: false,
        },
    }
}

/// `*.txt` → `txt`. Anything else (`*`, `a?b.txt`, a path) has no extension form.
fn glob_to_extension(pattern: &str) -> Option<String> {
    let extension = pattern.strip_prefix("*.")?;
    (!extension.is_empty() && !extension.contains(['*', '?', '/', '\\']))
        .then(|| extension.to_ascii_lowercase())
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
