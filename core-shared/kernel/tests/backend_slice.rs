//! Headless integration test for the backend vertical slice (roadmap P1-2 / P1-3
//! / P1-6 / P4-1). No Tauri, no GUI: boots the real cordis kernel with the real
//! capability set (in-memory SQLite), runs the real `plugin-file-history` backend
//! fiber, emits a `file:changed`, and asserts the plugin hashed the file, recorded
//! a snapshot in its `history` store, and emitted `history:updated`.
//!
//! This is the architectural risk (R1) proven end-to-end without a window.

use std::convert::Infallible;
use std::io::Write;
use std::sync::Arc;
use std::time::Duration;

use cordis_core::event::{observer, ListenerRegistrationError};
use cordis_core::{Context, Plugin};
use fm_contracts::capability::HashAlgo;
use fm_contracts::events::{HistoryUpdated, HistoryUpdatedArgs};
use fm_contracts::{DbApi, HashApi};
use fm_kernel::capabilities::CapabilitySet;
use fm_kernel::kernel::Kernel;
use tokio::sync::mpsc;

/// Test-only fiber that observes `history:updated` and forwards the path to a
/// channel, so the test can assert the event fired without a Tauri bridge.
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
async fn backend_slice_records_history_and_emits_update() {
    // 1. A real file on disk with known content.
    let dir = tempfile::tempdir().expect("tempdir");
    let file = dir.path().join("note.txt");
    {
        let mut f = std::fs::File::create(&file).expect("create file");
        f.write_all(b"hello world").expect("write file");
    }
    let path = file.to_string_lossy().into_owned();

    // 2. Real capabilities on an in-memory SQLite db; keep a clone for assertions.
    let caps = CapabilitySet::new(":memory:").expect("capabilities");
    let caps_probe = caps.clone();

    // 3. Boot the kernel: provider fiber + backend registry (file-history).
    let kernel = Arc::new(Kernel::new());
    kernel.start_backend(caps).await.expect("start_backend");
    assert!(
        kernel.fiber_count() >= 2,
        "expected provider + file-history fibers, got {}",
        kernel.fiber_count()
    );

    // 4. Attach the probe so we can observe `history:updated`.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    kernel
        .spawn_ready(HistoryProbe { tx }, ())
        .await
        .expect("probe spawn");

    // Expected digest for the file content.
    let expected_hash = caps_probe
        .hash
        .file(&path, HashAlgo::Blake3)
        .expect("hash file");

    // 5. Emit a modify event and wait for the plugin to react.
    kernel
        .emit_file_changed(path.clone(), "modify".to_owned())
        .await;

    let got = tokio::time::timeout(Duration::from_secs(10), rx.recv())
        .await
        .expect("timed out waiting for history:updated")
        .expect("channel closed");
    assert_eq!(got, path, "history:updated carried the wrong path");

    // 6. The snapshot was recorded in the plugin's `history` store.
    let log = caps_probe
        .db
        .read_log("history", &path)
        .expect("read history log");
    assert_eq!(
        log.len(),
        1,
        "expected exactly one snapshot, got {}",
        log.len()
    );
    let recorded_hash = log[0]
        .get("hash")
        .and_then(|h| h.as_str())
        .expect("hash field");
    assert_eq!(recorded_hash, expected_hash, "recorded hash mismatch");

    // 7. Re-emitting for unchanged content records nothing new (idempotency).
    kernel
        .emit_file_changed(path.clone(), "modify".to_owned())
        .await;
    // Give any (unexpected) second emission a chance to land, then assert silence.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let log2 = caps_probe
        .db
        .read_log("history", &path)
        .expect("read history log again");
    assert_eq!(
        log2.len(),
        1,
        "unchanged content must not append a second snapshot"
    );

    // 8. Deterministic teardown.
    kernel.shutdown().await;
    assert_eq!(
        kernel.fiber_count(),
        0,
        "roster must be empty after shutdown"
    );
}
