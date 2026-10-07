//! Tauri event bridge (docs/02 §6.3): forwards cordis domain events to the
//! WebView event bus under the identical `domain:action` name, so frontend
//! plugins receive backend emissions without any name translation.
//!
//! This is the only Tauri-coupled piece of the backend wiring; it lives in the
//! host (not `fm-kernel`) and is spawned into the kernel roster via
//! [`fm_kernel::kernel::Kernel::spawn_ready`] so it tears down with everything
//! else.

use std::convert::Infallible;

use cordis_core::event::{ListenerRegistrationError, observer};
use cordis_core::{Context, Event, Plugin};
use fm_contracts::events::{FileChanged, FileChangedArgs, HistoryUpdated, HistoryUpdatedArgs};
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
        let _fc = ctx.on::<FileChanged, _>(observer(
            move |_ctx: Context, args: FileChangedArgs| {
                let app = app_fc.clone();
                async move {
                    let _ = app.emit(FileChanged::NAME, args);
                    Ok::<_, Infallible>(())
                }
            },
        ))?;

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
        Ok(())
    }
}
