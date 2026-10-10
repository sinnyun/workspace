//! Headless proof of the backend half of the error-isolation guarantee (P5-1,
//! risk: a buggy plugin must not take down the kernel or its siblings).
//!
//! cordis-core v0.6.1 contains user panics at a single named boundary
//! (`contained.rs`): a panicking `apply` becomes `FiberState::Failed`, its
//! rollback completes, and `ready()` surfaces it as `ReadyError::Apply` — it
//! never unwinds into the caller. This test asserts, without a window:
//! 1. booting a plugin whose `apply` panics returns `Err` (contained, not a crash);
//! 2. the failed transient fiber is not retained in the roster;
//! 3. an already-running sibling (the real `file-history` fiber) still reacts to
//!    `file:changed` afterwards, i.e. the panic is scoped to its own fiber;
//! 4. teardown stays clean.

use std::convert::Infallible;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use cordis_core::event::{observer, ListenerRegistrationError};
use cordis_core::{Context, Plugin};
use fm_contracts::events::{HistoryUpdated, HistoryUpdatedArgs};
use fm_kernel::capabilities::CapabilitySet;
use fm_kernel::kernel::Kernel;
use tokio::sync::mpsc;

/// Test-only fiber whose `apply` panics on purpose.
struct PanicPlugin;

impl Plugin for PanicPlugin {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = Infallible;

    fn name(&self) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("panic-plugin")
    }

    fn prepare(&self, _: ()) -> Result<(), Infallible> {
        Ok(())
    }

    async fn apply(&self, _ctx: Context, _: &()) -> Result<(), Self::ApplyError> {
        panic!("intentional apply panic for error-isolation test");
    }
}

/// Test-only fiber observing `history:updated` to prove the sibling is alive.
struct HistoryProbe {
    tx: mpsc::UnboundedSender<String>,
}

impl Plugin for HistoryProbe {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = ListenerRegistrationError;

    fn name(&self) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("history-probe")
    }

    fn prepare(&self, _: ()) -> Result<(), Infallible> {
        Ok(())
    }

    async fn apply(&self, ctx: Context, _: &()) -> Result<(), Self::ApplyError> {
        let tx = self.tx.clone();
        let _listener = ctx.on::<HistoryUpdated, _>(observer(
            move |_ctx: Context, args: HistoryUpdatedArgs| {
                let tx = tx.clone();
                async move {
                    let _ = tx.send(args.path);
                    Ok::<_, Infallible>(())
                }
            },
        ))?;
        Ok(())
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panicking_apply_is_contained_and_siblings_survive() {
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("note.txt");
    {
        let mut f = std::fs::File::create(&file).expect("create file");
        f.write_all(b"still alive").expect("write file");
    }
    let path = file.to_string_lossy().into_owned();

    let caps = CapabilitySet::new(":memory:").expect("capabilities");

    // Boot provider + real file-history backend.
    let kernel = Arc::new(Kernel::new());
    kernel.start_backend(caps).await.expect("start_backend");
    let baseline = kernel.fiber_count();
    assert!(baseline >= 2, "expected provider + file-history fibers");

    // 1+2. A panicking transient apply is contained: Err, no roster growth.
    let result = kernel.spawn_transient(PanicPlugin, ()).await;
    assert!(
        result.is_err(),
        "panicking apply must surface as Err, not a process crash"
    );
    assert_eq!(
        kernel.fiber_count(),
        baseline,
        "failed transient fiber must not be retained in the roster"
    );

    // 3. The sibling file-history fiber is unaffected: it still reacts.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    kernel
        .spawn_ready(HistoryProbe { tx }, ())
        .await
        .expect("probe spawn");
    kernel
        .emit_file_changed(path.clone(), "modify".to_owned())
        .await;

    let got = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("sibling must still emit history:updated after a sibling panic")
        .expect("channel closed");
    assert_eq!(got, path);

    // 4. Clean teardown.
    kernel.shutdown().await;
    assert_eq!(kernel.fiber_count(), 0, "roster empty after shutdown");
}
