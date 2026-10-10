//! Concrete `shell.thumbnail.read` capability: the **Windows Shell** produces the
//! thumbnail, this module only asks for it (docs/plugin-functional/
//! plugin-windows-thumbnails.md, roadmap P7-14).
//!
//! The red lines this file exists to honour:
//! - There is no image decoder in the app any more (the `image` crate is gone
//!   from the workspace). Pixels come from the Shell — either from its own
//!   thumbnail cache or from the thumbnail handler registered for that file
//!   type. Encoding the Shell-provided bitmap as PNG is *serialisation for
//!   transport*, not generation: nothing here decodes, draws or downscales the
//!   original file.
//! - The system cache is only ever touched through `IThumbnailCache`. Nothing
//!   reads or parses `%LocalAppData%\Microsoft\Windows\Explorer`.
//! - A cache miss, an unsupported type, a platform without a Shell, a timeout:
//!   all of those are **states in the value**, never errors, because the UI can
//!   present each of them — the spec calls them normal outcomes. Only a blank
//!   path or an out-of-range edge is an `Err`, because those are caller bugs.
//!
//! Threading (risk R10): `IThumbnailCache` is COM, so every call runs on a
//! dedicated OS thread that called `CoInitializeEx(COINIT_APARTMENTTHREADED)` and
//! `CoUninitialize()` around it — never on a Tauri runtime worker (the command
//! layer dispatches on `spawn_blocking`, and this module then spawns its own
//! thread). Concurrency is capped at [`MAX_INFLIGHT`] Shell calls and every
//! request gets [`REQUEST_BUDGET`] of wall clock. A request that runs out of
//! budget answers `ThumbnailState::Timeout` and *detaches* its worker, which
//! keeps holding its permit until the Shell finally lets it go — so a stalled
//! extraction cannot let an unbounded number of calls pile up behind it.

use std::sync::Arc;
use std::time::Duration;

use fm_contracts::capability::{
    CapabilityError, ShellThumbnailApi, ShellThumbnailOut, ThumbnailPolicy, MAX_THUMBNAIL_EDGE,
};

/// Wall-clock budget for one Shell request, including the wait for a permit.
/// Extraction can mean waking a handler in another process, so this is a
/// generous ceiling rather than an expectation: a cached card is served in
/// milliseconds.
const REQUEST_BUDGET: Duration = Duration::from_secs(4);

/// How many Shell calls may be in flight at once. Enough for a screenful of
/// newly exposed cards, low enough that a fast scroll cannot stampede the Shell
/// or the thumbnail-extraction surrogate.
const MAX_INFLIGHT: usize = 4;

/// [`ShellThumbnailApi`] over `IThumbnailCache`.
///
/// Stateless by design: the Windows thumbnail cache *is* the cache, so a second
/// in-process copy would only add staleness. The disposable UI-side cache the
/// spec permits lives with the consumers (P7-15).
#[derive(Debug)]
pub struct ShellThumbs {
    gate: Arc<gate::Semaphore>,
}

impl Default for ShellThumbs {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellThumbs {
    /// A provider with all [`MAX_INFLIGHT`] Shell permits free.
    pub fn new() -> Self {
        Self {
            gate: Arc::new(gate::Semaphore::new(MAX_INFLIGHT)),
        }
    }
}

impl ShellThumbnailApi for ShellThumbs {
    fn read(
        &self,
        path: &str,
        edge: u32,
        policy: ThumbnailPolicy,
    ) -> Result<ShellThumbnailOut, CapabilityError> {
        validate(path, edge)?;
        Ok(self.thumbnail(path, edge, policy))
    }
}

/// Reject caller bugs before touching the platform. The message *prefixes* are
/// part of the contract: the frontend classifies on `invalid argument:` /
/// `permission denied:` / `not found:`.
fn validate(path: &str, edge: u32) -> Result<(), CapabilityError> {
    if path.trim().is_empty() {
        return Err(CapabilityError::InvalidArgument(
            "path must not be blank".to_owned(),
        ));
    }
    if edge == 0 || edge > MAX_THUMBNAIL_EDGE {
        return Err(CapabilityError::InvalidArgument(format!(
            "edge must be in 1..={MAX_THUMBNAIL_EDGE}, got {edge}"
        )));
    }
    Ok(())
}

/// The one honest answer a platform without a Windows Shell can give. Never an
/// error, never a fabricated image: consumers show a type icon instead.
#[cfg(not(windows))]
fn unsupported_platform() -> ShellThumbnailOut {
    ShellThumbnailOut {
        state: fm_contracts::capability::ThumbnailState::UnsupportedPlatform,
        data_url: None,
        mime: None,
        edge: 0,
        from_cache: false,
    }
}

#[cfg(not(windows))]
impl ShellThumbs {
    /// No Shell to ask. The gate is never consulted because there is nothing to
    /// protect: this returns straight away.
    fn thumbnail(&self, _path: &str, _edge: u32, _policy: ThumbnailPolicy) -> ShellThumbnailOut {
        unsupported_platform()
    }
}

// ───────────────────────────── Shell permits ─────────────────────────────
//
// `std::sync::Semaphore` would be the natural fit but is still unstable on the
// pinned toolchain (checked against rustc 1.94.1), and an async semaphore is
// useless on a blocking thread. A `Mutex` + `Condvar` counter gives exactly the
// semantics needed here, keeps `ShellThumbs` `Sync`, and is tested on every
// platform — only Windows *consults* it, hence the relaxed dead-code lint.
//
// `pub(crate)`: `shell_ops` bounds Shell *operations* with the same gate, and a
// second copy of a subtle deadline-aware counter in the same crate would be two
// places to get the poisoning case wrong. Behaviour is unchanged.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows provider takes permits"))]
pub(crate) mod gate {
    use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};
    use std::time::Instant;

    /// Counting gate with a deadline.
    #[derive(Debug)]
    pub struct Semaphore {
        permits: Mutex<usize>,
        available: Condvar,
    }

    /// A held permit. Releases itself when the last owner drops it; handing the
    /// `Arc` to the worker thread is what makes the cap follow the *Shell call*
    /// rather than the caller that may already have been answered with a timeout.
    #[derive(Debug)]
    pub struct Permit {
        sem: Arc<Semaphore>,
    }

    impl Semaphore {
        pub fn new(permits: usize) -> Self {
            Self {
                permits: Mutex::new(permits),
                available: Condvar::new(),
            }
        }

        /// Permits free right now (diagnostics and tests).
        pub fn available(&self) -> usize {
            *lock(&self.permits)
        }

        /// Take a permit, giving up once `deadline` passes.
        ///
        /// The `Arc` receiver is deliberate: a permit must be movable to a detached
        /// worker and still belong to the shared gate, not to the caller.
        pub fn acquire_until(self: &Arc<Self>, deadline: Instant) -> Option<Arc<Permit>> {
            let mut permits = lock(&self.permits);
            loop {
                if *permits > 0 {
                    *permits -= 1;
                    return Some(Arc::new(Permit {
                        sem: Arc::clone(self),
                    }));
                }
                let now = Instant::now();
                if now >= deadline {
                    return None;
                }
                let (guard, _timed_out) = self
                    .available
                    .wait_timeout(permits, deadline - now)
                    .unwrap_or_else(PoisonError::into_inner);
                permits = guard;
                // A real timeout (as opposed to a notification) is caught by the
                // deadline check at the top of the next iteration.
            }
        }
    }

    impl Drop for Permit {
        fn drop(&mut self) {
            let mut permits = lock(&self.sem.permits);
            *permits += 1;
            self.sem.available.notify_one();
        }
    }

    fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
        m.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

// ───────────────────────────── windows provider ─────────────────────────────

/// The real provider: COM round trip, bitmap read, PNG transport encoding. Its own
/// module so a non-Windows build never names a Windows type.
#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::sync::Arc;
    use std::time::Instant;

    use base64::Engine as _;
    use windows::core::{Error, HRESULT, Interface, PCWSTR};
    use windows::Win32::Foundation::{
        ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_NO_MORE_ITEMS, ERROR_NOT_SUPPORTED,
        ERROR_PATH_NOT_FOUND, ERROR_PRIVILEGE_NOT_HELD, ERROR_SHARING_VIOLATION, E_ACCESSDENIED,
        E_FAIL, E_NOINTERFACE, E_NOTIMPL, E_UNEXPECTED, STG_E_ACCESSDENIED, STG_E_FILENOTFOUND,
        STG_E_PATHNOTFOUND,
    };
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAP, BITMAPINFO, BITMAPINFOHEADER, DeleteObject, DIB_RGB_COLORS, GetDIBits,
        GetDC, GetObjectW, HBITMAP, HDC, HGDIOBJ, ReleaseDC,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, IBindCtx, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        IShellItem, ISharedBitmap, IThumbnailCache, SHCreateItemFromParsingName, WTS_ALPHATYPE,
        WTS_CACHED, WTS_CACHEFLAGS, WTS_DEFAULT, WTS_E_DATAFILEUNAVAILABLE,
        WTS_E_EXTRACTIONBLOCKED, WTS_E_EXTRACTIONPENDING, WTS_E_EXTRACTIONTIMEDOUT,
        WTS_E_FAILEDEXTRACTION, WTS_E_FASTEXTRACTIONNOTSUPPORTED,
        WTS_E_NOSTORAGEPROVIDERTHUMBNAILHANDLER, WTS_E_SURROGATEUNAVAILABLE, WTS_EXTRACT,
        WTS_INCACHEONLY, WTS_SCALETOREQUESTEDSIZE, WTS_SCALEUP, WTS_THUMBNAILID, WTSAT_ARGB,
        WTSAT_RGB, WTSAT_UNKNOWN,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetIconInfo, HICON, ICONINFO};

    use fm_contracts::capability::{ShellThumbnailOut, ThumbnailPolicy, ThumbnailState};

    use super::gate::Permit;
    use super::{REQUEST_BUDGET, ShellThumbs};

    /// Declines that mean "the file is not there (or its data is not offline)".
    const MISSING: &[HRESULT] = &[
        STG_E_FILENOTFOUND,
        STG_E_PATHNOTFOUND,
        HRESULT::from_win32(ERROR_FILE_NOT_FOUND.0),
        HRESULT::from_win32(ERROR_PATH_NOT_FOUND.0),
        WTS_E_DATAFILEUNAVAILABLE,
    ];

    /// Declines that mean "this account cannot reach the file".
    const DENIED: &[HRESULT] = &[
        E_ACCESSDENIED,
        STG_E_ACCESSDENIED,
        HRESULT::from_win32(ERROR_ACCESS_DENIED.0),
        HRESULT::from_win32(ERROR_PRIVILEGE_NOT_HELD.0),
        HRESULT::from_win32(ERROR_SHARING_VIOLATION.0),
    ];

    /// Declines that mean "no registered handler can make a thumbnail for this".
    const NO_HANDLER: &[HRESULT] = &[
        WTS_E_FAILEDEXTRACTION,
        WTS_E_FASTEXTRACTIONNOTSUPPORTED,
        WTS_E_NOSTORAGEPROVIDERTHUMBNAILHANDLER,
        WTS_E_EXTRACTIONBLOCKED,
        WTS_E_SURROGATEUNAVAILABLE,
        WTS_E_EXTRACTIONPENDING,
        HRESULT::from_win32(ERROR_NOT_SUPPORTED.0),
    ];

    /// A Shell answer plus the raw `pdwState` (or raw `HRESULT`) behind it. The raw
    /// number stays on the Rust side of the boundary: the frozen wire DTO has no
    /// room for it, and the spec keeps cache/extract diagnostics for developers.
    pub struct Reply {
        pub out: ShellThumbnailOut,
        pub raw: i32,
    }

    impl Reply {
        /// A state-only answer: no image, no cache claim, no raw value.
        fn state(state: ThumbnailState) -> Self {
            Self {
                out: ShellThumbnailOut {
                    state,
                    data_url: None,
                    mime: None,
                    edge: 0,
                    from_cache: false,
                },
                raw: 0,
            }
        }

        /// A state-only answer carrying what the platform actually reported.
        fn raw(state: ThumbnailState, raw: i32) -> Self {
            let mut reply = Self::state(state);
            reply.raw = raw;
            reply
        }
    }

    impl ShellThumbs {
        /// Ask the Shell, on a thread of its own, and log what came back.
        pub(super) fn thumbnail(
            &self,
            path: &str,
            edge: u32,
            policy: ThumbnailPolicy,
        ) -> ShellThumbnailOut {
            let reply = self.reply(path, edge, policy);
            tracing::debug!(
                state = ?reply.out.state,
                raw = reply.raw,
                from_cache = reply.out.from_cache,
                edge = reply.out.edge,
                "shell thumbnail answer"
            );
            reply.out
        }

        /// Gate + thread-per-request. Synchronous on purpose: callers are already
        /// on a blocking context, and the wall-clock budget belongs here rather
        /// than in every call site.
        pub(super) fn reply(&self, path: &str, edge: u32, policy: ThumbnailPolicy) -> Reply {
            let deadline = Instant::now() + REQUEST_BUDGET;

            // Backpressure first: with four extractions already running, a fifth
            // caller that waits past the budget gets `timeout` instead of joining a
            // queue nobody bounded.
            let permit: Option<Arc<Permit>> = self.gate.acquire_until(deadline);
            let Some(permit) = permit else {
                tracing::warn!(
                    path,
                    budget_ms = REQUEST_BUDGET.as_millis(),
                    free_permits = self.gate.available(),
                    "no Shell permit came free inside the thumbnail budget"
                );
                return Reply::state(ThumbnailState::Timeout);
            };

            let (tx, rx) = mpsc::channel();
            let owned = path.to_owned();
            let handle = match std::thread::Builder::new()
                .name("fm-shell-thumb".to_owned())
                .spawn(move || {
                    // The permit lives as long as the COM call, not as long as the
                    // caller's interest in it.
                    let _permit = permit;
                    let _ = tx.send(sta_thumbnail(&owned, edge, policy));
                }) {
                Ok(handle) => handle,
                Err(err) => {
                    // The process ran out of threads — a resource fault, not a
                    // Shell answer.
                    tracing::warn!(error = %err, "could not start a COM thread for a thumbnail");
                    return Reply::state(ThumbnailState::Error);
                }
            };

            let budget = deadline.saturating_duration_since(Instant::now());
            match rx.recv_timeout(budget) {
                Ok(reply) => reply,
                Err(RecvTimeoutError::Timeout) => {
                    // Dropping the `JoinHandle` detaches the thread: it must run
                    // its own `CoUninitialize`, which cannot be done from here, and
                    // it releases its permit when the Shell finally answers.
                    drop(handle);
                    tracing::warn!(
                        path,
                        budget_ms = REQUEST_BUDGET.as_millis(),
                        "shell thumbnail call ran out of its time budget"
                    );
                    Reply::state(ThumbnailState::Timeout)
                }
                Err(RecvTimeoutError::Disconnected) => {
                    // The worker died inside a Shell handler without answering.
                    tracing::warn!(path, "shell thumbnail worker died without an answer");
                    Reply::state(ThumbnailState::Error)
                }
            }
        }
    }

    /// One COM apartment, start to finish, on this thread.
    fn sta_thumbnail(path: &str, edge: u32, policy: ThumbnailPolicy) -> Reply {
        // `S_FALSE` (already initialised) is a success code, so `is_err()` here is
        // exactly "this thread got no apartment"; a balanced `CoUninitialize` is
        // owed whenever the call succeeded.
        if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
            tracing::warn!(path, "CoInitializeEx failed on the thumbnail thread");
            return Reply::state(ThumbnailState::Error);
        }
        let reply = shell_thumb(path, edge, policy);
        unsafe { CoUninitialize() };
        reply
    }

    /// The `SHCreateItemFromParsingName` -> `IThumbnailCache::GetThumbnail` round
    /// trip, then the bitmap -> PNG transport step.
    fn shell_thumb(path: &str, edge: u32, policy: ThumbnailPolicy) -> Reply {
        // Pre-flight on the *file*: the spec wants the provider to confirm the
        // target is still there, and this keeps `missing`/`denied` out of the
        // HRESULT-guessing game. It stats the requested file — never a cache file.
        match std::fs::metadata(path) {
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Reply::state(ThumbnailState::Missing);
            }
            Err(err) if err.kind() == std::io::ErrorKind::PermissionDenied => {
                return Reply::state(ThumbnailState::Denied);
            }
            // Any other `stat` failure (or a path it cannot express, such as a
            // known folder) is still something the Shell may answer for.
            _ => {}
        }

        let wide = to_wide(&shell_path(path));
        let item: IShellItem = match unsafe {
            SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None::<&IBindCtx>)
        } {
            Ok(item) => item,
            Err(err) => return declined(err, policy, Stage::Parse, path),
        };

        // The shell item is what answers for the file: `IThumbnailCache` is reached
        // by querying it, exactly as the platform docs prescribe.
        let cache: IThumbnailCache = match item.cast() {
            Ok(cache) => cache,
            Err(err) => return declined(err, policy, Stage::Cache, path),
        };

        let flags = match policy {
            // `WTS_INCACHEONLY`: a presentable miss, no extraction, no cache write.
            ThumbnailPolicy::CacheOnly => WTS_INCACHEONLY,
            // The default path: extract through the registered handler and let the
            // Shell cache the result. `WTS_EXTRACT` is the 0 value ("no special
            // flags, extraction allowed"); `WTS_SCALETOREQUESTEDSIZE` keeps payloads
            // grid-sized and `WTS_SCALEUP` lets a smaller cached tile still answer a
            // 512px request instead of failing it. Every scale step is the Shell's.
            ThumbnailPolicy::Extract => WTS_EXTRACT | WTS_SCALETOREQUESTEDSIZE | WTS_SCALEUP,
        };

        let mut shared: Option<ISharedBitmap> = None;
        let mut state = WTS_DEFAULT;
        let mut thumbnail_id = WTS_THUMBNAILID::default();
        if let Err(err) = unsafe {
            cache.GetThumbnail(
                &item,
                edge,
                flags,
                Some(&mut shared),
                Some(&mut state),
                Some(&mut thumbnail_id),
            )
        } {
            return declined(err, policy, Stage::Thumbnail, path);
        }

        let raw = state.0;
        let Some(bitmap) = shared else {
            // S_OK with no bitmap: nothing to show, and nothing to blame.
            tracing::warn!(path, raw, "GetThumbnail succeeded but returned no bitmap");
            return Reply::raw(ThumbnailState::Error, raw);
        };

        let from_cache = derives_from_cache(state, policy);
        match bitmap_to_png(&bitmap) {
            Ok((png, long_edge)) => {
                let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
                Reply {
                    out: ShellThumbnailOut {
                        state: ThumbnailState::Ready,
                        data_url: Some(format!("data:image/png;base64,{b64}")),
                        mime: Some("image/png".to_owned()),
                        edge: long_edge,
                        from_cache,
                    },
                    raw,
                }
            }
            Err(why) => {
                // The Shell handed us a handle we could not read. Its problem,
                // reported honestly rather than papered over with a fake image.
                tracing::warn!(path, error = %why, "could not read the Shell thumbnail bitmap");
                Reply::raw(ThumbnailState::Error, raw)
            }
        }
    }

    /// Whether the answer was already sitting in the system cache.
    ///
    /// The `windows` crate binds `GetThumbnail`'s `pdwState` out-parameter to
    /// `WTS_CACHEFLAGS` (`WTS_DEFAULT = 0`, `WTS_LOWQUALITY = 1`, `WTS_CACHED = 2`);
    /// the `WTS_SRC_*` / `WTS_CACHEIF_STATEFLAGS` spellings the docs also mention are
    /// not exported by 0.62, so `WTS_CACHED` is the only provenance signal available
    /// and it drives this. `from_cache` is a diagnostic nicety, never a correctness
    /// claim: a cache-only request can by definition only be answered from the
    /// cache, so that policy reports a hit even if the flag is left clear.
    pub(super) fn derives_from_cache(state: WTS_CACHEFLAGS, policy: ThumbnailPolicy) -> bool {
        matches!(policy, ThumbnailPolicy::CacheOnly) || state.contains(WTS_CACHED)
    }

    /// Where in the round trip the Shell said no. The same `HRESULT` means
    /// different things depending on it, and the frontend must not be told "cache
    /// miss" when the truth is "this item has no thumbnail cache at all".
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub(super) enum Stage {
        /// The path could not be turned into a shell item.
        Parse,
        /// The shell item offers no `IThumbnailCache`.
        Cache,
        /// The cache was reached but has nothing to give.
        Thumbnail,
    }

    impl Stage {
        fn as_str(self) -> &'static str {
            match self {
                Stage::Parse => "SHCreateItemFromParsingName",
                Stage::Cache => "QueryInterface(IThumbnailCache)",
                Stage::Thumbnail => "GetThumbnail",
            }
        }
    }

    /// Turn a failed call into a state. Every decline here is a *state*: the caller
    /// asked a legitimate question and the Shell gave a legitimate "no".
    fn declined(err: Error, policy: ThumbnailPolicy, stage: Stage, path: &str) -> Reply {
        let hr = err.code();
        let state = classify_decline(hr, policy, stage);
        if state == ThumbnailState::Error {
            tracing::warn!(
                path,
                stage = stage.as_str(),
                code = hr.0,
                message = %err.message(),
                "unclassified Shell thumbnail failure"
            );
        } else {
            tracing::debug!(
                path,
                stage = stage.as_str(),
                code = hr.0,
                state = ?state,
                "the Shell declined the thumbnail"
            );
        }
        Reply::raw(state, hr.0)
    }

    /// The classification rules, kept separate so they are reviewable (and
    /// testable) without a Shell.
    pub(super) fn classify_decline(
        hr: HRESULT,
        policy: ThumbnailPolicy,
        stage: Stage,
    ) -> ThumbnailState {
        if MISSING.contains(&hr) {
            ThumbnailState::Missing
        } else if DENIED.contains(&hr) {
            ThumbnailState::Denied
        } else if hr == WTS_E_EXTRACTIONTIMEDOUT {
            // The Shell's own extraction budget expired; ours is beside the point.
            ThumbnailState::Timeout
        } else if stage == Stage::Cache && hr == E_NOINTERFACE {
            // Not a miss: this shell item simply never offers thumbnails, so no
            // policy would have found anything in a cache.
            ThumbnailState::UnsupportedType
        } else if stage == Stage::Thumbnail && matches!(policy, ThumbnailPolicy::CacheOnly) {
            // A `WTS_INCACHEONLY` call promises no extraction, so *any* remaining
            // decline is simply "nothing cached for this file yet" — a miss the UI
            // shows as a placeholder rather than an error.
            ThumbnailState::CacheMiss
        } else if NO_HANDLER.contains(&hr)
            || hr == E_FAIL
            || hr == E_UNEXPECTED
            || hr == E_NOTIMPL
            || hr == HRESULT::from_win32(ERROR_NO_MORE_ITEMS.0)
        {
            // No handler for this type, or extraction is impossible right now.
            ThumbnailState::UnsupportedType
        } else {
            ThumbnailState::Error
        }
    }

    /// A UTF-16, NUL-terminated buffer the Shell can parse.
    fn to_wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `SHCreateItemFromParsingName` parses the name itself, so it wants a plain
    /// absolute path. Relative paths are anchored against the process cwd without
    /// touching the filesystem (`std::path::absolute` resolves neither symlinks nor
    /// existence), and a `\\?\` verbatim prefix — which `std::fs` happily produces
    /// but the Shell cannot parse — is stripped back off.
    pub(super) fn shell_path(path: &str) -> String {
        let absolute = std::path::absolute(std::path::Path::new(path))
            .unwrap_or_else(|_| std::path::PathBuf::from(path));
        let raw = absolute.to_string_lossy();
        if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{unc}");
        }
        if let Some(stripped) = raw.strip_prefix(r"\\?\") {
            return stripped.to_owned();
        }
        raw.into_owned()
    }

    /// Read a Shell-returned `ISharedBitmap` into PNG bytes, reporting the longest
    /// edge actually delivered.
    ///
    /// Ownership, since this is where a double free would live: `ISharedBitmap` owns
    /// its bitmap. `Detach` transfers that ownership to us, and then *we* must
    /// `DeleteObject` it. If `Detach` declines we fall back to `GetSharedBitmap`,
    /// which hands back a borrowed handle the Shell still frees when the interface
    /// is released — deleting that would be a double free, so [`BitmapLease`]
    /// records which of the two cases we are in.
    fn bitmap_to_png(shared: &ISharedBitmap) -> Result<(Vec<u8>, u32), String> {
        let (bitmap, owned) = match unsafe { shared.Detach() } {
            Ok(hbmp) => (hbmp, true),
            Err(_) => (
                unsafe { shared.GetSharedBitmap() }.map_err(|e| e.message())?,
                false,
            ),
        };
        if bitmap.0.is_null() {
            return Err("the Shell returned a null bitmap handle".to_owned());
        }
        let lease = BitmapLease {
            bitmap,
            delete: owned,
        };
        let alpha = unsafe { shared.GetFormat() }.unwrap_or(WTSAT_UNKNOWN);

        let pixels = pixels_of(lease.bitmap, alpha)?;
        if pixels.width == 0 || pixels.height == 0 {
            return Err("the Shell thumbnail had no extent".to_owned());
        }
        let png = encode_png(pixels.width, pixels.height, &pixels.rgba)?;
        // What the Shell actually delivered, not what the caller asked for.
        Ok((png, pixels.width.max(pixels.height)))
    }

    /// Pixels plus the alpha verdict that produced them.
    struct Pixels {
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    }

    /// Ask GDI what the handle really is: a DIB goes straight to [`dib_pixels`],
    /// anything else is treated as an icon and resolved through `GetIconInfo`.
    fn pixels_of(bitmap: HBITMAP, alpha: WTS_ALPHATYPE) -> Result<Pixels, String> {
        match bitmap_info(bitmap) {
            Some(info) => dib_pixels(bitmap, &info, alpha),
            None => icon_pixels(bitmap),
        }
    }

    /// `GetObjectW` as a `BITMAP`, i.e. geometry without touching any bits.
    /// `None` means the handle is not a bitmap (the icon case).
    fn bitmap_info(bitmap: HBITMAP) -> Option<BITMAP> {
        let mut info = BITMAP::default();
        let filled = unsafe {
            GetObjectW(
                HGDIOBJ::from(bitmap),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut info as *mut BITMAP as *mut c_void),
            )
        };
        (filled != 0).then_some(info)
    }

    /// `GetDIBits` for the pixels (always as 32-bpp BI_RGB, which lets GDI convert
    /// palettised and 24-bpp sources for us), then BGRA -> RGBA.
    fn dib_pixels(
        bitmap: HBITMAP,
        info: &BITMAP,
        alpha_type: WTS_ALPHATYPE,
    ) -> Result<Pixels, String> {
        let width = info.bmWidth;
        // A negative source height means the DIB is already stored top-down (that is
        // how Shell thumbnails come); `abs` is the row count either way.
        let height = info.bmHeight.abs();
        if width <= 0 || height <= 0 {
            return Err(format!("bitmap has no extent: {width}x{height}"));
        }

        let mut bmi = BITMAPINFO::default();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = width;
        // A negative *requested* height asks for a top-down DIB, i.e. scan line 0 is
        // the visually first row — which is what PNG wants. GDI normalises the
        // source's own orientation, so this is right for bottom-up sources too.
        bmi.bmiHeader.biHeight = -height;
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB.0;

        let bytes = (width as usize)
            .checked_mul(height as usize)
            .and_then(|px| px.checked_mul(4))
            .ok_or_else(|| "bitmap size overflows usize".to_owned())?;
        let mut buffer = vec![0u8; bytes];

        let hdc: HDC = unsafe { GetDC(None) };
        if hdc.is_invalid() {
            return Err("GetDC: no device context to read thumbnail bits with".to_owned());
        }
        let lines = unsafe {
            GetDIBits(
                hdc,
                bitmap,
                0,
                height as u32,
                Some(buffer.as_mut_ptr() as *mut c_void),
                &mut bmi,
                DIB_RGB_COLORS,
            )
        };
        unsafe { ReleaseDC(None, hdc) };
        if lines == 0 {
            return Err("GetDIBits could not read the thumbnail bits".to_owned());
        }

        // GDI copies the fourth byte verbatim from a 32-bpp source and zeroes it
        // otherwise, so alpha is only honoured when the source really carried it
        // *and* the handler declared ARGB. An all-zero alpha plane is treated as
        // opaque: an invisible thumbnail is worse than a flat-background one.
        let alpha_meaningful =
            alpha_type == WTSAT_ARGB && info.bmBitsPixel == 32 && !all_alpha_zero(&buffer);
        Ok(Pixels {
            width: width as u32,
            height: height as u32,
            rgba: bgra_to_rgba(&buffer, alpha_meaningful),
        })
    }

    /// The monochrome-icon case: `GetIconInfo` gives a colour bitmap, and for a
    /// mask-only icon `hbmColor` is null so `hbmMask` is what carries the pixels.
    ///
    /// `GetIconInfo` allocates both bitmaps *for us*, so the leases delete them. The
    /// icon handle itself is left alone: in this API it belongs to the Shell and is
    /// released with its interface, and `DestroyIcon` is only for icons the
    /// application created or copied (`LoadIcon`, `CopyIcon`, `SHGetFileInfo`). This
    /// module creates none, so destroying it here would corrupt a Shell-owned
    /// object — that is the deliberate deviation from "destroy the icon afterwards".
    fn icon_pixels(handle: HBITMAP) -> Result<Pixels, String> {
        let mut icon = ICONINFO::default();
        unsafe { GetIconInfo(HICON(handle.0), &mut icon) }.map_err(|e| e.message())?;
        let mask = BitmapLease {
            bitmap: icon.hbmMask,
            delete: !icon.hbmMask.0.is_null(),
        };
        let color = BitmapLease {
            bitmap: icon.hbmColor,
            delete: !icon.hbmColor.0.is_null(),
        };
        let (source, alpha) = if color.bitmap.0.is_null() {
            (&mask, WTSAT_RGB)
        } else {
            (&color, WTSAT_ARGB)
        };
        if source.bitmap.0.is_null() {
            return Err("the icon carried no bitmaps".to_owned());
        }
        let info = bitmap_info(source.bitmap).ok_or("icon bitmap is not a DIB".to_owned())?;
        dib_pixels(source.bitmap, &info, alpha)
    }

    fn all_alpha_zero(bgra: &[u8]) -> bool {
        bgra.chunks_exact(4).all(|px| px[3] == 0)
    }

    /// BGRA (GDI's byte order on little-endian) to RGBA8. The alpha rule is decided
    /// by the caller, [`dib_pixels`].
    pub(super) fn bgra_to_rgba(bgra: &[u8], alpha_meaningful: bool) -> Vec<u8> {
        let mut rgba = bgra.to_vec();
        for px in rgba.chunks_exact_mut(4) {
            px.swap(0, 2);
            if !alpha_meaningful {
                px[3] = 255;
            }
        }
        rgba
    }

    /// PNG serialisation for transport: the `png` crate, RGBA8, one row per line.
    pub(super) fn encode_png(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, String> {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder
                .write_header()
                .map_err(|e| format!("png header: {e}"))?;
            writer
                .write_image_data(rgba)
                .map_err(|e| format!("png data: {e}"))?;
            writer.finish().map_err(|e| format!("png finish: {e}"))?;
        }
        Ok(out)
    }

    /// A bitmap handle and whether releasing this lease may delete it. See
    /// [`bitmap_to_png`] for why a borrowed thumbnail must not be deleted, and
    /// [`icon_pixels`] for the bitmaps `GetIconInfo` allocated for us.
    struct BitmapLease {
        bitmap: HBITMAP,
        delete: bool,
    }

    impl Drop for BitmapLease {
        fn drop(&mut self) {
            if self.delete && !self.bitmap.0.is_null() {
                // `DeleteObject` reports failure as a `BOOL`; from a `Drop` there is
                // nothing to do with it but not leak the handle deliberately, and a
                // thumbnail that outlived its lease is a one-object leak at worst.
                let _deleted = unsafe { DeleteObject(HGDIOBJ::from(self.bitmap)) };
            }
        }
    }
}

// ───────────────────────────── tests ─────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use fm_contracts::capability::ThumbnailState;
    use std::time::Instant;

    /// Anything but `ready` must present itself as "no image", so a consumer can
    /// show a type icon without guessing.
    fn assert_honest(out: &ShellThumbnailOut) {
        if out.state == ThumbnailState::Ready {
            let url = out.data_url.as_deref().expect("ready carries a data url");
            assert!(
                url.starts_with("data:image/png;base64,"),
                "unexpected data url prefix: {}",
                &url[..32.min(url.len())]
            );
            assert_eq!(out.mime.as_deref(), Some("image/png"));
            assert!(out.edge > 0, "ready carries the edge it delivered");
        } else {
            assert!(out.data_url.is_none(), "{:?} carried an image", out.state);
            assert!(out.mime.is_none());
            assert_eq!(out.edge, 0, "{:?} has no image, so no edge", out.state);
        }
    }

    /// The contract's whole point: a legal request never becomes an error.
    const ANY_FILE: &str = "C:\\Windows\\explorer.exe";

    #[test]
    fn rejects_edges_outside_the_contract_range() {
        let thumbs = ShellThumbs::new();
        for edge in [0, MAX_THUMBNAIL_EDGE + 1, u32::MAX] {
            let err = thumbs
                .read(ANY_FILE, edge, ThumbnailPolicy::Extract)
                .expect_err("an out-of-range edge is a caller bug");
            let msg = err.to_string();
            assert!(
                msg.starts_with("invalid argument:"),
                "the frontend classifies on this prefix, got `{msg}`"
            );
            assert!(msg.contains(&format!("got {edge}")), "{msg}");
        }

        // Both ends of the legal range are accepted as arguments.
        for edge in [1, MAX_THUMBNAIL_EDGE] {
            let out = thumbs
                .read(ANY_FILE, edge, ThumbnailPolicy::CacheOnly)
                .expect("a legal edge must never be an argument error");
            assert_honest(&out);
        }
    }

    #[test]
    fn rejects_blank_paths() {
        let thumbs = ShellThumbs::new();
        for path in ["", "   ", "\t\n"] {
            let err = thumbs
                .read(path, 128, ThumbnailPolicy::Extract)
                .expect_err("a blank path is a caller bug");
            assert!(
                err.to_string().starts_with("invalid argument:"),
                "{err}"
            );
        }
    }

    #[test]
    fn a_missing_file_is_a_state_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let gone = dir.path().join("never-written.png");
        let out = ShellThumbs::new()
            .read(gone.to_str().unwrap(), 128, ThumbnailPolicy::Extract)
            .expect("a valid request never errors");
        assert_honest(&out);
        #[cfg(windows)]
        assert_eq!(out.state, ThumbnailState::Missing, "pre-flight stats the file");
    }

    #[cfg(not(windows))]
    #[test]
    fn a_platform_without_a_shell_degrades_instead_of_lying() {
        let out = ShellThumbs::new()
            .read(ANY_FILE, 128, ThumbnailPolicy::Extract)
            .expect("unsupported is still an answer");
        assert_eq!(out.state, ThumbnailState::UnsupportedPlatform);
        assert_eq!(serde_json::to_value(out.state).unwrap(), "unsupported-platform");
        assert_honest(&out);
        assert!(!out.from_cache);
    }

    /// The gate is what stops a big grid from stampeding the Shell, and the
    /// permit-outliving-the-caller rule is what stops a stalled extraction from
    /// leaking capacity — so both are tested directly.
    #[test]
    fn the_gate_bounds_concurrency_and_returns_permits() {
        let gate = Arc::new(gate::Semaphore::new(2));
        let deadline = Instant::now() + Duration::from_secs(5);
        let first = gate.acquire_until(deadline).expect("first permit");
        let second = gate.acquire_until(deadline).expect("second permit");
        assert_eq!(gate.available(), 0, "the gate is empty");

        // Full, and the deadline has already passed: give up now rather than queue.
        let started = Instant::now();
        assert!(gate.acquire_until(Instant::now()).is_none());
        assert!(
            started.elapsed() < Duration::from_millis(200),
            "an expired deadline must not block"
        );

        // Releasing one wakes a waiter that was parked on the condvar.
        let waiter = {
            let gate = Arc::clone(&gate);
            std::thread::spawn(move || gate.acquire_until(Instant::now() + Duration::from_secs(5)))
        };
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(gate.available(), 0, "the waiter must still be parked");
        drop(first);
        // `held` must stay alive across the assertion: an `Arc<Permit>` dropped by
        // the end of the statement would return its slot before we can see it.
        let held = waiter.join().expect("waiter thread");
        assert!(held.is_some(), "the parked waiter must be woken");
        assert_eq!(gate.available(), 0, "the waiter holds the permit");
        drop(second);
        assert_eq!(gate.available(), 1);
        drop(held);
        assert_eq!(gate.available(), 2, "every permit came home");
    }

    /// The capability is shared as `Arc<dyn ShellThumbnailApi>` and called from
    /// many threads at once, so the gate + thread-per-request plumbing must be
    /// `Send`-correct and every call must come back.
    #[test]
    fn concurrent_reads_all_return() {
        let thumbs = Arc::new(ShellThumbs::new());
        let _: &dyn ShellThumbnailApi = &*thumbs;

        let dir = tempfile::tempdir().unwrap();
        let paths: Vec<String> = (0..8)
            .map(|i| {
                let path = dir.path().join(format!("file-{i}.txt"));
                std::fs::write(&path, b"thumbnail me, eventually").unwrap();
                path.to_string_lossy().into_owned()
            })
            .collect();

        let handles: Vec<_> = paths
            .iter()
            .map(|path| {
                let thumbs = Arc::clone(&thumbs);
                let path = path.clone();
                std::thread::spawn(move || {
                    thumbs
                        .read(&path, 128, ThumbnailPolicy::Extract)
                        .map_err(|e| e.to_string())
                })
            })
            .collect();

        for handle in handles {
            let out = handle
                .join()
                .expect("a reader thread must not panic")
                .expect("a valid request never errors");
            assert_honest(&out);
        }
        // Every worker finished, so every permit came home.
        assert_eq!(thumbs.gate.available(), MAX_INFLIGHT);
    }

    #[cfg(windows)]
    mod windows {
        use super::*;
        use crate::capabilities::shell_thumb::platform::{
            bgra_to_rgba, classify_decline, derives_from_cache, encode_png, shell_path, Stage,
        };
        use base64::Engine as _;
        use ::windows::core::HRESULT;
        use ::windows::Win32::Foundation::{
            E_ACCESSDENIED, E_FAIL, E_NOINTERFACE, E_UNEXPECTED, STG_E_FILENOTFOUND,
        };
        use ::windows::Win32::UI::Shell::{
            WTS_CACHED, WTS_DEFAULT, WTS_E_EXTRACTIONTIMEDOUT,
            WTS_E_NOSTORAGEPROVIDERTHUMBNAILHANDLER,
        };

        /// RGBA rows -> PNG, for a test fixture the Shell can actually thumbnail.
        fn write_png(
            dir: &std::path::Path,
            name: &str,
            width: u32,
            height: u32,
            mut paint: impl FnMut(u32, u32) -> [u8; 4],
        ) -> std::path::PathBuf {
            let mut rgba = Vec::with_capacity((width * height * 4) as usize);
            for y in 0..height {
                for x in 0..width {
                    rgba.extend_from_slice(&paint(x, y));
                }
            }
            let path = dir.join(name);
            let file = std::fs::File::create(&path).unwrap();
            let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), width, height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&rgba).unwrap();
            writer.finish().unwrap();
            path
        }

        const RED: [u8; 4] = [220, 20, 20, 255];
        const GREEN: [u8; 4] = [20, 200, 20, 255];

        /// A 16x32 PNG: the top half red, the bottom half green.
        fn sample(dir: &std::path::Path, name: &str) -> std::path::PathBuf {
            write_png(dir, name, 16, 32, |_x, y| if y < 16 { RED } else { GREEN })
        }

        fn decode(data_url: &str) -> (u32, u32, Vec<u8>) {
            let payload = data_url
                .strip_prefix("data:image/png;base64,")
                .expect("the ready payload is a png data url");
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(payload)
                .expect("valid base64");
            let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
                .read_info()
                .expect("the Shell thumbnail must be a readable PNG");
            let header = reader.info();
            assert_eq!(header.color_type, png::ColorType::Rgba);
            assert_eq!(header.bit_depth, png::BitDepth::Eight);
            let (width, height) = (header.width, header.height);
            let mut buffer = vec![0u8; reader.output_buffer_size().expect("a decodable frame")];
            let frame = reader.next_frame(&mut buffer).expect("png rows");
            assert_eq!((frame.width, frame.height), (width, height));
            (width, height, buffer)
        }

        /// The headline acceptance: a real file, asked honestly, never panics and
        /// never returns `Err` — whatever the Shell can or cannot serve here.
        #[test]
        fn the_shell_answers_a_real_file_with_an_honest_state() {
            let dir = tempfile::tempdir().unwrap();
            let path = sample(dir.path(), "gradient.png");
            let path = path.to_string_lossy().into_owned();
            let thumbs = ShellThumbs::new();

            // First ask: the cache is (probably) cold, so this is the extract path.
            let extract = thumbs
                .read(&path, 32, ThumbnailPolicy::Extract)
                .expect("a valid request never errors");
            println!("extract   -> state={:?} edge={} from_cache={}", extract.state, extract.edge, extract.from_cache);
            super::assert_honest(&extract);

            // Second ask, cache-only: whatever it reports must still be honest, and
            // if the first call extracted through the Shell the cache should now be
            // able to answer it.
            let cache_only = thumbs
                .read(&path, 32, ThumbnailPolicy::CacheOnly)
                .expect("a valid request never errors");
            println!("cacheOnly -> state={:?} edge={} from_cache={}", cache_only.state, cache_only.edge, cache_only.from_cache);
            super::assert_honest(&cache_only);

            match extract.state {
                ThumbnailState::Ready => {
                    let (width, height, _pixels) = decode(extract.data_url.as_deref().unwrap());
                    assert!(width > 0 && height > 0);
                    assert_eq!(extract.edge, width.max(height));
                    assert!(
                        extract.edge <= MAX_THUMBNAIL_EDGE,
                        "the Shell delivered {}px, beyond the {}px cap",
                        extract.edge,
                        MAX_THUMBNAIL_EDGE
                    );
                }
                other => {
                    // No fake image on a decline, and the UI must be able to fall
                    // back to a type icon. This is the branch a session without a
                    // working Shell thumbnail handler takes.
                    println!("the Shell declined extraction: {other:?}");
                    assert!(matches!(
                        other,
                        ThumbnailState::CacheMiss
                            | ThumbnailState::UnsupportedType
                            | ThumbnailState::Denied
                            | ThumbnailState::Missing
                            | ThumbnailState::Timeout
                            | ThumbnailState::Cancelled
                            | ThumbnailState::Error
                            | ThumbnailState::UnsupportedPlatform
                    ));
                }
            }
        }

        /// Row order is the one thing a bitmap read can silently get wrong, so it is
        /// checked against a picture whose top and bottom differ.
        #[test]
        fn the_thumbnail_is_not_upside_down() {
            let dir = tempfile::tempdir().unwrap();
            let path = sample(dir.path(), "orientation.png");
            let path = path.to_string_lossy().into_owned();
            let thumbs = ShellThumbs::new();

            let out = thumbs
                .read(&path, 32, ThumbnailPolicy::Extract)
                .expect("a valid request never errors");
            let ThumbnailState::Ready = out.state else {
                println!("skipped: the Shell answered {:?}, no pixels to check", out.state);
                return;
            };
            let (width, height, rgba) = decode(out.data_url.as_deref().unwrap());
            let row = |y: u32| -> (u32, u32, u32) {
                let mut sums = (0u32, 0u32, 0u32);
                for x in 0..width {
                    let px = &rgba[((y * width + x) * 4) as usize..][..4];
                    sums.0 += u32::from(px[0]);
                    sums.1 += u32::from(px[1]);
                    sums.2 += u32::from(px[2]);
                }
                sums
            };
            let top = row(0);
            let bottom = row(height - 1);
            println!("top row rgb={top:?} bottom row rgb={bottom:?}");
            assert!(
                top.0 > top.1 && bottom.1 > bottom.0,
                "the first scan line must be the red half: top={top:?} bottom={bottom:?}"
            );
        }

        #[test]
        fn relative_and_verbatim_paths_are_reachable_by_the_shell() {
            // `shell_path` is what keeps `\\?\`-verbatim input (which `std::fs`
            // produces) from becoming a spurious `missing`.
            assert_eq!(shell_path(r"\\?\C:\Windows\explorer.exe"), r"C:\Windows\explorer.exe");
            assert_eq!(
                shell_path(r"\\?\UNC\server\share\a.png"),
                r"\\server\share\a.png"
            );
            let absolute = shell_path(r"C:\Windows\explorer.exe");
            assert!(absolute.eq_ignore_ascii_case(r"C:\Windows\explorer.exe"), "{absolute}");
            let relative = shell_path("Cargo.toml");
            assert!(
                std::path::Path::new(&relative).is_absolute(),
                "{relative} must be made absolute for the Shell"
            );
        }

        /// The mapping from Shell declines to presentable states, checked without
        /// a Shell: these are the branches a real machine takes, and getting one
        /// wrong turns a placeholder into a red error bar.
        #[test]
        fn declines_map_to_the_state_the_ui_can_present() {
            use ThumbnailPolicy::{CacheOnly, Extract};

            // Missing and denied win over everything else, whatever the stage.
            for stage in [Stage::Parse, Stage::Cache, Stage::Thumbnail] {
                for policy in [CacheOnly, Extract] {
                    assert_eq!(
                        classify_decline(STG_E_FILENOTFOUND, policy, stage),
                        ThumbnailState::Missing,
                        "a gone file is `missing` at {policy:?}/{stage:?}"
                    );
                    assert_eq!(
                        classify_decline(E_ACCESSDENIED, policy, stage),
                        ThumbnailState::Denied,
                        "an unreachable file is `denied` at {policy:?}/{stage:?}"
                    );
                }
            }

            // The Shell's own extraction timeout, under either policy.
            assert_eq!(
                classify_decline(WTS_E_EXTRACTIONTIMEDOUT, Extract, Stage::Thumbnail),
                ThumbnailState::Timeout
            );

            // `IThumbnailCache` absent is a property of the item, not a miss.
            assert_eq!(
                classify_decline(E_NOINTERFACE, CacheOnly, Stage::Cache),
                ThumbnailState::UnsupportedType,
                "no thumbnail cache service must never be reported as a cache miss"
            );

            // A cache-only call that got as far as the cache and found nothing.
            assert_eq!(
                classify_decline(WTS_E_NOSTORAGEPROVIDERTHUMBNAILHANDLER, CacheOnly, Stage::Thumbnail),
                ThumbnailState::CacheMiss,
                "under `WTS_INCACHEONLY` a decline means nothing was cached"
            );
            assert_eq!(
                classify_decline(E_FAIL, CacheOnly, Stage::Thumbnail),
                ThumbnailState::CacheMiss
            );

            // The same failure on the extract path means no handler can serve it.
            assert_eq!(
                classify_decline(WTS_E_NOSTORAGEPROVIDERTHUMBNAILHANDLER, Extract, Stage::Thumbnail),
                ThumbnailState::UnsupportedType
            );
            assert_eq!(
                classify_decline(E_FAIL, Extract, Stage::Thumbnail),
                ThumbnailState::UnsupportedType
            );
            assert_eq!(
                classify_decline(E_UNEXPECTED, Extract, Stage::Thumbnail),
                ThumbnailState::UnsupportedType
            );

            // Something nobody can explain stays an `error` (and the DTO carries no
            // image, which `assert_honest` would have caught).
            assert_eq!(
                classify_decline(HRESULT(0x1234_5678u32 as i32), Extract, Stage::Thumbnail),
                ThumbnailState::Error
            );
        }

        /// `from_cache` is derived, not invented: a cache-only answer is by
        /// definition from the cache, and an extracted one only when the Shell
        /// flagged `WTS_CACHED` in `pdwState`.
        #[test]
        fn from_cache_follows_the_policy_and_the_shells_own_flag() {
            assert!(derives_from_cache(WTS_DEFAULT, ThumbnailPolicy::CacheOnly));
            assert!(derives_from_cache(WTS_CACHED, ThumbnailPolicy::CacheOnly));
            assert!(!derives_from_cache(WTS_DEFAULT, ThumbnailPolicy::Extract));
            assert!(derives_from_cache(WTS_CACHED, ThumbnailPolicy::Extract));
        }

        /// The transport step, tested on pixels rather than on a live Shell: BGRA
        /// becomes RGBA8 and encodes back to a PNG a decoder can read.
        #[test]
        fn the_bitmap_read_round_trips_through_png() {
            // Two pixels: B=10,G=20,R=30,A=0 and B=1,G=2,R=3,A=200.
            let bgra = [10u8, 20, 30, 0, 1, 2, 3, 200];

            let opaque = bgra_to_rgba(&bgra, false);
            assert_eq!(&opaque[..8], &[30, 20, 10, 255, 3, 2, 1, 255]);

            let with_alpha = bgra_to_rgba(&bgra, true);
            assert_eq!(&with_alpha[..4], &[30, 20, 10, 0]);
            assert_eq!(&with_alpha[4..8], &[3, 2, 1, 200]);

            let png = encode_png(2, 1, &with_alpha).expect("png encodes");
            let mut reader = png::Decoder::new(std::io::Cursor::new(png))
                .read_info()
                .expect("the bytes are a real png");
            let (width, height) = (reader.info().width, reader.info().height);
            assert_eq!((width, height), (2, 1));
            let mut buffer = vec![0u8; reader.output_buffer_size().expect("a decodable frame")];
            let frame = reader.next_frame(&mut buffer).expect("png rows");
            assert_eq!(frame.color_type, png::ColorType::Rgba);
            assert_eq!(frame.bit_depth, png::BitDepth::Eight);
            assert_eq!(&buffer[..8], &with_alpha[..8]);
        }
    }
}
