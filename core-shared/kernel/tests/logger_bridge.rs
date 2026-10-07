//! Headless proof of the P5-3 observability path: a Runtime-wide exporter
//! registered through `Context::add_exporter` — the exact surface the kernel's
//! [`LogBridgePlugin`]/[`TracingBridge`] uses to forward to `tracing` — actually
//! receives records emitted through cordis's native [`Logger`], with the level,
//! channel, and text fields the bridge reads.
//!
//! cordis dispatches a `Logger` record to the current exporter snapshot
//! synchronously, so the capture is deterministic without a `tracing` harness
//! or a window.

use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use cordis_core::effect::EffectRegistrationError;
use cordis_core::logger::{BufferExporter, Level};
use cordis_core::{Context, Plugin};
use fm_kernel::capabilities::CapabilitySet;
use fm_kernel::kernel::Kernel;

/// Fiber that registers a capture buffer into the Runtime exporter set and then
/// logs one known record through the same `Logger` the kernel bridge observes.
struct SinkPlugin {
    sink: Arc<Mutex<Option<Arc<BufferExporter>>>>,
}

impl Plugin for SinkPlugin {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = EffectRegistrationError;

    fn name(&self) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("sink-plugin")
    }

    fn prepare(&self, _: ()) -> Result<(), Infallible> {
        Ok(())
    }

    async fn apply(&self, ctx: Context, _: &()) -> Result<(), Self::ApplyError> {
        let buffer = Arc::new(
            BufferExporter::new(64, Level::Info).expect("buffer exporter capacity"),
        );
        // add_exporter takes the Arc; keep a clone for the test to snapshot.
        *self.sink.lock().unwrap() = Some(buffer.clone());
        let _registration = ctx.add_exporter(buffer)?;
        // Log through the Runtime logger; dispatch to exporters is synchronous.
        ctx.logger().info("kernel-observability-marker");
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runtime_diagnostics_reach_a_registered_exporter() {
    let caps = CapabilitySet::new(":memory:").expect("capabilities");
    let kernel = Arc::new(Kernel::new());
    kernel.start_backend(caps).await.expect("start_backend");

    // Attach the capture buffer through the same add_exporter path the bridge uses.
    let sink = Arc::new(Mutex::new(None));
    kernel
        .spawn_ready(SinkPlugin { sink: sink.clone() }, ())
        .await
        .expect("sink spawn");
    let buffer = sink.lock().unwrap().clone().expect("buffer registered");

    let snapshot = buffer.snapshot();
    let marker = snapshot
        .iter()
        .find(|rec| rec.text() == "kernel-observability-marker");
    let marker = marker.unwrap_or_else(|| {
        panic!(
            "expected the Info marker record; got {:?}",
            snapshot
                .iter()
                .map(|r| (r.level().as_str(), r.channel(), r.text()))
                .collect::<Vec<_>>()
        )
    });
    assert_eq!(marker.level(), Level::Info);

    kernel.shutdown().await;
}

