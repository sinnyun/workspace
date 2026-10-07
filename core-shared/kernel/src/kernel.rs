//! cordis-rs kernel bootstrap (roadmap P1-6, risk R1) — **Tauri-free**.
//!
//! Design notes (verified against the cordis consumer guide):
//! - One [`Context::new()`] is the runtime root; every fiber spawns from it.
//! - Capabilities are published by a dedicated **provider fiber**; backend
//!   plugins declare them via `inject` and stay `Pending` until published, so
//!   spawn order is: provider -> backend plugins, each driven to quiescence with
//!   `ready()`.
//! - Lifecycle futures are driven on whatever async runtime the caller provides
//!   (the host uses `tauri::async_runtime`, tests use `#[tokio::test]`); we never
//!   `block_on` a cordis future on a tokio worker (consumer-guide rule 6) — boot
//!   is an `async fn`.
//! - Disposal is explicit and reverse-order via the retained roster (rule 6).
//!
//! The Tauri event bridge lives in the host crate, not here: it spawns its fiber
//! into the same kernel via the public [`Kernel::spawn_ready`], so this crate has
//! no GUI dependency and the backend slice stays headlessly testable.

use std::convert::Infallible;
use std::sync::Arc;

use cordis_core::service::ServicePublishError;
use cordis_core::{Context, FiberHandle, FiberState, Plugin, PreparedPlugin, Routing};
use fm_contracts::events::{FileChanged, FileChangedArgs};
use parking_lot::Mutex;

use crate::capabilities::CapabilitySet;

/// Fiber that publishes the atomic capabilities as cordis Services.
pub struct CapabilityProvider {
    caps: CapabilitySet,
}

impl Plugin for CapabilityProvider {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = ServicePublishError;

    fn name(&self) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("capability-provider")
    }

    fn prepare(&self, _: ()) -> Result<(), Infallible> {
        Ok(())
    }

    async fn apply(&self, ctx: Context, _: &()) -> Result<(), Self::ApplyError> {
        // Publications are dropped here; generation cleanup stays armed so they
        // remain visible until this fiber is disposed at teardown.
        self.caps.publish(&ctx)
    }
}

/// The running kernel: the cordis root Context plus the fiber roster (provider,
/// backend plugins, and any host-spawned bridge) retained for deterministic
/// reverse-order teardown.
pub struct Kernel {
    ctx: Context,
    roster: Arc<Mutex<Vec<FiberHandle>>>,
}

impl Kernel {
    /// Construct the root Context. Cheap and synchronous; no lifecycle yet.
    pub fn new() -> Self {
        Self {
            ctx: Context::new(),
            roster: Arc::new(Mutex::new(Vec::new())),
        }
    }

    /// The root Context (for host command-layer emissions and watch subscriptions).
    pub fn ctx(&self) -> &Context {
        &self.ctx
    }

    /// Boot the capability provider, then every enabled backend plugin. No Tauri
    /// dependency, so this is integration-testable headlessly. Each fiber is
    /// settled with `ready()` so a capability-dependent plugin converges once the
    /// provider has published.
    pub async fn start_backend(&self, caps: CapabilitySet) -> anyhow::Result<()> {
        // 0. Log bridge fiber publishes the cordis Runtime exporter that forwards
        //    kernel diagnostics (contained panics, dispatch/lifecycle errors)
        //    into `tracing`. Spawned first so everything below is observable.
        self.spawn_ready(crate::logger::LogBridgePlugin, ())
            .await?;

        // 1. Provider fiber publishes capabilities.
        let provider = CapabilityProvider { caps };
        self.spawn_ready(provider, ()).await?;

        // 2. Backend plugins from the build-time registry (manifest-driven config).
        for (name, config, spawn) in crate::registry::backend_plugins() {
            match spawn(&self.ctx, config).await {
                Ok(handle) => match handle.ready().await {
                    Ok(FiberState::Active) => {
                        tracing::info!(plugin = %name, "backend plugin active");
                        self.roster.lock().push(handle);
                    }
                    Ok(other) => {
                        tracing::warn!(plugin = %name, state = ?other, "backend plugin not active");
                        self.roster.lock().push(handle);
                    }
                    Err(e) => {
                        tracing::error!(plugin = %name, error = %e, "backend plugin ready failed")
                    }
                },
                Err(e) => tracing::error!(plugin = %name, error = %e, "backend plugin spawn failed"),
            }
        }
        Ok(())
    }

    /// Prepare, seal, spawn and settle one plugin fiber to quiescence, retaining
    /// it in the roster for reverse-order teardown. Public so the host can spawn
    /// its own Tauri-coupled fibers (e.g. the event bridge) into this kernel.
    pub async fn spawn_ready<P>(&self, plugin: P, config: P::Config) -> anyhow::Result<FiberHandle>
    where
        P: Plugin + Sync,
        P::PrepareError: std::fmt::Debug,
        P::ApplyError: std::fmt::Debug,
    {
        let handle = self.spawn_transient(plugin, config).await?;
        self.roster.lock().push(handle.clone());
        Ok(handle)
    }

    /// Prepare, seal, spawn and settle one plugin fiber WITHOUT retaining it in
    /// the roster. The caller owns teardown of the returned handle.
    pub async fn spawn_transient<P>(
        &self,
        plugin: P,
        config: P::Config,
    ) -> anyhow::Result<FiberHandle>
    where
        P: Plugin + Sync,
        P::PrepareError: std::fmt::Debug,
        P::ApplyError: std::fmt::Debug,
    {
        let input = plugin
            .prepare(config)
            .map_err(|e| anyhow::anyhow!("prepare failed: {e:?}"))?;
        let sealed = PreparedPlugin::from_input(plugin, input);
        let handle = self
            .ctx
            .spawn(sealed)
            .await
            .map_err(|e| anyhow::anyhow!("spawn failed: {e:?}"))?;
        handle
            .ready()
            .await
            .map_err(|e| anyhow::anyhow!("ready failed: {e:?}"))?;
        Ok(handle)
    }

    /// Emit a `file:changed` into the kernel (used by the watch layer and tests).
    pub async fn emit_file_changed(&self, path: String, kind: String) {
        let _ = self
            .ctx
            .emit::<FileChanged>(Routing::Unscoped, FileChangedArgs { path, kind })
            .await;
    }

    /// Number of fibers currently in the roster (test/observability aid).
    pub fn fiber_count(&self) -> usize {
        self.roster.lock().len()
    }

    /// Dispose every fiber in reverse spawn order (deterministic teardown).
    pub async fn shutdown(&self) {
        let handles: Vec<FiberHandle> = {
            let mut r = self.roster.lock();
            r.drain(..).rev().collect()
        };
        for h in handles {
            if let Err(e) = h.dispose().await {
                tracing::warn!(fiber = %h.name(), error = %e, "dispose error during shutdown");
            }
        }
    }
}

impl Default for Kernel {
    fn default() -> Self {
        Self::new()
    }
}
