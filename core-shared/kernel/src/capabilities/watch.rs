//! Concrete `watch` capability: `notify` (+ debouncer) observes paths and turns
//! filesystem events into cordis `file:changed` emissions.
//!
//! Two pieces:
//! - [`subscribe`] starts one debounced watcher that emits into a cordis Context.
//! - [`WatchHub`] is a small actor that owns all active watchers on a dedicated
//!   OS thread. The notify watcher is `Send` but **not `Sync`**, so it must never
//!   live inside Tauri's `Send + Sync` managed state; the hub keeps watchers on
//!   its own thread and exposes only a channel sender, which is `Send + Sync`.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use cordis_core::{Context, Routing};
use fm_contracts::events::{FileChanged, FileChangedArgs};
use notify_debouncer_full::{
    new_debouncer,
    notify::{EventKind, RecommendedWatcher},
    DebounceEventResult, Debouncer, RecommendedCache,
};
use tokio::runtime::Handle;
use tokio::sync::mpsc;

/// A running filesystem watcher that emits `file:changed` into a cordis Context.
pub struct FsWatcher {
    // Keep the debouncer alive; dropping it stops the watch.
    _debouncer: Arc<Debouncer<RecommendedWatcher, RecommendedCache>>,
}

/// Errors from establishing a watch.
#[derive(Debug, thiserror::Error)]
pub enum WatchError {
    /// Underlying `notify` watcher error.
    #[error("notify error: {0}")]
    Notify(#[from] notify::Error),
}

/// Start watching `path` (recursively), emitting `file:changed` on each debounced
/// filesystem event into `ctx`.
///
/// `handle` is the tokio runtime the emissions are driven on. The debouncer
/// invokes its callback on notify's own thread (never a runtime worker), so the
/// callback may safely `block_on` the async cordis dispatch there.
pub fn subscribe(ctx: Context, handle: Handle, path: &str) -> Result<FsWatcher, WatchError> {
    let emit_ctx = ctx.clone();
    let mut debouncer = new_debouncer(
        Duration::from_millis(300),
        None,
        move |res: DebounceEventResult| {
            let events = match res {
                Ok(e) => e,
                Err(errors) => {
                    for err in errors {
                        tracing::warn!("watch error: {err}");
                    }
                    return;
                }
            };
            for ev in events {
                let kind = kind_of(&ev.event.kind);
                let Some(p) = ev.event.paths.first() else {
                    continue;
                };
                let p = p.to_string_lossy().into_owned();
                let ctx = emit_ctx.clone();
                // Safe: this runs on notify's thread, not a tokio worker.
                handle.block_on(async move {
                    let _ = ctx
                        .emit::<FileChanged>(Routing::Unscoped, FileChangedArgs { path: p, kind })
                        .await;
                });
            }
        },
    )?;
    debouncer.watch(Path::new(path), notify::RecursiveMode::Recursive)?;
    Ok(FsWatcher {
        _debouncer: Arc::new(debouncer),
    })
}

/// An actor owning all active watchers on a dedicated thread. Cloneable handle is
/// just a channel sender, so it is `Send + Sync` and safe to keep in Tauri state.
#[derive(Clone)]
pub struct WatchHub {
    tx: mpsc::UnboundedSender<(Context, String)>,
}

impl WatchHub {
    /// Spawn the watcher thread. `handle` drives cordis emissions; watchers are
    /// retained on that thread until it exits (app lifetime).
    pub fn start(handle: Handle) -> Self {
        let (tx, mut rx) = mpsc::unbounded_channel::<(Context, String)>();
        std::thread::Builder::new()
            .name("fm-watch".to_owned())
            .spawn(move || {
                // Owned by this thread only; never shared, so non-Sync is fine.
                let mut watchers: Vec<FsWatcher> = Vec::new();
                while let Some((ctx, path)) = rx.blocking_recv() {
                    match subscribe(ctx, handle.clone(), &path) {
                        Ok(w) => {
                            tracing::info!(%path, "watching path");
                            watchers.push(w);
                        }
                        Err(e) => tracing::warn!(%path, error = %e, "watch subscribe failed"),
                    }
                }
                drop(watchers);
            })
            .expect("spawn fm-watch thread");
        Self { tx }
    }

    /// Ask the hub to start watching `path`, emitting into `ctx`. Returns
    /// immediately; the watch is established on the hub thread.
    pub fn subscribe(&self, ctx: Context, path: &str) -> Result<(), WatchError> {
        self.tx
            .send((ctx, path.to_owned()))
            .map_err(|_| WatchError::Notify(notify::Error::generic("watch hub closed")))?;
        Ok(())
    }
}

fn kind_of(k: &EventKind) -> String {
    match k {
        EventKind::Create(_) => "create",
        EventKind::Modify(_) => "modify",
        EventKind::Remove(_) => "remove",
        EventKind::Access(_) => "access",
        EventKind::Any => "any",
        EventKind::Other => "other",
    }
    .to_owned()
}
