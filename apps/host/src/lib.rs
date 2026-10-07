//! fm-host library crate: the thin Tauri v2 shell around `fm-kernel`.
//!
//! All backend logic (atomic capabilities, the cordis-rs kernel bootstrap, the
//! static plugin registry) lives in the Tauri-free `fm-kernel` crate and is
//! integration-tested headlessly there. This crate only wires that kernel to the
//! WebView:
//! 1. build the capability set (sqlite under the app data dir);
//! 2. `start_backend` (provider fiber + backend plugin fibers);
//! 3. spawn the [`bridge::EventBridge`] fiber to forward domain events to the WebView;
//! 4. manage [`commands::HostState`] so capability commands can reach caps/kernel;
//! 5. serve frontend plugin ESM over the `plugin://` scheme.

pub mod bridge;
pub mod commands;
pub mod pluginsrv;

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};

use commands::HostState;
use fm_kernel::capabilities::{CapabilitySet, WatchHub};
use fm_kernel::kernel::Kernel;
use pluginsrv::PluginServer;
use tauri::{Manager, UriSchemeContext, UriSchemeResponder};

/// The real plugin server is only discoverable once a Tauri handle exists (in
/// `setup`), but the `plugin://` protocol handler must be registered before the
/// app runs. A shared `OnceLock` bridges that ordering: the handler reads it
/// lazily, `setup` populates it once.
type SharedServer = Arc<OnceLock<Arc<PluginServer>>>;

/// Register the `plugin://` URI scheme that serves frontend plugin ESM files.
///
/// URL shape: `plugin://plugin/<name>/<relpath>`. On Windows WebView2 the custom
/// scheme is delivered as `http://plugin.localhost/<name>/<relpath>`; Tauri
/// normalizes the authority, so we parse the path segments defensively.
fn plugin_protocol(
    holder: SharedServer,
) -> impl Fn(UriSchemeContext<'_, tauri::Wry>, http::Request<Vec<u8>>, UriSchemeResponder) + Send + Sync + 'static
{
    move |_ctx, request, responder| {
        let Some(server) = holder.get() else {
            responder.respond(not_found());
            return;
        };
        let uri = request.uri();
        // Path is like `/plugin/<name>/<relpath>` or `/<name>/<relpath>`.
        let mut segs = uri
            .path()
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_owned())
            .collect::<Vec<_>>();
        if segs.first().map(String::as_str) == Some("plugin") {
            segs.remove(0);
        }
        if segs.len() < 2 {
            responder.respond(not_found());
            return;
        }
        let name = segs.remove(0);
        let relpath = segs.join("/");
        match server.resolve(&name, &relpath) {
            Some(path) => match std::fs::read(&path) {
                Ok(bytes) => {
                    let mime = guess_mime(&relpath);
                    let resp = http::Response::builder()
                        .header("Content-Type", mime)
                        // Allow the WebView to import cross-origin module files.
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes)
                        .unwrap();
                    responder.respond(resp);
                }
                Err(_) => responder.respond(not_found()),
            },
            None => responder.respond(not_found()),
        }
    }
}

fn not_found() -> http::Response<Vec<u8>> {
    http::Response::builder()
        .status(404)
        .body(b"not found".to_vec())
        .unwrap()
}

fn guess_mime(path: &str) -> &'static str {
    if path.ends_with(".js") || path.ends_with(".mjs") {
        "text/javascript"
    } else if path.ends_with(".json") {
        "application/json"
    } else if path.ends_with(".css") {
        "text/css"
    } else if path.ends_with(".svg") {
        "image/svg+xml"
    } else if path.ends_with(".wasm") {
        "application/wasm"
    } else {
        "application/octet-stream"
    }
}

/// Plugin discovery roots: user-writable app data first, then the repo's
/// `plugins/` in dev so built frontend plugins are found without packaging.
fn plugin_roots(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        roots.push(cwd.join("plugins"));
    }
    if let Ok(dir) = app.path().app_data_dir() {
        roots.push(dir.join("plugins"));
    }
    roots
}

/// Build and run the Tauri application.
pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .try_init();

    let server_holder: SharedServer = Arc::new(OnceLock::new());

    tauri::Builder::default()
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .register_asynchronous_uri_scheme_protocol(
            "plugin",
            plugin_protocol(Arc::clone(&server_holder)),
        )
        .invoke_handler(tauri::generate_handler![
            commands::invoke_capability,
            commands::plugins_list_frontend,
            commands::watch_subscribe
        ])
        .setup(move |app| {
            let handle = app.handle().clone();

            // Discover frontend plugins now that a handle exists, and publish to
            // the protocol handler's shared holder.
            let server = Arc::new(PluginServer::discover(plugin_roots(&handle)));
            let _ = server_holder.set(Arc::clone(&server));

            // Capability set: sqlite under the app data dir (falls back to memory).
            let db_path = handle
                .path()
                .app_data_dir()
                .map(|d| d.join("fm.sqlite").to_string_lossy().into_owned())
                .unwrap_or_else(|_| ":memory:".to_owned());
            let caps = CapabilitySet::new(&db_path)
                .map_err(|e| format!("capability init failed: {e}"))?;

            let kernel = Arc::new(Kernel::new());

            // Watcher actor: owns the non-Sync notify watchers on its own thread.
            // Grab a tokio handle from Tauri's async runtime for cordis emissions.
            let tokio_handle =
                tauri::async_runtime::block_on(async { tokio::runtime::Handle::current() });
            let watch = WatchHub::start(tokio_handle);

            let state: HostState<tauri::Wry> = HostState::new(
                caps.clone(),
                Arc::clone(&kernel),
                Arc::clone(&server),
                watch,
            );
            app.manage(state);

            // Boot the kernel on Tauri's async runtime (never block a worker):
            // provider + backend plugins, then the Tauri event bridge fiber.
            let kernel_boot = Arc::clone(&kernel);
            let boot_caps = caps;
            tauri::async_runtime::spawn(async move {
                if let Err(e) = kernel_boot.start_backend(boot_caps).await {
                    tracing::error!(error = %e, "kernel backend boot failed");
                    return;
                }
                if let Err(e) = kernel_boot
                    .spawn_ready(bridge::EventBridge::new(handle.clone()), ())
                    .await
                {
                    tracing::error!(error = %e, "event bridge boot failed");
                }
                tracing::info!(fibers = kernel_boot.fiber_count(), "cordis kernel booted");
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running fm-host");
}
