//! Phase 0 spike (roadmap P0-C, risk R1).
//!
//! Proves the exact cordis-core API we will use inside the Tauri host:
//! declare a typed `Event`, implement `Plugin`, `Context::spawn` it, dispatch
//! with `emit`, and deterministically `dispose` the `FiberHandle` so the
//! generation-owned listener is removed.
//!
//! Verified against cordis-core v0.6.x (upstream commit d77cf91).

use std::convert::Infallible;

use cordis_core::event::{observer_sync, ListenerRegistrationError};
use cordis_core::{BoxError, Context, Event, FiberState, Plugin, PreparedPlugin, Routing};

struct Ping;

impl Event for Ping {
    const NAME: &'static str = "ping";
    type Args = String;
    type Output = ();
}

struct Echo;

struct EchoInput;

impl Plugin for Echo {
    type Config = ();
    type Input = EchoInput;
    type PrepareError = Infallible;
    type ApplyError = ListenerRegistrationError;

    fn prepare(&self, (): ()) -> Result<EchoInput, Infallible> {
        Ok(EchoInput)
    }

    async fn apply(&self, ctx: Context, _input: &EchoInput) -> Result<(), Self::ApplyError> {
        // Listener is owned by this fiber's generation; dispose removes it.
        let _listener = ctx.on::<Ping, _>(observer_sync(|_, name| {
            println!("  hello, {name}");
            Ok::<_, Infallible>(())
        }))?;
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), BoxError> {
    let ctx = Context::new();

    let input = Echo.prepare(())?;
    let sealed = PreparedPlugin::from_input(Echo, input);
    let handle = ctx.spawn(sealed).await?;

    match handle.ready().await? {
        FiberState::Active => println!("[ok] Echo fiber Active"),
        other => println!("[warn] Echo fiber state: {other:?}"),
    }

    println!("-- emit #1 (expect a greeting)");
    ctx.emit::<Ping>(Routing::Unscoped, "world".into()).await?;

    handle.dispose().await?;
    println!("[ok] fiber disposed");

    println!("-- emit #2 (expect silence: listener died with the fiber)");
    ctx.emit::<Ping>(Routing::Unscoped, "nobody".into()).await?;

    println!("[done] cordis boot spike OK");
    Ok(())
}
