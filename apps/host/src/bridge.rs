//! Tauri event bridge (docs/02 §6.3): forwards cordis domain events to the
//! WebView event bus under the identical `domain:action` name, so frontend
//! plugins receive backend emissions without any name translation.
//!
//! This is the only Tauri-coupled piece of the backend wiring; it lives in the
//! host (not `fm-kernel`) and is spawned into the kernel roster via
//! [`fm_kernel::kernel::Kernel::spawn_ready`] so it tears down with everything
//! else.

use std::convert::Infallible;

use cordis_core::event::{observer, ListenerRegistrationError};
use cordis_core::{Context, Event, Plugin};
use fm_contracts::capability::{
    FileOperationProgress, FileOperationResult, ScanDone, ScanProgress, SearchIndexDone,
    SearchIndexProgress,
};
use fm_contracts::events::{
    FileChanged, FileChangedArgs, HistoryUpdated, HistoryUpdatedArgs, ScanDoneEvent,
    ScanProgressEvent, SearchIndexDoneEvent, SearchIndexProgressEvent, ShellOperationDone,
    ShellOperationProgress,
};
use tauri::{AppHandle, Emitter, Runtime};

/// Fiber that mirrors cordis domain events onto the Tauri event bus.
pub struct EventBridge<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> EventBridge<R> {
    /// Wrap a Tauri app handle for event forwarding.
    pub fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> Plugin for EventBridge<R> {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = ListenerRegistrationError;

    fn name(&self) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("event-bridge")
    }

    fn prepare(&self, _: ()) -> Result<(), Infallible> {
        Ok(())
    }

    async fn apply(&self, ctx: Context, _: &()) -> Result<(), Self::ApplyError> {
        let app_fc = self.app.clone();
        let _fc =
            ctx.on::<FileChanged, _>(observer(move |_ctx: Context, args: FileChangedArgs| {
                let app = app_fc.clone();
                async move {
                    let _ = app.emit(FileChanged::NAME, args);
                    Ok::<_, Infallible>(())
                }
            }))?;

        let app_hu = self.app.clone();
        let _hu = ctx.on::<HistoryUpdated, _>(observer(
            move |_ctx: Context, args: HistoryUpdatedArgs| {
                let app = app_hu.clone();
                async move {
                    let _ = app.emit(HistoryUpdated::NAME, args);
                    Ok::<_, Infallible>(())
                }
            },
        ))?;

        // Shell file operations are reported only through events (the ack says
        // "queued", nothing else), so these two forwards are the whole UI feed:
        // progress cards, the cancel button's enabled state and the per-item truth
        // after a partial failure. They are forwarded verbatim — a renamed or
        // reshaped event here would silently break every plugin listening for the
        // frozen `shell:operation:*` names.
        let app_op = self.app.clone();
        let _op = ctx.on::<ShellOperationProgress, _>(observer(
            move |_ctx: Context, args: FileOperationProgress| {
                let app = app_op.clone();
                async move {
                    let _ = app.emit(ShellOperationProgress::NAME, args);
                    Ok::<_, Infallible>(())
                }
            },
        ))?;

        // Separate listener, separate name: `partial-failure` must not have to be
        // inferred from the absence of a further progress tick (contract).
        let app_done = self.app.clone();
        let _done = ctx.on::<ShellOperationDone, _>(observer(
            move |_ctx: Context, args: FileOperationResult| {
                let app = app_done.clone();
                async move {
                    let _ = app.emit(ShellOperationDone::NAME, args);
                    Ok::<_, Infallible>(())
                }
            },
        ))?;

        // Recursive scans are the other long-running job the kernel owns and the
        // WebView only ever sees through events: `sys.scan.start` returns an id and
        // nothing else. Forwarded verbatim for the same reason as above — a reshape
        // here would break the space-analysis panel that listens for these names.
        let app_scan_progress = self.app.clone();
        let _scan_progress =
            ctx.on::<ScanProgressEvent, _>(observer(move |_ctx: Context, args: ScanProgress| {
                let app = app_scan_progress.clone();
                async move {
                    let _ = app.emit(ScanProgressEvent::NAME, args);
                    Ok::<_, Infallible>(())
                }
            }))?;

        let app_scan_done = self.app.clone();
        let _scan_done =
            ctx.on::<ScanDoneEvent, _>(observer(move |_ctx: Context, args: ScanDone| {
                let app = app_scan_done.clone();
                async move {
                    let _ = app.emit(ScanDoneEvent::NAME, args);
                    Ok::<_, Infallible>(())
                }
            }))?;

        // The name index is the third job that reports only through events. Its
        // `cancelled`/`partial` truth is the whole difference between "没有匹配" and
        // "索引不完整" in the UI, so a dropped forward here would make an empty result
        // page lie.
        let app_search_progress = self.app.clone();
        let _search_progress = ctx.on::<SearchIndexProgressEvent, _>(observer(
            move |_ctx: Context, args: SearchIndexProgress| {
                let app = app_search_progress.clone();
                async move {
                    let _ = app.emit(SearchIndexProgressEvent::NAME, args);
                    Ok::<_, Infallible>(())
                }
            },
        ))?;

        let app_search_done = self.app.clone();
        let _search_done = ctx.on::<SearchIndexDoneEvent, _>(observer(
            move |_ctx: Context, args: SearchIndexDone| {
                let app = app_search_done.clone();
                async move {
                    let _ = app.emit(SearchIndexDoneEvent::NAME, args);
                    Ok::<_, Infallible>(())
                }
            },
        ))?;
        Ok(())
    }
}
