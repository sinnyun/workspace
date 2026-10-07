//! cordis native [`Logger`] → host `tracing` bridge (roadmap P5-3).
//!
//! cordis-core routes its own diagnostics — contained plugin panics, event
//! dispatch failures, effect-cleanup errors, and lifecycle (era) transitions —
//! through a Runtime-wide exporter set rather than `tracing`/`log`. Registering
//! one exporter that forwards to the `tracing` subscriber the host installs
//! makes every kernel lifecycle event observable through the same pipeline as
//! the app's own `tracing` calls, with no extra crate (docs/06).
//!
//! The bridge is published from a dedicated fiber's `apply` (see
//! [`LogBridgePlugin`]): `Context::add_exporter` needs an active fiber
//! generation, and the exporter is generation-owned, so it lives exactly as
//! long as that fiber and is removed automatically on teardown.

use std::convert::Infallible;
use std::sync::Arc;

use cordis_core::effect::EffectRegistrationError;
use cordis_core::logger::{Exporter, Level, LogRecord};
use cordis_core::{Context, Plugin};

/// Forwards every cordis Runtime log record into the `tracing` subscriber.
pub struct TracingBridge;

impl Exporter for TracingBridge {
    fn export(&self, record: &LogRecord) {
        let channel = record.channel();
        let text = record.text();
        let level = record.level();
        if level == Level::Error {
            tracing::error!(target: "cordis", channel = %channel, "{text}");
        } else if level == Level::Warn {
            tracing::warn!(target: "cordis", channel = %channel, "{text}");
        } else if level == Level::Info {
            tracing::info!(target: "cordis", channel = %channel, "{text}");
        } else {
            tracing::debug!(target: "cordis", channel = %channel, "{text}");
        }
    }

    fn default_level(&self) -> Level {
        Level::Info
    }
}

/// Fiber that publishes the [`TracingBridge`] exporter for its generation.
///
/// Spawned first during boot so capability publication and backend plugin
/// lifecycle diagnostics are already captured. The apply returns immediately,
/// leaving the fiber `Active`; the exporter is reclaimed when the fiber is
/// disposed at shutdown (generation-owned cleanup).
pub struct LogBridgePlugin;

impl Plugin for LogBridgePlugin {
    type Config = ();
    type Input = ();
    type PrepareError = Infallible;
    type ApplyError = EffectRegistrationError;

    fn name(&self) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("log-bridge")
    }

    fn prepare(&self, _: ()) -> Result<(), Infallible> {
        Ok(())
    }

    async fn apply(&self, ctx: Context, _: &()) -> Result<(), Self::ApplyError> {
        // The returned registration is a move-only eager-removal handle;
        // dropping it is inert — the exporter stays owned by this fiber's
        // generation cleanup and lives until dispose.
        let _registration = ctx.add_exporter(Arc::new(TracingBridge))?;
        Ok(())
    }
}
