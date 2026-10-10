//! Concrete `shell.fileOperation` capability: the **Windows Shell** performs the
//! mutation, this module only asks it to (docs/plugin-functional/
//! plugin-file-ops.md, roadmap P7-17).
//!
//! The red line this file exists to hold: there is no copy loop, no recursive
//! directory walk, no collision merge and no delete implementation anywhere in
//! this app. `IFileOperation` does all of that, including recycle-bin semantics,
//! cross-volume behaviour and the system conflict dialog. Everything here is
//! request validation, apartment plumbing, and translation of the Shell's own
//! per-item verdicts into the frozen DTOs.
//!
//! Threading (risk R10, same shape as [`super::shell_thumb`]): one dedicated OS
//! thread **per operation**, running `CoInitializeEx(COINIT_APARTMENTTHREADED)`.
//! `PerformOperations` blocks for as long as the Shell is working — a bulk copy can
//! mean minutes, and its conflict dialog can wait on a human — so it can never run
//! on a Tauri/Tokio worker. `start()` therefore only *queues*: validate, hand the
//! request to its own thread, return the ack immediately, which is exactly what the
//! contract says an ack means ("the operation is queued, nothing has happened yet").
//! At most [`MAX_INFLIGHT_OPERATIONS`] Shell calls run at once, and an operation
//! that cannot get a slot inside [`QUEUE_BUDGET`] reports the truth as a terminal
//! result instead of piling up invisibly behind a stalled job.
//!
//! The Windows progress dialog stays the authoritative feedback UI (spec 系统调用
//! 方式 §4): `FOF_SILENT` and `FOF_SIMPLEPROGRESS` are never set, and `FOF_NOERRORUI`
//! is never set either — the docs say an error under that flag is treated as if the
//! user had chosen *Ignore*, which would hide from this very item list the failures
//! it exists to report.
//!
//! Cancellation, stated honestly: `IFileOperation`'s cancel-callback and
//! conflict-preference slots are **reserved** methods in `shobjidl_core` — outside
//! the documented API surface, and therefore absent from the `windows` 0.62 bindings
//! (verified: the generated `IFileOperation_Vtbl` names neither). So:
//! - [`ShellFileOperationApi::cancel`] records the request, publishes a `cancelling`
//!   progress event, and stops queueing anything the Shell has not been handed yet;
//!   the terminal result then reports which items actually moved.
//! - The abort a user can really perform is the **Cancel button of the Shell's own
//!   dialog**, detected through `GetAnyOperationsAborted` — the one documented
//!   cancellation signal. A `cancelled` state therefore means "the Shell stopped",
//!   never "we asked it to". Asking without the Shell stopping is logged, and the
//!   real outcome is still reported: our own request is never upgraded into a claim
//!   that work was undone.
//!
//! Progress is **indeterminate** by contract (`processed: 0`, `indeterminate: true`):
//! `IFileOperationProgressSink::UpdateProgress` counts items, not bytes, and showing
//! that as a percentage would be the fabricated number the spec forbids.
//!
//! Events cannot be delivered before boot finishes, and a failed emission is never a
//! reason to fail somebody's file operation: with no attached emitter the outcome is
//! logged with `tracing::warn!` instead.
//!
//! Non-Windows: neither a fake success nor an `InvalidArgument`, but a `failed` ack
//! plus a terminal event whose items all carry `unsupported` — see
//! [`ShellOps::start`] for why the contract's own vocabulary chose that channel, and
//! why there is no hand-written copy loop to fall back to.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use cordis_core::{Context, Event, Routing};
use fm_contracts::capability::{
    CapabilityError, FileConflictPolicy, FileFailureReason, FileItemOutcome, FileOperationIn,
    FileOperationItem, FileOperationKind, FileOperationOut, FileOperationProgress,
    FileOperationResult, FileOperationState, ShellFileOperationApi,
};
use fm_contracts::events::{ShellOperationDone, ShellOperationProgress};
use tokio::runtime::Handle;

use crate::capabilities::shell_thumb::gate;

/// How many Shell file operations may run at once. Shell jobs are user-visible and
/// serialise heavily on the disk anyway: two covers "copy these in, then move
/// those", and it stops a multi-select paste from opening a dozen system dialogs
/// the user can only read one at a time.
const MAX_INFLIGHT_OPERATIONS: usize = 2;

/// How long a queued operation waits for a Shell slot before it reports that it
/// never got one. Longer than a thumbnail budget on purpose: a bulk copy
/// legitimately runs for minutes, and a later job should run rather than fail.
const QUEUE_BUDGET: Duration = Duration::from_secs(5 * 60);

/// Windows compares paths case-insensitively; the check that rejects "destination
/// inside source" has to agree with the platform, or `C:\A` copied into `c:\a\b`
/// would pass a rule the Shell would then refuse.
const CASE_INSENSITIVE_PATHS: bool = cfg!(windows);

/// The cordis half of event delivery. `Context` and a runtime `Handle` are both
/// `Send`, which is what lets an operation's own thread drive an emission.
#[derive(Clone)]
struct Emitter {
    ctx: Context,
    handle: Handle,
}

impl Emitter {
    /// Drive one async cordis emission to completion from a non-runtime thread.
    ///
    /// `block_on` is legal here only because every caller is a dedicated OS thread
    /// (the operation's own) or a `spawn_blocking` thread (the host command layer);
    /// from a Tokio worker it would panic, which is why the host never calls
    /// straight from the async command body. Blocking also keeps the two events of
    /// one operation in order: `progress` must not overtake the `done` that
    /// supersedes it.
    fn drive<E>(&self, args: E::Args)
    where
        E: Event<Output = ()>,
        E::Args: Clone,
    {
        let ctx = self.ctx.clone();
        if let Err(err) = self
            .handle
            .block_on(async move { ctx.emit::<E>(Routing::Unscoped, args).await })
        {
            // Losing an event must never lose the operation it described; the
            // state is still in the log for a developer to read.
            tracing::warn!(
                event = E::NAME,
                error = %err,
                "shell operation event was not delivered"
            );
        }
    }
}

/// A live operation: its cancel flag plus what `cancel()` needs in order to publish
/// a well-formed progress event for it.
struct LiveOperation {
    cancel: Arc<AtomicBool>,
    total: u32,
    request_token: Option<String>,
}

/// The state `ShellOps` shares with its operation threads. The capability is handed
/// out as `Arc<dyn ShellFileOperationApi>` but `start(&self)` cannot upgrade `&self`,
/// so the threads own this `Arc` directly.
struct Shared {
    gate: Arc<gate::Semaphore>,
    live: Mutex<HashMap<String, LiveOperation>>,
    emitter: Mutex<Option<Emitter>>,
    next_id: AtomicU64,
}

impl Shared {
    fn emitter(&self) -> Option<Emitter> {
        lock(&self.emitter).clone()
    }

    /// Publish an indeterminate progress tick, if anything is listening.
    fn progress(&self, args: FileOperationProgress) {
        match self.emitter() {
            Some(emitter) => emitter.drive::<ShellOperationProgress>(args),
            None => tracing::warn!(
                operation_id = %args.operation_id,
                state = ?args.state,
                "no event emitter attached yet: shell operation progress was dropped"
            ),
        }
    }

    /// Publish the terminal result — the only place the truth about an operation
    /// lands — so a missing emitter is logged with the whole payload.
    fn finish(&self, result: FileOperationResult) {
        match self.emitter() {
            Some(emitter) => emitter.drive::<ShellOperationDone>(result),
            None => tracing::warn!(
                result = ?result,
                "no event emitter attached yet: shell operation result was dropped"
            ),
        }
    }

    /// Read a live operation without retiring it: a cancel must not remove the
    /// entry, because the operation is still running and its own thread has to
    /// report the terminal result.
    fn peek(&self, operation_id: &str) -> Option<LiveOperation> {
        lock(&self.live).get(operation_id).map(|live| LiveOperation {
            cancel: Arc::clone(&live.cancel),
            total: live.total,
            request_token: live.request_token.clone(),
        })
    }

    fn retire(&self, operation_id: &str) {
        lock(&self.live).remove(operation_id);
    }
}

/// Removes an operation from the live table whatever happens to its thread, so a
/// panicking Shell call cannot leave `cancel()` answering `true` forever.
struct LiveGuard {
    shared: Arc<Shared>,
    operation_id: String,
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.shared.retire(&self.operation_id);
    }
}

/// [`ShellFileOperationApi`] over Windows `IFileOperation`.
pub struct ShellOps {
    shared: Arc<Shared>,
}

impl Default for ShellOps {
    fn default() -> Self {
        Self::new()
    }
}

impl ShellOps {
    /// A provider with all [`MAX_INFLIGHT_OPERATIONS`] slots free and no event
    /// emitter (valid: results are then logged instead of published).
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                gate: Arc::new(gate::Semaphore::new(MAX_INFLIGHT_OPERATIONS)),
                live: Mutex::new(HashMap::new()),
                emitter: Mutex::new(None),
                next_id: AtomicU64::new(0),
            }),
        }
    }

    /// Attach the cordis context and runtime that carry `shell:operation:*` events.
    ///
    /// Called once by `CapabilitySet::publish`, which runs inside the async boot and
    /// so can legitimately name `Handle::current()`. Safe to call late: an operation
    /// that started before this simply had its outcome logged.
    pub fn attach(&self, ctx: Context, handle: Handle) {
        *lock(&self.shared.emitter) = Some(Emitter { ctx, handle });
    }

    /// `op-1`, `op-2`, … A monotonic counter is enough: an id only has to be unique
    /// among live operations, and a readable ordinal is what ties a log line back to
    /// a UI card.
    fn next_operation_id(&self) -> String {
        let n = self.shared.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        format!("op-{n}")
    }

    /// The ack. `queued` because nothing has happened yet, `indeterminate` because
    /// the Shell gives us no trustworthy percentage — the contract states both.
    fn acknowledge(&self, plan: &Plan, operation_id: &str, state: FileOperationState) -> FileOperationOut {
        FileOperationOut {
            operation_id: operation_id.to_owned(),
            state,
            total: plan.total(),
            indeterminate: state != FileOperationState::Failed,
        }
    }
}

impl ShellFileOperationApi for ShellOps {
    fn start(&self, req: &FileOperationIn) -> Result<FileOperationOut, CapabilityError> {
        // Validation lives here, in front of the platform boundary: the spec makes
        // the Rust host the thing that rejects a dangerous request ("Rust host 校验
        // … 危险自包含关系"), so a UI bug cannot become a destructive Shell call.
        let plan = validate(req)?;
        let operation_id = self.next_operation_id();
        let cancel = Arc::new(AtomicBool::new(false));
        lock(&self.shared.live).insert(
            operation_id.clone(),
            LiveOperation {
                cancel: Arc::clone(&cancel),
                total: plan.total(),
                request_token: plan.request_token.clone(),
            },
        );
        // Built before the platform call: dropping it (including on a thread-spawn
        // failure or a panic) is what retires the operation.
        let guard = LiveGuard {
            shared: Arc::clone(&self.shared),
            operation_id: operation_id.clone(),
        };

        #[cfg(windows)]
        {
            let out = self.acknowledge(&plan, &operation_id, FileOperationState::Queued);
            let shared = Arc::clone(&self.shared);
            return match platform::dispatch(shared, plan, operation_id, cancel, guard) {
                Ok(()) => Ok(out),
                Err(err) => {
                    // No thread means no Shell call and no future event, so the ack
                    // has to say so; `queued` would be a lie.
                    tracing::warn!(
                        error = %err,
                        "could not start a COM thread for a shell operation"
                    );
                    Err(CapabilityError::Io(
                        "无法启动 Shell 操作线程，请稍后重试".to_owned(),
                    ))
                }
            };
        }

        #[cfg(not(windows))]
        {
            // The chosen degradation, and why this way round: `start`'s own contract
            // doc says everything that is not a caller bug — "including 'the Shell
            // refused'" — arrives through the result events, and
            // `FileFailureReason::Unsupported` exists precisely for "this platform has
            // no Shell operation engine". `Err` is reserved for requests the UI should
            // never have sent, and `InvalidArgument` would also be factually wrong:
            // the request is fine, the platform is not.
            //
            // What we do NOT do is fall back to `std::fs`/`fs_extra` (spec 存储与平台
            // 边界: 非 Windows 不自动退回自写复制) — the app has no second file-mutation
            // engine to fall back *to*, which is the entire point of this design.
            let items: Vec<FileOperationItem> = plan
                .items_to_report()
                .into_iter()
                .map(|source| {
                    refused_item(
                        &source,
                        FileFailureReason::Unsupported,
                        "此平台没有原生 Shell 文件操作引擎",
                    )
                })
                .collect();
            let result = build_result(&plan, &operation_id, items, false, true, false);
            tracing::warn!(
                operation_id = %operation_id,
                op = ?plan.op,
                "no native Shell provider on this platform: operation reported as failed"
            );
            self.shared.finish(result);
            drop(guard);
            Ok(self.acknowledge(&plan, &operation_id, FileOperationState::Failed))
        }
    }

    /// Accept (or refuse) a cancel request.
    ///
    /// Best effort *by construction*: see the module docs for why the bound Shell API
    /// has no cancel callback. `Ok(true)` means "a live operation took the request",
    /// not "the files stopped moving" — the terminal result is the only place the
    /// truth lands. An unknown or already-finished id is `Ok(false)`, which is what
    /// lets a UI stop spinning a card that has nothing left to cancel.
    ///
    /// Must be called from a blocking thread (the host dispatches it on
    /// `spawn_blocking`), because publishing the `cancelling` tick uses `block_on`.
    fn cancel(&self, operation_id: &str) -> Result<bool, CapabilityError> {
        let Some(live) = self.shared.peek(operation_id) else {
            return Ok(false);
        };
        live.cancel.store(true, Ordering::SeqCst);
        self.shared.progress(FileOperationProgress {
            operation_id: operation_id.to_owned(),
            state: FileOperationState::Cancelling,
            request_token: live.request_token,
            processed: 0,
            total: live.total,
            indeterminate: true,
            current_name: None,
        });
        Ok(true)
    }
}

// ─────────────────────────── request validation ───────────────────────────

/// A validated request, normalised to what the Shell can be handed.
///
/// Only [`validate`] builds one, so the platform layer never re-checks shapes —
/// which is what keeps the COM code thin enough to be reviewed by reading it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// What to do.
    pub op: FileOperationKind,
    /// Normalised absolute source paths. May be empty for `Create`, which names its
    /// result instead (see [`Plan::landing_path`]).
    pub sources: Vec<String>,
    /// Normalised destination directory.
    pub destination: Option<String>,
    /// Requested name for Rename/Create (a name, never a path).
    pub new_name: Option<String>,
    /// Recycle-bin request for Delete.
    pub to_recycle_bin: bool,
    /// Collision policy handed to the Shell.
    pub conflict: FileConflictPolicy,
    /// Echoed on every event.
    pub request_token: Option<String>,
    /// The path Rename/Create will actually produce — source parent + name
    /// (Rename), destination + name (Create).
    pub landing_path: Option<String>,
}

impl Plan {
    /// How many items the Shell is being handed. Create is always one, whatever the
    /// caller put in `sources`; clamped because `total` is a `u32` on the wire.
    pub fn total(&self) -> u32 {
        let count = match self.op {
            FileOperationKind::Create => 1,
            _ => self.sources.len(),
        };
        u32::try_from(count).unwrap_or(u32::MAX)
    }

    /// The paths a terminal result should name, whether or not the Shell ever ran.
    /// Create reports the path it was going to make (the same choice the frozen dev
    /// provider makes, so a consumer's "refresh that directory" logic behaves
    /// identically on both), everything else reports its sources.
    pub fn items_to_report(&self) -> Vec<String> {
        match self.op {
            FileOperationKind::Create => self
                .landing_path
                .clone()
                .map(|landing| vec![landing])
                .unwrap_or_default(),
            _ => self.sources.clone(),
        }
    }
}

/// Where a destination sits relative to a source directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placement {
    /// Unrelated paths.
    Outside,
    /// The same directory (modulo trailing separators and, on Windows, case).
    Same,
    /// The destination is *inside* the source — copying a folder into itself.
    Inside,
}

/// Compare two paths by components, lexically.
///
/// Deliberately not canonicalised: the Shell resolves reparse points and junctions
/// itself, and resolving here would stat the world and follow symlinks the user did
/// not mean to follow, for a check whose only job is to catch the obvious
/// self-containment the spec assigns to the host.
pub fn placement_of(source: &str, destination: &str, case_insensitive: bool) -> Placement {
    let source_parts = components_of(Path::new(source), case_insensitive);
    let destination_parts = components_of(Path::new(destination), case_insensitive);
    if source_parts == destination_parts {
        Placement::Same
    } else if destination_parts.starts_with(&source_parts) {
        Placement::Inside
    } else {
        Placement::Outside
    }
}

fn components_of(path: &Path, case_insensitive: bool) -> Vec<String> {
    path.components()
        .map(|component| match component {
            Component::Normal(text) => {
                let text = text.to_string_lossy().into_owned();
                if case_insensitive {
                    text.to_lowercase()
                } else {
                    text
                }
            }
            // Roots and drive prefixes (`\\?\`, `C:`, `\`) are compared literally:
            // they are already normalised by `shell_path` and a case fold on them
            // would only mangle the verbatim marker.
            other => other.as_os_str().to_string_lossy().into_owned(),
        })
        // A trailing separator is not a component, so `C:\a` and `C:\a\` compare
        // equal — which is what the Shell does too.
        .collect()
}

/// Is this path rooted enough for the Shell to resolve without guessing a working
/// directory?
///
/// Checked lexically and platform-neutral on purpose: a Windows drive or UNC prefix
/// is a root even when the build host is Linux, so the rule protecting a user's
/// files is the same rule everywhere. A relative source would make the Shell resolve
/// against *this process's* cwd, which is not the directory the user was looking at.
pub fn has_root(path: &str) -> bool {
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/');
    // Both `\\?\C:\…` (verbatim) and `\\server\share\…` (UNC) start with two separators.
    let unc_or_verbatim = bytes.starts_with(b"\\\\");
    drive || unc_or_verbatim || Path::new(path).has_root()
}

/// A name that is really a path in disguise. `newName` is documented as "never a
/// path"; accepting a path there would turn a rename into an unrequested move.
pub fn looks_like_path(value: &str) -> bool {
    value.contains('/')
        || value.contains('\\')
        || has_root(value)
        // `C:relative.txt` is drive-relative, not a name.
        || (value.len() >= 2
            && value.as_bytes()[0].is_ascii_alphabetic()
            && value.as_bytes()[1] == b':')
}

/// Characters Windows refuses in a file name, plus the C0 control range. `/` and
/// `\` are covered by [`looks_like_path`].
///
/// Windows-only legality, and that is fine: this capability's provider *is*
/// Windows-native, and a name the Shell would silently mangle is a request the host
/// should refuse rather than watch fail.
pub fn name_is_legal(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    if name
        .chars()
        .any(|c| matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*') || (c as u32) < 0x20)
    {
        return false;
    }
    // Windows silently trims a trailing space or dot, so `a.` would land as `a`:
    // refuse the name the user typed rather than deliver a different one.
    !name.ends_with(' ') && !name.ends_with('.')
}

/// The Shell-parseable form of a path. `SHCreateItemFromParsingName` parses the name
/// itself and cannot take a `\\?\` verbatim prefix (which `std::fs` happily produces);
/// relative names are anchored against the process cwd without touching the
/// filesystem (`std::path::absolute` resolves neither symlinks nor existence).
pub fn shell_path(path: &str) -> String {
    let absolute =
        std::path::absolute(Path::new(path)).unwrap_or_else(|_| PathBuf::from(path));
    let raw: Cow<str> = absolute.to_string_lossy();
    if let Some(unc) = raw.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{unc}");
    }
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        return stripped.to_owned();
    }
    raw.into_owned()
}

/// Validate a request and normalise it. Every rejection is a caller bug, so every
/// rejection is an `InvalidArgument`; the message *prefix* is the frozen wire
/// contract (`invalid argument:` — the frontend classifies on it) and the reason
/// text is Chinese because it may end up under the user's eyes.
pub fn validate(req: &FileOperationIn) -> Result<Plan, CapabilityError> {
    let invalid = |why: String| CapabilityError::InvalidArgument(why);

    let is_create = req.op == FileOperationKind::Create;
    if req.sources.is_empty() && !is_create {
        return Err(invalid("没有选中的条目".to_owned()));
    }
    let mut sources = Vec::with_capacity(req.sources.len());
    for source in &req.sources {
        if source.trim().is_empty() {
            return Err(invalid("来源路径为空".to_owned()));
        }
        if source.contains('\0') {
            return Err(invalid("来源路径包含非法字符".to_owned()));
        }
        if !has_root(source) {
            return Err(invalid(format!("来源路径必须是绝对路径：{source}")));
        }
        sources.push(shell_path(source));
    }

    // Create from a blank-area menu has nothing selected: the item it makes is
    // named by `destination` + `newName`, so an empty `sources` is legal there and
    // only more than one is a caller bug (contract: Rename/Create take exactly one).
    if matches!(req.op, FileOperationKind::Rename | FileOperationKind::Create)
        && sources.len() > 1
    {
        return Err(invalid("重命名/新建一次只能处理一项".to_owned()));
    }

    // `destination` is documented as absent for Rename/Delete. A caller that carries
    // one anyway cannot make the Shell do anything different, so it is ignored
    // rather than rejected — refusing here would break no semantics but would break
    // a UI that reuses one request builder.
    let destination = match req.op {
        FileOperationKind::Copy | FileOperationKind::Move | FileOperationKind::Create => {
            let raw = req.destination.as_deref().ok_or_else(|| {
                invalid(match req.op {
                    FileOperationKind::Create => "新建需要目标目录".to_owned(),
                    _ => "复制/移动需要目标目录".to_owned(),
                })
            })?;
            if raw.trim().is_empty() || raw.contains('\0') {
                return Err(invalid("目标目录为空".to_owned()));
            }
            if !has_root(raw) {
                return Err(invalid(format!("目标目录必须是绝对路径：{raw}")));
            }
            Some(shell_path(raw))
        }
        FileOperationKind::Rename | FileOperationKind::Delete => None,
    };

    let new_name = match req.op {
        FileOperationKind::Rename | FileOperationKind::Create => {
            let raw = req.new_name.as_deref().ok_or_else(|| {
                invalid(match req.op {
                    FileOperationKind::Create => "新建需要名称".to_owned(),
                    _ => "重命名需要新名称".to_owned(),
                })
            })?;
            if raw.trim().is_empty() {
                return Err(invalid("名称不能为空".to_owned()));
            }
            if looks_like_path(raw) {
                return Err(invalid("名称必须是名称，不能是路径".to_owned()));
            }
            if !name_is_legal(raw.trim()) {
                return Err(invalid(format!("名称不合法：{}", raw.trim())));
            }
            Some(raw.trim().to_owned())
        }
        // Copy/Move/Delete have no business renaming anything, and a stray
        // `newName` must not become a silent rename of the landing item.
        FileOperationKind::Copy | FileOperationKind::Move | FileOperationKind::Delete => None,
    };

    let landing_path = match (&destination, &new_name) {
        (Some(dir), Some(name)) => Some(
            Path::new(dir)
                .join(name)
                .to_string_lossy()
                .into_owned(),
        ),
        // Rename has no destination: it lands next to its source.
        (None, Some(name)) => Path::new(&sources[0])
            .parent()
            .map(|parent| parent.join(name).to_string_lossy().into_owned()),
        _ => None,
    };

    match req.op {
        FileOperationKind::Copy | FileOperationKind::Move => {
            let destination = destination.as_deref().unwrap_or_default();
            for source in &sources {
                match placement_of(source, destination, CASE_INSENSITIVE_PATHS) {
                    Placement::Same => {
                        return Err(invalid(format!("目标目录不能与来源相同：{source}")))
                    }
                    Placement::Inside => {
                        return Err(invalid(format!("目标目录位于来源目录内部：{destination}")))
                    }
                    Placement::Outside => {}
                }
            }
        }
        FileOperationKind::Rename => {
            let target = landing_path.clone().unwrap_or_default();
            // Renaming a file onto itself is the no-op the Shell would report as an
            // error; the user asked for a change, so say plainly that the name did
            // not change instead of handing them a failure code.
            if placement_of(&sources[0], &target, CASE_INSENSITIVE_PATHS) != Placement::Outside {
                return Err(invalid("新名称与原名称相同".to_owned()));
            }
        }
        FileOperationKind::Create => {
            if landing_path.is_none() {
                return Err(invalid("新建需要目标目录与名称".to_owned()));
            }
        }
        FileOperationKind::Delete => {}
    }

    Ok(Plan {
        op: req.op,
        sources,
        destination,
        new_name,
        to_recycle_bin: req.to_recycle_bin,
        conflict: req.conflict,
        request_token: req.request_token.clone(),
        landing_path,
    })
}

// ─────────────────────────── pure decision helpers ───────────────────────────
//
// Everything the Windows path needs to *decide* is a plain function over `u32` and
// `&str` here, so the flag set, the HRESULT table and the state machine are all
// testable without a Shell. The COM module below only moves values around.

/// `FOF_`/`FOFX_` values, from `Shellapi.h` and `shobjidl.h` as quoted by the
/// `SetOperationFlags` docs. Kept as literals so the mapping is testable on every
/// platform; `the_flag_literals_match_the_sdk` pins them against the crate's own
/// constants on Windows, so a wrong digit fails a test rather than a user's
/// recycle bin.
pub mod shell_flags {
    /// Give the item a new name when the target name already exists.
    pub const FOF_RENAMEONCOLLISION: u32 = 0x0000_0008;
    /// Answer Yes to All for any dialog the Shell would show.
    pub const FOF_NOCONFIRMATION: u32 = 0x0000_0010;
    /// Keep undo information (the pre-Win8 spelling).
    pub const FOF_ALLOWUNDO: u32 = 0x0000_0040;
    /// Do not confirm creating an intermediate folder.
    pub const FOF_NOCONFIRMMKDIR: u32 = 0x0000_0200;
    /// Warn before destroying an item instead of recycling it.
    pub const FOF_WANTNUKEWARNING: u32 = 0x0000_4000;
    /// Delete to the recycle bin (Win8+).
    pub const FOFX_RECYCLEONDELETE: u32 = 0x0008_0000;
    /// Keep the extension when auto-renaming; only meaningful together with
    /// `FOF_RENAMEONCOLLISION`.
    pub const FOFX_PRESERVEFILEEXTENSIONS: u32 = 0x0020_0000;
}

/// The complete flag set for one operation.
///
/// The Shell has exactly one documented knob per question here — `SetOperationFlags`
/// — because `SetConflictPreference` is a reserved method and is not in the
/// bindings. The mapping:
/// - **recycle bin**: `FOFX_RECYCLEONDELETE` (spec 回收站默认) plus `FOF_ALLOWUNDO`.
///   When the caller explicitly asks *not* to recycle the delete becomes
///   irreversible, so `FOF_WANTNUKEWARNING` is added instead: the spec forbids a
///   silent permanent delete, and the docs say this warning survives
///   `FOF_NOCONFIRMATION`.
/// - **conflict = rename**: `FOF_RENAMEONCOLLISION | FOFX_PRESERVEFILEEXTENSIONS`.
///   Exactly expressible, and `PostCopyItem`/`PostMoveItem` hand back the item the
///   Shell actually created — which is how a `renamed` outcome is detected.
/// - **conflict = overwrite**: `FOF_NOCONFIRMATION`, documented as "respond with Yes
///   to All for any dialog box that is displayed" — the only supported way to make a
///   collision resolve as a replace without the reserved callback. Caveat stated
///   rather than hidden: it answers *every* prompt yes, which is why the nuke warning
///   above is still kept for deletes, and why the contract requires the UI to have
///   confirmed this policy before sending it.
/// - **conflict = fail** (the contract default): no collision flag at all, so the
///   Shell shows its own system prompt and nothing is overwritten silently. **The
///   Shell cannot be told "auto-fail and report `exists`"** through any documented
///   flag; a user who then picks *Skip* is reported as a non-completed item, which is
///   the closest the truth gets to the intent.
/// - base `FOF_ALLOWUNDO | FOF_NOCONFIRMMKDIR`: the documented default when
///   `SetOperationFlags` is never called. Since we do call it, they must be restated
///   or undo support would be silently dropped.
///
/// Never set: `FOF_SILENT`/`FOF_SIMPLEPROGRESS` (the Windows dialog is the
/// authoritative progress UI) and `FOF_NOERRORUI` (an error under it counts as
/// *Ignore*, i.e. a failure hidden from the user).
#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows provider sets flags"))]
pub fn operation_flags(
    op: FileOperationKind,
    to_recycle_bin: bool,
    conflict: FileConflictPolicy,
) -> u32 {
    let mut flags = shell_flags::FOF_ALLOWUNDO | shell_flags::FOF_NOCONFIRMMKDIR;
    if op == FileOperationKind::Delete {
        if to_recycle_bin {
            flags |= shell_flags::FOFX_RECYCLEONDELETE;
        } else {
            flags |= shell_flags::FOF_WANTNUKEWARNING;
        }
    }
    match conflict {
        FileConflictPolicy::Fail => {}
        FileConflictPolicy::Rename => {
            flags |= shell_flags::FOF_RENAMEONCOLLISION | shell_flags::FOFX_PRESERVEFILEEXTENSIONS;
        }
        FileConflictPolicy::Overwrite => flags |= shell_flags::FOF_NOCONFIRMATION,
    }
    flags
}

/// The `HRESULT_FROM_WIN32` shape: severity bit 31 set, facility 7
/// (`FACILITY_WIN32`), the Win32 code in the low 16 bits.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows provider reads HRESULTs"))]
pub fn win32_code_of(hresult: u32) -> Option<u32> {
    let severity = (hresult >> 31) & 1;
    let facility = (hresult >> 16) & 0x1fff;
    (severity == 1 && facility == 7).then_some(hresult & 0xffff)
}

/// Map a Win32 error code to the stable category the UI turns into Chinese text.
/// Codes are `winerror.h` values, named in the comment so a reader can check one.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows provider reads HRESULTs"))]
pub fn reason_of_win32_code(code: u32) -> FileFailureReason {
    match code {
        // ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND
        2 | 3 => FileFailureReason::NotFound,
        // ERROR_ACCESS_DENIED / ERROR_SHARING_VIOLATION / ERROR_LOCK_VIOLATION /
        // ERROR_PRIVILEGE_NOT_HELD — this account cannot reach it right now.
        5 | 32 | 33 | 1314 => FileFailureReason::Denied,
        // ERROR_FILE_EXISTS / ERROR_ALREADY_EXISTS — the collision the UI asked
        // about, still standing.
        80 | 183 => FileFailureReason::Exists,
        // ERROR_WRITE_PROTECT / ERROR_FILE_READ_ONLY
        19 | 3027 => FileFailureReason::ReadOnly,
        // ERROR_HANDLE_DISK_FULL / ERROR_DISK_FULL
        39 | 112 => FileFailureReason::DiskFull,
        // ERROR_CANCELLED — the user pressed Cancel, in the Shell's dialog or in a
        // prompt it showed on our behalf.
        1223 => FileFailureReason::CancelledByShell,
        _ => FileFailureReason::Other,
    }
}

/// Classify a per-item `HRESULT` from the progress sink. Anything not Win32-shaped
/// goes to a documented category rather than a guess — including `VP_E_USERCANCEL`
/// (`0x8027002C`, Shell facility), which is a user abort and must not be reported as
/// `other`.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows provider reads HRESULTs"))]
pub fn reason_of_hresult(hresult: u32) -> FileFailureReason {
    if hresult == 0x8027_002C {
        return FileFailureReason::CancelledByShell;
    }
    match win32_code_of(hresult) {
        Some(code) => reason_of_win32_code(code),
        None => FileFailureReason::Other,
    }
}

/// The terminal state, given what the Shell reported per item.
///
/// Order matters, and each step is a different claim:
/// 1. the Shell said it aborted (`GetAnyOperationsAborted`) → `cancelled`. An abort
///    is a fact about the *operation* and outranks a partially clean item list.
/// 2. nothing to report → `failed`: a batch with no verdicts can claim nothing.
/// 3. the engine call itself failed → `failed`. Whatever items completed did, but
///    the batch as asked-for did not; the item list still carries the per-item truth
///    (spec: 插件如实报告结果, 不承诺事务/回滚).
/// 4. every item completed → `completed` (a `skipped`/`cancelled`/`failed` item is
///    not a completion).
/// 5. no item completed → `failed`.
/// 6. otherwise → `partial-failure`, the state the contract added so the UI must list
///    what did not land.
pub fn terminal_state(
    items: &[FileOperationItem],
    aborted: bool,
    engine_failed: bool,
) -> FileOperationState {
    let completed = items
        .iter()
        .filter(|item| {
            matches!(
                item.outcome,
                FileItemOutcome::Completed | FileItemOutcome::Renamed
            )
        })
        .count();
    if aborted {
        FileOperationState::Cancelled
    } else if items.is_empty() {
        FileOperationState::Failed
    } else if engine_failed {
        FileOperationState::Failed
    } else if completed == items.len() {
        FileOperationState::Completed
    } else if completed == 0 {
        FileOperationState::Failed
    } else {
        FileOperationState::PartialFailure
    }
}

/// Normalise a volume root for identity comparison.
///
/// `GetVolumePathNameW` answers `C:\`, or `\\?\Volume{guid}\` for a volume mounted
/// as a folder, or `\\server\share\` for a UNC share. Only the identity of the
/// volume matters, so: rewrite the verbatim volume GUID form to a stable marker,
/// drop the trailing separator, and case-fold on Windows. Comparing *volume roots*
/// rather than drive letters is what makes this right for substituted drives and
/// reparse-point mounts, which is exactly where a letter comparison is silently
/// wrong — and why `GetDriveTypeW` (remote/local/cdrom) is not used for this.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows provider reads volume roots"))]
pub fn volume_key(raw: &str, case_insensitive: bool) -> String {
    let stripped = match raw.strip_prefix(r"\\?\") {
        Some(rest) => rest.to_owned(),
        None => raw.to_owned(),
    };
    let trimmed = stripped.trim_end_matches(['\\', '/']);
    if case_insensitive {
        trimmed.to_lowercase()
    } else {
        trimmed.to_owned()
    }
}

/// Was this Move performed by the Shell as copy + delete across two volumes?
///
/// Takes the two *raw* volume roots so the normalisation lives in one place
/// ([`volume_key`]). A root that could not be read is `None`, which reports "not
/// cross-volume": the flag only adds a distinction to a Move that already
/// succeeded, and inventing one would be worse than omitting it.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows provider reads volume roots"))]
pub fn is_cross_volume(source_root: Option<&str>, destination_root: Option<&str>) -> bool {
    match (source_root, destination_root) {
        (Some(source), Some(destination)) => {
            volume_key(source, CASE_INSENSITIVE_PATHS)
                != volume_key(destination, CASE_INSENSITIVE_PATHS)
        }
        _ => false,
    }
}

/// Assemble the terminal result that every path shares (Windows, non-Windows, no
/// permit, engine failure) so the state machine is only written once.
pub fn build_result(
    plan: &Plan,
    operation_id: &str,
    items: Vec<FileOperationItem>,
    aborted: bool,
    engine_failed: bool,
    cross_volume_move: bool,
) -> FileOperationResult {
    let state = terminal_state(&items, aborted, engine_failed);
    FileOperationResult {
        operation_id: operation_id.to_owned(),
        state,
        request_token: plan.request_token.clone(),
        items,
        cross_volume_move,
    }
}

/// An item the Shell never got to work on: refused before queueing, or covered by a
/// cancel request while it was still in our queue.
pub fn refused_item(
    source: &str,
    reason: FileFailureReason,
    message: &str,
) -> FileOperationItem {
    FileOperationItem {
        source: source.to_owned(),
        destination: None,
        // A cancelled item is not a failed item: the UI says 已取消 rather than
        // 失败, and only `reason` cannot express that difference.
        outcome: if reason == FileFailureReason::CancelledByShell {
            FileItemOutcome::Cancelled
        } else {
            FileItemOutcome::Failed
        },
        reason: Some(reason),
        message: Some(message.to_owned()),
    }
}

/// The indeterminate progress tick an operation publishes.
#[cfg_attr(not(windows), allow(dead_code, reason = "only the Windows provider ticks progress"))]
pub fn progress_of(
    operation_id: &str,
    state: FileOperationState,
    plan: &Plan,
    current_name: Option<String>,
) -> FileOperationProgress {
    FileOperationProgress {
        operation_id: operation_id.to_owned(),
        state,
        request_token: plan.request_token.clone(),
        // 0 / indeterminate: `IFileOperation` offers no trustworthy percentage, and
        // the contract states the UI must show uncertainty rather than a number.
        processed: 0,
        total: plan.total(),
        indeterminate: true,
        current_name,
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // Poisoning would panic inside `cancel()` or drop an event, and neither is worth
    // losing an operation over: behind these locks are a live-id map and an emitter,
    // never an invariant that can be half-updated.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

// ───────────────────────────── windows provider ─────────────────────────────

/// The real provider: STA apartment, `IFileOperation`, progress sink, per-item
/// HRESULTs. Its own module so a non-Windows build never names a Windows type.
#[cfg(windows)]
mod platform {
    use std::ffi::c_void;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex, PoisonError};
    use std::time::Instant;

    use fm_contracts::capability::{
        FileFailureReason, FileItemOutcome, FileOperationItem, FileOperationKind,
        FileOperationProgress, FileOperationState,
    };
    use windows::core::{implement, HRESULT, PCWSTR, PWSTR};
    use windows::Win32::Storage::FileSystem::{GetVolumePathNameW, FILE_ATTRIBUTE_DIRECTORY};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
        CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::UI::Shell::{
        FileOperation as CLSID_FILE_OPERATION, IFileOperation, IFileOperationProgressSink,
        IFileOperationProgressSink_Impl, IShellItem, SHCreateItemFromParsingName,
        SIGDN_FILESYSPATH,
    };

    use super::{
        build_result, is_cross_volume, operation_flags, progress_of, reason_of_hresult,
        refused_item, shell_path, CASE_INSENSITIVE_PATHS, QUEUE_BUDGET,
    };
    use crate::capabilities::shell_thumb::gate::Permit;
    use crate::capabilities::shell_ops::{LiveGuard, Plan, Shared};

    /// What one Shell batch ended with: the per-item truths, whether the user
    /// aborted, and whether the engine call itself failed.
    struct Outcome {
        items: Vec<FileOperationItem>,
        aborted: bool,
        engine_failed: bool,
    }

    /// The sink's channel back to the event bus: one indeterminate progress tick
    /// per item the Shell has just finished, carrying the name the Shell itself
    /// reported. Lives on the operation thread; `Shared::progress` is what makes
    /// the crossing (block_on on the captured runtime handle, never a worker).
    struct Reporter {
        shared: Arc<Shared>,
        operation_id: String,
        total: u32,
        request_token: Option<String>,
        cancel: Arc<AtomicBool>,
    }

    impl Reporter {
        /// A running/cancelling tick named after the item the Shell just touched.
        /// `current_name` comes from the sink's own item, so the UI card shows the
        /// file the Shell is *actually* working on rather than a guess at it.
        fn tick(&self, current_name: Option<String>) {
            let state = if self.cancel.load(Ordering::SeqCst) {
                FileOperationState::Cancelling
            } else {
                FileOperationState::Running
            };
            self.shared.progress(FileOperationProgress {
                operation_id: self.operation_id.clone(),
                state,
                request_token: self.request_token.clone(),
                // 0 / indeterminate: the item count is not a percentage (module docs).
                processed: 0,
                total: self.total,
                indeterminate: true,
                current_name,
            });
        }
    }

    /// Spawn the operation's STA thread. The caller's `LiveGuard` moves with it, so
    /// the live-table entry is retired by the thread — including on a panic.
    pub(super) fn dispatch(
        shared: Arc<Shared>,
        plan: Plan,
        operation_id: String,
        cancel: Arc<AtomicBool>,
        guard: LiveGuard,
    ) -> Result<(), String> {
        let thread_name = format!("fm-shell-op-{operation_id}");
        std::thread::Builder::new()
            .name(thread_name)
            .spawn(move || {
                // Dropped here, on the operation thread, when it finishes.
                let _guard = guard;
                let result = drive(&shared, &plan, &operation_id, &cancel);
                shared.finish(result);
            })
            .map(|_handle| ())
            .map_err(|err| err.to_string())
    }

    /// Take a Shell slot, then run. Everything here must produce an answer even when
    /// it cannot produce a result: the caller already has an ack and a UI card is
    /// already showing `queued`.
    fn drive(
        shared: &Arc<Shared>,
        plan: &Plan,
        operation_id: &str,
        cancel: &Arc<AtomicBool>,
    ) -> super::FileOperationResult {
        let deadline = Instant::now() + QUEUE_BUDGET;
        let permit: Option<Arc<Permit>> = shared.gate.acquire_until(deadline);
        let Some(_permit) = permit else {
            tracing::warn!(
                operation_id,
                budget_ms = QUEUE_BUDGET.as_millis(),
                "no Shell operation slot came free inside the queue budget"
            );
            let items = plan
                .items_to_report()
                .into_iter()
                .map(|source| {
                    refused_item(&source, FileFailureReason::Other, "等待 Shell 操作通道超时")
                })
                .collect();
            return build_result(plan, operation_id, items, false, true, false);
        };

        shared.progress(progress_of(
            operation_id,
            FileOperationState::Running,
            plan,
            None,
        ));

        let reporter = Arc::new(Reporter {
            shared: Arc::clone(shared),
            operation_id: operation_id.to_owned(),
            total: plan.total(),
            request_token: plan.request_token.clone(),
            cancel: Arc::clone(cancel),
        });
        let outcome = run(plan, cancel, &reporter);
        // Only a Move can be done by the Shell as copy + delete, and the user is
        // owed that distinction (spec P7-17: 须报告).
        let cross_volume_move =
            plan.op == FileOperationKind::Move && any_cross_volume(plan);
        if cancel.load(Ordering::SeqCst) && !outcome.aborted {
            // The honest reading of "best effort": we asked, the Shell carried on,
            // and the user is told what actually happened rather than what we
            // requested. The bound API has no cancel callback (module docs).
            tracing::warn!(
                operation_id,
                "cancel was requested but the Shell did not abort the operation"
            );
        }
        build_result(
            plan,
            operation_id,
            outcome.items,
            outcome.aborted,
            outcome.engine_failed,
            cross_volume_move,
        )
    }

    /// One COM apartment, start to finish, on this thread.
    fn run(plan: &Plan, cancel: &Arc<AtomicBool>, reporter: &Arc<Reporter>) -> Outcome {
        // `S_FALSE` (this thread was already initialised) is a success code, so
        // `is_err()` is exactly "this thread got no apartment" — and a balanced
        // `CoUninitialize` is owed whenever the call succeeded.
        if unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_err() {
            tracing::warn!("CoInitializeEx failed on the shell operation thread");
            return all_failed(
                plan,
                FileFailureReason::Other,
                "COM 初始化失败，操作未执行",
                true,
            );
        }
        let outcome = apartment_work(plan, cancel, reporter);
        unsafe { CoUninitialize() };
        outcome
    }

    /// Every item refused for one engine-level reason.
    fn all_failed(
        plan: &Plan,
        reason: FileFailureReason,
        message: &str,
        engine_failed: bool,
    ) -> Outcome {
        Outcome {
            items: plan
                .items_to_report()
                .into_iter()
                .map(|source| refused_item(&source, reason, message))
                .collect(),
            aborted: false,
            engine_failed,
        }
    }

    /// Build the operation, queue the items, run it, read the verdicts.
    fn apartment_work(plan: &Plan, cancel: &Arc<AtomicBool>, reporter: &Arc<Reporter>) -> Outcome {
        let ledger: Arc<Mutex<Vec<FileOperationItem>>> = Arc::new(Mutex::new(Vec::new()));
        // Items the Shell never accepted into the batch (parse failures, our own
        // cancel before queueing). The sink's verdicts are appended to these.
        let mut failures: Vec<FileOperationItem> = Vec::new();

        let op: IFileOperation = match unsafe {
            CoCreateInstance(&CLSID_FILE_OPERATION, None, CLSCTX_INPROC_SERVER)
        } {
            Ok(op) => op,
            Err(err) => {
                tracing::warn!(error = %err, "could not create the Shell file operation engine");
                return all_failed(
                    plan,
                    reason_of_hresult(err.code().0 as u32),
                    "Shell 文件操作引擎不可用",
                    true,
                );
            }
        };

        let sink: IFileOperationProgressSink = Sink {
            ledger: Arc::clone(&ledger),
            cancel: Arc::clone(cancel),
            reporter: Arc::clone(reporter),
        }
        .into();
        // A failed `Advise` is not fatal: the operation still runs and the Shell's
        // own dialog still reports progress. We only lose the per-item verdicts,
        // which is why the batch-level HRESULTs below still have to be read.
        if let Err(err) = unsafe { op.Advise(&sink) } {
            tracing::warn!(
                error = %err,
                "the Shell refused our progress sink: per-item results will be summarised"
            );
        }

        let flags = operation_flags(plan.op, plan.to_recycle_bin, plan.conflict);
        if let Err(err) = unsafe { op.SetOperationFlags(super::shell_flags_of(flags)) } {
            // Stop rather than run with unknown flags: `FOFX_RECYCLEONDELETE` is the
            // difference between a delete the user can undo and one they cannot, and
            // we will not guess which the Shell applied.
            tracing::warn!(error = %err, flags, "could not set the Shell operation flags");
            return all_failed(plan, FileFailureReason::Other, "无法设置 Shell 操作标志", true);
        }
        // `SetOwnerWindow` is deliberately not called: the Tauri window belongs to
        // another thread, and handing the Shell a cross-thread owner for a modal
        // dialog is how input gets routed into the wrong apartment. With no owner the
        // Shell parents its dialog to the foreground window — which is the behaviour
        // the spec asks for (系统对话框由 Windows 管理).

        let destination = match plan.op {
            FileOperationKind::Copy | FileOperationKind::Move | FileOperationKind::Create => {
                let dir = plan.destination.as_deref().unwrap_or_default();
                match shell_item(dir) {
                    Ok(item) => Some(item),
                    Err(err) => {
                        // Nothing can land anywhere without the target folder, so
                        // every item is refused with the reason the Shell gave.
                        let reason = reason_of_hresult(err.code().0 as u32);
                        let mut outcome = all_failed(plan, reason, "目标目录不可用", true);
                        failures.append(&mut outcome.items);
                        return Outcome {
                            items: failures,
                            aborted: outcome.aborted,
                            engine_failed: outcome.engine_failed,
                        };
                    }
                }
            }
            FileOperationKind::Rename | FileOperationKind::Delete => None,
        };

        let mut queued = 0usize;
        match plan.op {
            FileOperationKind::Create => {
                // The contract's Create is 新建文件夹 (spec: 复制、移动、重命名、新建
                // 文件夹、删除). An empty *file* would be `dwFileAttributes = 0` with an
                // empty template — a different product decision, not made here.
                let name = wide(plan.new_name.as_deref().unwrap_or_default());
                let folder = destination.as_ref().expect("validated above");
                let request = unsafe {
                    op.NewItem(
                        folder,
                        FILE_ATTRIBUTE_DIRECTORY.0,
                        PCWSTR(name.as_ptr()),
                        PCWSTR::null(),
                        None,
                    )
                };
                match request {
                    Ok(()) => queued = 1,
                    Err(err) => failures.push(refused_item(
                        plan.landing_path.as_deref().unwrap_or_default(),
                        reason_of_hresult(err.code().0 as u32),
                        "Shell 拒绝排队该新建项",
                    )),
                }
            }
            other => {
                for (index, source) in plan.sources.iter().enumerate() {
                    // Cancelled while still in our queue: this item is *known* not to
                    // have been handed to the Shell, so it can be reported truthfully
                    // as cancelled instead of vanishing from the list.
                    if cancel.load(Ordering::SeqCst) {
                        for rest in plan.sources[index..].iter() {
                            failures.push(refused_item(
                                rest,
                                FileFailureReason::CancelledByShell,
                                "操作已取消，未提交给 Shell",
                            ));
                        }
                        break;
                    }
                    let item = match shell_item(source) {
                        Ok(item) => item,
                        Err(err) => {
                            // A source the Shell cannot even parse is a per-item
                            // failure, never a reason to abandon the rest.
                            failures.push(refused_item(
                                source,
                                reason_of_hresult(err.code().0 as u32),
                                "Shell 无法解析该路径",
                            ));
                            continue;
                        }
                    };
                    // `PCWSTR::null()` for the copy/move name: "keep the source
                    // name" is the only behaviour a Copy/Move of several items may
                    // have; a rename there would be a silent second decision.
                    let request = unsafe {
                        match other {
                            FileOperationKind::Copy => op.CopyItem(
                                &item,
                                destination.as_ref().expect("validated above"),
                                PCWSTR::null(),
                                None,
                            ),
                            FileOperationKind::Move => op.MoveItem(
                                &item,
                                destination.as_ref().expect("validated above"),
                                PCWSTR::null(),
                                None,
                            ),
                            FileOperationKind::Rename => {
                                let name = wide(plan.new_name.as_deref().unwrap_or_default());
                                op.RenameItem(&item, PCWSTR(name.as_ptr()), None)
                            }
                            FileOperationKind::Delete => op.DeleteItem(&item, None),
                            FileOperationKind::Create => Ok(()),
                        }
                    };
                    match request {
                        Ok(()) => queued += 1,
                        Err(err) => failures.push(refused_item(
                            source,
                            reason_of_hresult(err.code().0 as u32),
                            "Shell 拒绝排队该项",
                        )),
                    }
                }
            }
        }

        let mut engine_failed = false;
        if queued > 0 {
            if let Err(err) = unsafe { op.PerformOperations() } {
                engine_failed = true;
                tracing::warn!(error = %err, "PerformOperations failed");
            }
        } else {
            // Nothing was queued, so the Shell has nothing to report and nothing
            // happened: an empty batch is an engine failure, not a success.
            engine_failed = true;
        }

        // The one documented cancellation signal. `Err` here means we cannot claim
        // an abort, so we do not: the item list stays authoritative.
        let aborted = unsafe { op.GetAnyOperationsAborted() }
            .map(|flag| flag.as_bool())
            .unwrap_or(false);

        let mut items = failures;
        items.extend(
            ledger
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .iter()
                .cloned(),
        );
        if engine_failed && items.is_empty() {
            items = plan
                .items_to_report()
                .into_iter()
                .map(|source| refused_item(&source, FileFailureReason::Other, "Shell 操作未完成"))
                .collect();
        }
        Outcome {
            items,
            aborted,
            engine_failed,
        }
    }

    /// `SHCreateItemFromParsingName` for one normalised absolute path.
    fn shell_item(path: &str) -> windows::core::Result<IShellItem> {
        let wide = wide(path);
        unsafe {
            SHCreateItemFromParsingName(
                PCWSTR(wide.as_ptr()),
                None::<&windows::Win32::System::Com::IBindCtx>,
            )
        }
    }

    /// A UTF-16, NUL-terminated buffer the Shell can parse.
    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// `GetDisplayName(SIGDN_FILESYSPATH)` hands back a `CoTaskMemAlloc` buffer: read
    /// it, then free it. One leak per item of a bulk job is a real leak, and freeing
    /// memory we did not get from that allocator would be worse — so the free lives
    /// here and nowhere else.
    unsafe fn file_path_of(item: Option<&IShellItem>) -> Option<String> {
        let item = item?;
        let buffer: PWSTR = unsafe { item.GetDisplayName(SIGDN_FILESYSPATH) }.ok()?;
        let text = if buffer.is_null() {
            None
        } else {
            Some(unsafe { buffer.to_string() }.ok())
        };
        unsafe { CoTaskMemFree(Some(buffer.0 as *const c_void)) };
        text.flatten()
    }

    /// The name the Shell handed us, or `None` for a null/empty string — which is
    /// what it passes when we asked for no rename at all.
    unsafe fn name_of(value: &PCWSTR) -> Option<String> {
        if value.is_null() || unsafe { value.is_empty() } {
            return None;
        }
        unsafe { value.to_string() }.ok()
    }

    /// The file name part of a path, owned (a `&str` into a temporary would not
    /// outlive the comparison it is used for).
    fn file_name_of(path: &str) -> Option<String> {
        std::path::Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
    }

    /// One item's verdict, from the Shell's own `HRESULT` plus the item it says it
    /// created.
    ///
    /// `renamed` versus `completed`: the contract reserves `Renamed` for "the landing
    /// path is not the one the user asked for", which only a collision auto-rename
    /// produces — so the delivered name is compared with the name we wanted (the
    /// requested name, or the source's own name when we requested none). A successful
    /// `RenameItem` therefore reports `completed`, and a copy that the Shell had to
    /// rename reports `renamed` with the path it actually made.
    fn post_item(
        op: FileOperationKind,
        source_item: Option<&IShellItem>,
        requested: &PCWSTR,
        hr: HRESULT,
        created_item: Option<&IShellItem>,
    ) -> FileOperationItem {
        let source_path = unsafe { file_path_of(source_item) };
        let landing = unsafe { file_path_of(created_item) };
        let wanted = unsafe { name_of(requested) }
            .or_else(|| source_path.as_deref().and_then(file_name_of))
            .unwrap_or_default();

        if hr.is_ok() {
            let renamed = !matches!(op, FileOperationKind::Delete)
                && landing
                    .as_deref()
                    .and_then(file_name_of)
                    .is_some_and(|landed| !name_eq(&landed, &wanted));
            return FileOperationItem {
                // For Create there is no source item: the thing created *is* the
                // item, and the frozen dev provider reports that path as `source`,
                // so a consumer's "refresh this one directory" logic behaves the
                // same on both sides.
                source: source_path.or_else(|| match op {
                    FileOperationKind::Create => landing.clone().or(Some(wanted.clone())),
                    _ => None,
                }).unwrap_or_else(|| {
                    // Nothing readable from the Shell. A placeholder beats dropping
                    // the item, because dropping it would make the batch look
                    // smaller than what the user selected.
                    tracing::warn!("the Shell reported a successful item with no path");
                    "<未知条目>".to_owned()
                }),
                destination: if matches!(op, FileOperationKind::Delete) {
                    None
                } else {
                    landing
                },
                outcome: if renamed {
                    FileItemOutcome::Renamed
                } else {
                    FileItemOutcome::Completed
                },
                reason: None,
                message: None,
            };
        }

        FileOperationItem {
            source: source_path
                .or(Some(wanted))
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "<未知条目>".to_owned()),
            destination: landing,
            outcome: FileItemOutcome::Failed,
            reason: Some(reason_of_hresult(hr.0 as u32)),
            // The raw code, not the Shell's prose: the UI maps `reason` to Chinese
            // text and this string is only for a details affordance (spec: 事件不得
            // 传敏感错误堆栈).
            message: Some(format!("Shell HRESULT 0x{:08X}", hr.0 as u32)),
        }
    }

    fn name_eq(a: &str, b: &str) -> bool {
        if CASE_INSENSITIVE_PATHS {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    }

    /// Any source living on a different volume than the destination? Volume roots
    /// come from `GetVolumePathNameW` and are compared by [`volume_key`], so
    /// substituted drives and mounted folders are handled (see that helper).
    fn any_cross_volume(plan: &Plan) -> bool {
        let destination = plan.destination.as_deref().and_then(volume_root);
        plan.sources.iter().any(|source| {
            is_cross_volume(volume_root(source).as_deref(), destination.as_deref())
        })
    }

    fn volume_root(path: &str) -> Option<String> {
        let wide = wide(&shell_path(path));
        // 261 = `MAX_PATH + 1`, which is what the documented buffer size is for a
        // volume root (`\\?\Volume{...}\` never exceeds it).
        let mut buffer = [0u16; 261];
        unsafe { GetVolumePathNameW(PCWSTR(wide.as_ptr()), &mut buffer) }.ok()?;
        let end = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
        String::from_utf16(&buffer[..end]).ok()
    }

    /// Test-only window onto [`volume_root`]: it is the one call in this module
    /// that needs a real Windows install, and it only ever reads.
    #[cfg(test)]
    pub(super) fn probe_volume_root(path: &str) -> Option<String> {
        volume_root(path)
    }

    /// The sink. Every method answers `Ok(())`: a sink that returns a failure
    /// HRESULT makes the Shell treat the batch as aborted, and this sink exists to
    /// *observe*, never to veto — the veto belongs to the user and the Shell's dialog.
    #[implement(IFileOperationProgressSink)]
    struct Sink {
        ledger: Arc<Mutex<Vec<FileOperationItem>>>,
        // Polled here because the bindings have no cancel callback: these methods run
        // on the operation's own STA thread while `PerformOperations` is in flight,
        // which is the only place the flag can be read without apartment marshalling.
        // Reading it decides nothing about the Shell's behaviour (module docs); it
        // keeps the log, the item list and the progress state honest about whether a
        // cancel was asked for.
        cancel: Arc<AtomicBool>,
        reporter: Arc<Reporter>,
    }

    impl Sink_Impl {
        /// Record the verdict, then tick progress with the name of the item the
        /// Shell just finished: the UI card follows the Shell's own item rather
        /// than a guess at it.
        fn record(&self, item: FileOperationItem) {
            let current_name = item
                .source
                .rsplit(['\\', '/'])
                .next()
                .filter(|name| !name.is_empty())
                .map(str::to_owned);
            self.ledger
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .push(item);
            self.reporter.tick(current_name);
        }

        /// Note a cancel request at the point the Shell is about to touch an item.
        /// Nothing can be refused from here, but a developer reading the log can see
        /// that the request arrived while the batch was in flight.
        fn note_cancel(&self) {
            if self.cancel.load(Ordering::SeqCst) {
                tracing::debug!("a cancel was requested while this shell operation was running");
            }
        }
    }

    impl IFileOperationProgressSink_Impl for Sink_Impl {
        fn StartOperations(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn FinishOperations(&self, _hrresult: HRESULT) -> windows::core::Result<()> {
            Ok(())
        }

        fn PreRenameItem(
            &self,
            _dwflags: u32,
            _psiitem: windows::core::Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows::core::Result<()> {
            self.note_cancel();
            Ok(())
        }

        fn PostRenameItem(
            &self,
            _dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            psznewname: &PCWSTR,
            hrrename: HRESULT,
            psinewlycreated: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            self.record(post_item(
                FileOperationKind::Rename,
                psiitem.as_ref(),
                psznewname,
                hrrename,
                psinewlycreated.as_ref(),
            ));
            Ok(())
        }

        fn PreMoveItem(
            &self,
            _dwflags: u32,
            _psiitem: windows::core::Ref<'_, IShellItem>,
            _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows::core::Result<()> {
            self.note_cancel();
            Ok(())
        }

        fn PostMoveItem(
            &self,
            _dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &PCWSTR,
            hrmove: HRESULT,
            psinewlycreated: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            self.record(post_item(
                FileOperationKind::Move,
                psiitem.as_ref(),
                psznewname,
                hrmove,
                psinewlycreated.as_ref(),
            ));
            Ok(())
        }

        fn PreCopyItem(
            &self,
            _dwflags: u32,
            _psiitem: windows::core::Ref<'_, IShellItem>,
            _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows::core::Result<()> {
            self.note_cancel();
            Ok(())
        }

        fn PostCopyItem(
            &self,
            _dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &PCWSTR,
            hrcopy: HRESULT,
            psinewlycreated: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            self.record(post_item(
                FileOperationKind::Copy,
                psiitem.as_ref(),
                psznewname,
                hrcopy,
                psinewlycreated.as_ref(),
            ));
            Ok(())
        }

        fn PreDeleteItem(
            &self,
            _dwflags: u32,
            _psiitem: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            self.note_cancel();
            Ok(())
        }

        fn PostDeleteItem(
            &self,
            _dwflags: u32,
            psiitem: windows::core::Ref<'_, IShellItem>,
            hrdelete: HRESULT,
            _psinewlycreated: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            // No name and no created item: a delete leaves nothing behind, and the
            // contract's `destination` stays `None` so the UI refreshes the parent.
            self.record(post_item(
                FileOperationKind::Delete,
                psiitem.as_ref(),
                &PCWSTR::null(),
                hrdelete,
                None,
            ));
            Ok(())
        }

        fn PreNewItem(
            &self,
            _dwflags: u32,
            _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            _psznewname: &PCWSTR,
        ) -> windows::core::Result<()> {
            self.note_cancel();
            Ok(())
        }

        fn PostNewItem(
            &self,
            _dwflags: u32,
            _psidestinationfolder: windows::core::Ref<'_, IShellItem>,
            psznewname: &PCWSTR,
            _psztemplatename: &PCWSTR,
            _dwfileattributes: u32,
            hrnew: HRESULT,
            psinewitem: windows::core::Ref<'_, IShellItem>,
        ) -> windows::core::Result<()> {
            self.record(post_item(
                FileOperationKind::Create,
                None,
                psznewname,
                hrnew,
                psinewitem.as_ref(),
            ));
            Ok(())
        }

        /// Ignored on purpose: these counts are items, not bytes, and the contract
        /// requires indeterminate progress rather than a percentage built from them.
        fn UpdateProgress(&self, _iworktotal: u32, _iworksofar: u32) -> windows::core::Result<()> {
            Ok(())
        }

        fn ResetTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn PauseTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }

        fn ResumeTimer(&self) -> windows::core::Result<()> {
            Ok(())
        }
    }
}

/// Wrap the numeric flag set in the SDK type, so the mapping table above can stay
/// plain `u32` and be tested on every platform.
#[cfg(windows)]
fn shell_flags_of(flags: u32) -> windows::Win32::UI::Shell::FILEOPERATION_FLAGS {
    windows::Win32::UI::Shell::FILEOPERATION_FLAGS(flags)
}

// ───────────────────────────── tests ─────────────────────────────

#[cfg(test)]
mod tests {
    use std::time::Instant;

    use super::*;

    fn request(op: FileOperationKind) -> FileOperationIn {
        FileOperationIn {
            op,
            sources: vec![],
            destination: None,
            new_name: None,
            to_recycle_bin: true,
            conflict: FileConflictPolicy::default(),
            request_token: None,
        }
    }

    fn copy(sources: &[&str], destination: &str) -> FileOperationIn {
        FileOperationIn {
            op: FileOperationKind::Copy,
            sources: sources.iter().map(|s| (*s).to_owned()).collect(),
            destination: Some(destination.to_owned()),
            new_name: None,
            to_recycle_bin: true,
            conflict: FileConflictPolicy::default(),
            request_token: None,
        }
    }

    fn item(source: &str, outcome: FileItemOutcome) -> FileOperationItem {
        FileOperationItem {
            source: source.to_owned(),
            destination: None,
            outcome,
            reason: None,
            message: None,
        }
    }

    /// Every rule the host owns, as a table. The UI must not have to duplicate any
    /// of it, so each row is asserted through the same helper the platform code
    /// runs on.
    #[test]
    fn start_rejects_every_request_the_ui_should_never_send() {
        let cases: Vec<(String, FileOperationIn)> = vec![
            (
                "no sources".into(),
                request(FileOperationKind::Delete),
            ),
            (
                "blank source".into(),
                FileOperationIn {
                    sources: vec!["   ".into()],
                    ..request(FileOperationKind::Delete)
                },
            ),
            (
                "relative source".into(),
                FileOperationIn {
                    sources: vec!["relative/note.txt".into()],
                    ..request(FileOperationKind::Delete)
                },
            ),
            (
                "source with a NUL".into(),
                FileOperationIn {
                    sources: vec!["C:\\a\0b.txt".into()],
                    ..request(FileOperationKind::Delete)
                },
            ),
            (
                "rename of two items".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into(), "C:\\b.txt".into()],
                    new_name: Some("c".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "create of two items".into(),
                FileOperationIn {
                    sources: vec!["C:\\a".into(), "C:\\b".into()],
                    destination: Some("C:\\dst".into()),
                    new_name: Some("新建文件夹".into()),
                    ..request(FileOperationKind::Create)
                },
            ),
            (
                "rename without a name".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "blank name".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    new_name: Some("  ".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "name with a slash".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    new_name: Some("a/b".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "name with a backslash".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    new_name: Some(r"a\b".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "dot".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    new_name: Some(".".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "dot dot".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    new_name: Some("..".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "name that is a path".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    new_name: Some("C:\\b\\c.txt".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "name with reserved characters".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    new_name: Some("a<b>:c|d?.txt".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "name ending in a dot".into(),
                FileOperationIn {
                    sources: vec!["C:\\a.txt".into()],
                    new_name: Some("a.".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "copy without a destination".into(),
                FileOperationIn {
                    destination: None,
                    ..copy(&["C:\\a.txt"], "C:\\dst")
                },
            ),
            (
                "move without a destination".into(),
                FileOperationIn {
                    op: FileOperationKind::Move,
                    destination: None,
                    sources: vec!["C:\\a.txt".into()],
                    ..request(FileOperationKind::Move)
                },
            ),
            (
                "blank destination".into(),
                copy(&["C:\\a.txt"], "  "),
            ),
            (
                "relative destination".into(),
                copy(&["C:\\a.txt"], "dst"),
            ),
            (
                "create without a destination".into(),
                FileOperationIn {
                    new_name: Some("新建文件夹".into()),
                    ..request(FileOperationKind::Create)
                },
            ),
            (
                "create without a name".into(),
                FileOperationIn {
                    destination: Some("C:\\dst".into()),
                    ..request(FileOperationKind::Create)
                },
            ),
            (
                "destination is the source".into(),
                copy(&["C:\\a"], "C:\\a"),
            ),
            (
                "destination inside the source".into(),
                copy(&["C:\\a"], "C:\\a\\b"),
            ),
            (
                "move destination inside the source".into(),
                FileOperationIn {
                    op: FileOperationKind::Move,
                    ..copy(&["C:\\Projects"], "C:\\Projects\\out")
                },
            ),
            (
                "destination equals one source of many".into(),
                copy(&["C:\\a.txt", "C\\b"], "C:\\a.txt"),
            ),
            (
                "rename onto itself".into(),
                FileOperationIn {
                    sources: vec!["C:\\dir\\a.txt".into()],
                    new_name: Some("a.txt".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
            (
                "rename onto itself ignoring case".into(),
                FileOperationIn {
                    sources: vec!["C:\\dir\\Report.md".into()],
                    new_name: Some("report.MD".into()),
                    ..request(FileOperationKind::Rename)
                },
            ),
        ];

        for (label, req) in cases {
            let err = validate(&req)
                .expect_err(&label)
                .to_string();
            assert!(
                err.starts_with("invalid argument:"),
                "{label}: the frontend classifies on this prefix, got `{err}`"
            );
        }
    }

    /// The same table's other side: legal requests must pass, and pass with the
    /// paths normalised the way the Shell needs them.
    #[test]
    fn legal_requests_survive_validation() {
        let plan = validate(&copy(
            &["C:\\Users\\me\\报告 v1.txt", r"\\?\C:\Windows\explorer.exe"],
            r"\\?\C:\tmp",
        ))
        .expect("a legal copy never errors");
        assert_eq!(plan.op, FileOperationKind::Copy);
        assert_eq!(plan.total(), 2);
        assert_eq!(plan.sources[1], "C:\\Windows\\explorer.exe", "verbatim stripped");
        assert_eq!(plan.destination.as_deref(), Some(r"C:\tmp"));
        // Copy ignores a stray name: it must never become a silent rename.
        assert_eq!(plan.new_name, None);
        assert!(plan.landing_path.is_none());

        let plan = validate(&FileOperationIn {
            op: FileOperationKind::Delete,
            sources: vec![r"C:\a\空格 目录".into()],
            to_recycle_bin: false,
            ..request(FileOperationKind::Delete)
        })
        .expect("delete of one path");
        assert!(!plan.to_recycle_bin);

        let plan = validate(&FileOperationIn {
            sources: vec!["C:\\dir\\a.txt".into()],
            new_name: Some("b.txt".into()),
            ..request(FileOperationKind::Rename)
        })
        .expect("a real rename");
        assert_eq!(plan.landing_path.as_deref(), Some(r"C:\dir\b.txt"));

        // 新建文件夹 from a blank-area menu: nothing is selected, so `sources` is
        // empty and the created path is what the result must name.
        let plan = validate(&FileOperationIn {
            op: FileOperationKind::Create,
            destination: Some("C:\\dst".into()),
            new_name: Some("新建文件夹".into()),
            ..request(FileOperationKind::Create)
        })
        .expect("create needs no selection");
        assert_eq!(plan.total(), 1);
        assert_eq!(plan.items_to_report(), vec![r"C:\dst\新建文件夹"]);

        // A stray `newName` on delete is not honoured.
        let plan = validate(&FileOperationIn {
            sources: vec!["C:\\a".into()],
            new_name: Some("whatever".into()),
            ..request(FileOperationKind::Delete)
        })
        .expect("delete ignores newName");
        assert_eq!(plan.new_name, None);
        assert_eq!(plan.destination, None);
    }

    /// `start()` is the layer that runs before the platform boundary, so the same
    /// rejections must surface from it without a Shell call ever being made — a
    /// refused request never enters the live table either, which is what keeps
    /// `cancel()` honest.
    #[test]
    fn a_refused_request_never_reaches_the_platform() {
        let ops = ShellOps::new();
        for req in [
            request(FileOperationKind::Delete),
            copy(&["relative.txt"], "C:\\dst"),
            FileOperationIn {
                sources: vec!["C:\\a.txt".into()],
                new_name: Some("a/b".into()),
                ..request(FileOperationKind::Rename)
            },
        ] {
            let err = ops
                .start(&req)
                .expect_err("validation runs ahead of the platform");
            assert!(err.to_string().starts_with("invalid argument:"), "{err}");
            assert!(ops.shared.live.lock().unwrap().is_empty(), "{err}");
        }
    }

    #[test]
    fn placement_compares_directories_lexically() {
        use Placement::*;
        // `(source, destination, case-insensitive?, expected)` — the flag is a row
        // value rather than `CASE_INSENSITIVE_PATHS`, because both spellings have to
        // be checked on whichever host the tests run on: the rule protects user data,
        // and a rule only exercised under one platform's path comparison is a rule
        // half-tested.
        for (source, destination, case_insensitive, expected) in [
            (r"C:\a", r"C:\a", true, Same),
            (r"C:\a\", r"C:\a", true, Same),
            (r"C:\a", r"C:\A", true, Same),
            (r"C:\a", r"c:\A", false, Outside),
            (r"C:\a", r"C:\A", false, Outside),
            (r"C:\a", r"C:\a\b", true, Inside),
            (r"C:\a", r"C:\a\b\c", true, Inside),
            // A sibling that merely shares a prefix is not "inside".
            (r"C:\a", r"C:\ab", true, Outside),
            (r"C:\a", r"D:\a", true, Outside),
            (r"C:\a", r"C:\b", true, Outside),
            (r"/srv/data", "/srv/data/backup", true, Inside),
            (r"/srv/data", "/srv/other", true, Outside),
        ] {
            assert_eq!(
                placement_of(source, destination, case_insensitive),
                expected,
                "{source} vs {destination} (ci={case_insensitive})"
            );
        }
    }

    #[test]
    fn path_shapes_are_recognised() {
        for path in [
            r"C:\a",
            r"C:/a",
            r"\\server\share\a",
            r"\\?\Volume{guid}\a",
            "/tmp/a",
        ] {
            assert!(has_root(path), "{path} must be rooted");
        }
        for path in ["a.txt", r".\a", "..\\a", ""] {
            assert!(!has_root(path), "{path} must not be rooted");
        }

        assert!(looks_like_path(r"C:\a\b"));
        assert!(looks_like_path("a/b"));
        assert!(looks_like_path(r"C:relative"));
        assert!(!looks_like_path("报告 v1.txt"));

        for name in ["a.txt", "新建文件夹", "a-b_c. (1)", "报告", ".gitignore"] {
            assert!(name_is_legal(name), "{name} must be legal");
        }
        for name in [
            "", ".", "..", "a<b", "a>b", "a:b", "a\"b", "a|b", "a?b", "a*b", "a.", "a ",
            "a\u{1}b",
        ] {
            assert!(!name_is_legal(name), "{name} must be illegal");
        }
    }

    #[test]
    fn verbatim_paths_are_made_shell_parseable() {
        assert_eq!(shell_path(r"\\?\C:\Windows\explorer.exe"), r"C:\Windows\explorer.exe");
        assert_eq!(shell_path(r"\\?\UNC\server\share\a.png"), r"\\server\share\a.png");
        let absolute = shell_path(r"C:\Windows\explorer.exe");
        assert!(
            absolute.eq_ignore_ascii_case(r"C:\Windows\explorer.exe"),
            "{absolute}"
        );
    }

    /// The mapping the whole file exists to produce, as a table: this is the one
    /// place a wrong flag would cost a user their files, and it is checked without
    /// a Shell.
    #[test]
    fn flags_carry_recycle_bin_and_conflict_intent() {
        // Both enums have a `Rename`, so nothing is glob-imported: every variant
        // below is spelled with its enum, which is also what makes the table readable.
        let recycle = shell_flags::FOFX_RECYCLEONDELETE;
        let undo = shell_flags::FOF_ALLOWUNDO;
        let nuke = shell_flags::FOF_WANTNUKEWARNING;
        let rename = shell_flags::FOF_RENAMEONCOLLISION;
        let yes_all = shell_flags::FOF_NOCONFIRMATION;
        let silent = 0x0004;
        let no_errors = 0x0400;
        let simple = 0x0000_0100;

        for conflict in [
            FileConflictPolicy::Fail,
            FileConflictPolicy::Rename,
            FileConflictPolicy::Overwrite,
        ] {
            for op in [
                FileOperationKind::Copy,
                FileOperationKind::Move,
                FileOperationKind::Rename,
                FileOperationKind::Create,
            ] {
                let flags = operation_flags(op, true, conflict);
                assert_eq!(flags & recycle, 0, "only a delete may ask for the bin");
                // Never mute the Shell's own UI (spec: 系统对话框是权威界面).
                assert_eq!(flags & silent, 0, "{op:?}/{conflict:?} hid the progress dialog");
                assert_eq!(flags & simple, 0, "{op:?}/{conflict:?} replaced the progress dialog");
                assert_eq!(flags & no_errors, 0, "{op:?}/{conflict:?} hid errors as Ignore");
                assert_ne!(flags & undo, 0, "{op:?}/{conflict:?} dropped undo");
            }
        }

        // fail: no collision knob at all, so the Shell prompts and nothing is
        // silently overwritten — the conservative reading of the contract default.
        let fail = operation_flags(FileOperationKind::Copy, true, FileConflictPolicy::Fail);
        assert_eq!(fail & rename, 0);
        assert_eq!(fail & yes_all, 0, "fail must never answer Yes to All");

        let renamed = operation_flags(FileOperationKind::Copy, true, FileConflictPolicy::Rename);
        assert_ne!(renamed & rename, 0);
        assert_ne!(renamed & shell_flags::FOFX_PRESERVEFILEEXTENSIONS, 0);
        assert_eq!(renamed & yes_all, 0, "auto-rename still needs no prompt");

        assert_ne!(
            operation_flags(FileOperationKind::Copy, true, FileConflictPolicy::Overwrite) & yes_all,
            0
        );

        // Delete: the bin by default, and an explicit non-recycle delete is allowed
        // to destroy nothing without warning the user first.
        let to_bin = operation_flags(FileOperationKind::Delete, true, FileConflictPolicy::Fail);
        assert_ne!(to_bin & recycle, 0);
        assert_eq!(to_bin & nuke, 0);
        let permanent = operation_flags(FileOperationKind::Delete, false, FileConflictPolicy::Fail);
        assert_eq!(permanent & recycle, 0);
        assert_ne!(permanent & nuke, 0, "a permanent delete must warn");
        // The nuke warning is documented as surviving Yes-to-All, so the combination
        // the contract allows (overwrite + permanent delete) still warns.
        let both = operation_flags(FileOperationKind::Delete, false, FileConflictPolicy::Overwrite);
        assert_ne!(both & nuke, 0);
        assert_ne!(both & yes_all, 0);
    }

    #[test]
    fn hresults_become_the_reason_the_ui_can_present() {
        // `HRESULT_FROM_WIN32` shape.
        assert_eq!(win32_code_of(0x8007_0002), Some(2));
        assert_eq!(win32_code_of(0x8007_04A7), Some(0x4A7)); // 1223
        assert_eq!(win32_code_of(0x8027_002C), None, "Shell facility is not Win32");
        assert_eq!(win32_code_of(0x0000_0000), None, "a success code is not an error");

        for (code, expected) in [
            (2u32, FileFailureReason::NotFound),
            (3, FileFailureReason::NotFound),
            (5, FileFailureReason::Denied),
            (32, FileFailureReason::Denied),
            (33, FileFailureReason::Denied),
            (1314, FileFailureReason::Denied),
            (80, FileFailureReason::Exists),
            (183, FileFailureReason::Exists),
            (19, FileFailureReason::ReadOnly),
            (3027, FileFailureReason::ReadOnly),
            (39, FileFailureReason::DiskFull),
            (112, FileFailureReason::DiskFull),
            (1223, FileFailureReason::CancelledByShell),
            (9999, FileFailureReason::Other),
        ] {
            assert_eq!(reason_of_win32_code(code), expected, "code {code}");
            // And through the HRESULT wrapper the sink actually receives.
            let wrapped = 0x8007_0000 | code;
            assert_eq!(reason_of_hresult(wrapped), expected, "HRESULT of {code}");
        }
        assert_eq!(
            reason_of_hresult(0x8027_002C),
            FileFailureReason::CancelledByShell,
            "VP_E_USERCANCEL is a user abort, not `other`"
        );
        assert_eq!(reason_of_hresult(0x8000_ffff), FileFailureReason::Other);
    }

    /// The state machine, which is the difference between telling a user their files
    /// moved and telling them the truth.
    #[test]
    fn terminal_state_reads_the_item_list_the_shell_left() {
        let all_done = vec![item("a", FileItemOutcome::Completed), item("b", FileItemOutcome::Renamed)];
        assert_eq!(
            terminal_state(&all_done, false, false),
            FileOperationState::Completed
        );
        // An abort outranks a clean-looking list: the Shell said it stopped.
        assert_eq!(
            terminal_state(&all_done, true, false),
            FileOperationState::Cancelled
        );

        let mixed = vec![
            item("a", FileItemOutcome::Completed),
            item("b", FileItemOutcome::Failed),
        ];
        assert_eq!(
            terminal_state(&mixed, false, false),
            FileOperationState::PartialFailure
        );
        // A skipped collision (the user chose Skip) is not a completion.
        let skipped = vec![
            item("a", FileItemOutcome::Completed),
            item("b", FileItemOutcome::Skipped),
        ];
        assert_eq!(
            terminal_state(&skipped, false, false),
            FileOperationState::PartialFailure
        );

        let none_done = vec![item("a", FileItemOutcome::Failed), item("b", FileItemOutcome::Cancelled)];
        assert_eq!(
            terminal_state(&none_done, false, false),
            FileOperationState::Failed
        );
        // The engine call itself failed: the batch did not happen, whatever some
        // items claim.
        assert_eq!(
            terminal_state(&all_done, false, true),
            FileOperationState::Failed
        );
        // No verdicts at all: nothing can be claimed.
        assert_eq!(
            terminal_state(&[], false, false),
            FileOperationState::Failed
        );
        assert_eq!(
            terminal_state(&[], true, false),
            FileOperationState::Cancelled
        );
    }

    #[test]
    fn volume_identity_is_compared_not_guessed() {
        // Same volume, three spellings.
        assert!(!is_cross_volume(Some(r"C:\"), Some(r"C:\")));
        assert!(!is_cross_volume(Some(r"C:\"), Some("c:\\")));
        assert!(!is_cross_volume(
            Some(r"\\?\Volume{11111111-2222-3333-4444-555555555555}\"),
            Some(r"\\?\Volume{11111111-2222-3333-4444-555555555555}\")
        ));
        assert!(!is_cross_volume(
            Some(r"\\server\share\"),
            Some(r"\\SERVER\share\")
        ));

        // Different volumes.
        assert!(is_cross_volume(Some(r"C:\"), Some(r"D:\")));
        assert!(is_cross_volume(
            Some(r"\\?\Volume{11111111-0000-0000-0000-000000000000}\"),
            Some(r"\\?\Volume{22222222-0000-0000-0000-000000000000}\")
        ));
        assert!(is_cross_volume(Some(r"C:\"), Some(r"\\server\share\")));

        // Unknown: report "not cross-volume" rather than invent a distinction.
        assert!(!is_cross_volume(None, Some(r"D:\")));
        assert!(!is_cross_volume(Some(r"C:\"), None));

        assert_eq!(volume_key(r"C:\\", true), "c:");
        assert_eq!(volume_key(r"\\?\Volume{abc}\", true), r"volume{abc}");
        assert_eq!(volume_key("/mnt/data/", false), "/mnt/data");
    }

    /// Cancel semantics the UI branches on: unknown, live and finished ids must be
    /// distinguishable, because a card that keeps offering 取消 for a finished job is
    /// a bug the contract explicitly forbids.
    #[test]
    fn cancel_tracks_only_live_operations() {
        let ops = ShellOps::new();
        assert!(!ops.cancel("op-does-not-exist").unwrap(), "unknown id");

        let flag = Arc::new(AtomicBool::new(false));
        lock(&ops.shared.live).insert(
            "op-1".to_owned(),
            LiveOperation {
                cancel: Arc::clone(&flag),
                total: 3,
                request_token: Some("tok".to_owned()),
            },
        );
        assert!(ops.cancel("op-1").unwrap(), "a live operation takes the request");
        assert!(flag.load(Ordering::SeqCst), "and sets its flag");

        // A second cancel is still accepted while it lives (idempotent: the flag is
        // already set, and the UI may retry).
        assert!(ops.cancel("op-1").unwrap());
        // An id that never entered the table stays `false` even now that the table
        // has entries: presence is the whole answer.
        assert!(!ops.cancel("op-2").unwrap(), "never-live ids are not cancellable");

        // The operation reaching a terminal state is what retires it.
        ops.shared.retire("op-1");
        assert!(!ops.cancel("op-1").unwrap(), "a finished id is not cancellable");
    }

    #[test]
    fn an_operation_without_an_emitter_still_completes() {
        // No `attach()` call: the result must be logged, not lost, and the ack must
        // not fail. On Windows the batch would need a real Shell, so this test only
        // exercises the emitter-free event path.
        let ops = ShellOps::new();
        assert!(ops.shared.emitter().is_none());
        ops.shared.progress(progress_of(
            "op-1",
            FileOperationState::Running,
            &Plan {
                op: FileOperationKind::Delete,
                sources: vec!["C:\\a".into()],
                destination: None,
                new_name: None,
                to_recycle_bin: true,
                conflict: FileConflictPolicy::default(),
                request_token: None,
                landing_path: None,
            },
            None,
        ));
        ops.shared.finish(build_result(
            &Plan {
                op: FileOperationKind::Delete,
                sources: vec!["C:\\a".into()],
                destination: None,
                new_name: None,
                to_recycle_bin: true,
                conflict: FileConflictPolicy::default(),
                request_token: None,
                landing_path: None,
            },
            "op-1",
            vec![item("C:\\a", FileItemOutcome::Completed)],
            false,
            false,
            false,
        ));
    }

    #[test]
    fn refused_items_distinguish_a_cancel_from_a_failure() {
        let cancelled = refused_item(
            "C:\\a",
            FileFailureReason::CancelledByShell,
            "操作已取消，未提交给 Shell",
        );
        assert_eq!(cancelled.outcome, FileItemOutcome::Cancelled);
        assert_eq!(cancelled.reason, Some(FileFailureReason::CancelledByShell));

        let denied = refused_item("C:\\b", FileFailureReason::Denied, "无权访问");
        assert_eq!(denied.outcome, FileItemOutcome::Failed);

        let unsupported = refused_item("C:\\c", FileFailureReason::Unsupported, "无引擎");
        assert_eq!(unsupported.outcome, FileItemOutcome::Failed);
        assert_eq!(unsupported.destination, None);
    }

    /// The wire names are the contract (mirrored by the TS SDK and guarded by
    /// `fm-contract-dump`), restated here because the provider is what fills them in.
    #[test]
    fn the_wire_shape_of_an_ack_and_a_result_is_frozen() {
        let ack = serde_json::to_value(FileOperationOut {
            operation_id: "op-7".into(),
            state: FileOperationState::Queued,
            total: 2,
            indeterminate: true,
        })
        .unwrap();
        assert_eq!(
            ack,
            serde_json::json!({
                "operationId": "op-7",
                "state": "queued",
                "total": 2,
                "indeterminate": true
            })
        );

        let result = serde_json::to_value(build_result(
            &Plan {
                op: FileOperationKind::Copy,
                sources: vec!["C:\\a".into()],
                destination: Some("D:\\b".into()),
                new_name: None,
                to_recycle_bin: true,
                conflict: FileConflictPolicy::default(),
                request_token: Some("tok".into()),
                landing_path: None,
            },
            "op-7",
            vec![
                item("C:\\a", FileItemOutcome::Completed),
                FileOperationItem {
                    source: "C:\\c".into(),
                    destination: None,
                    outcome: FileItemOutcome::Failed,
                    reason: Some(FileFailureReason::CancelledByShell),
                    message: None,
                },
            ],
            false,
            false,
            true,
        ))
        .unwrap();
        assert_eq!(result["state"], "partial-failure");
        assert_eq!(result["operationId"], "op-7");
        assert_eq!(result["requestToken"], "tok");
        assert_eq!(result["crossVolumeMove"], true);
        assert_eq!(result["items"][1]["reason"], "cancelled-by-shell");
        assert_eq!(result["items"][1]["outcome"], "failed");
        // `Option` fields stay present as null: skipping them would silently widen
        // the TS interface, which the contract test forbids.
        assert_eq!(result["items"][0]["message"], serde_json::Value::Null);
        assert_eq!(result["items"][0]["destination"], serde_json::Value::Null);

        let progress = serde_json::to_value(progress_of(
            "op-7",
            FileOperationState::Cancelling,
            &Plan {
                op: FileOperationKind::Delete,
                sources: vec!["C:\\a".into()],
                destination: None,
                new_name: None,
                to_recycle_bin: true,
                conflict: FileConflictPolicy::default(),
                request_token: None,
                landing_path: None,
            },
            Some("a.txt".into()),
        ))
        .unwrap();
        assert_eq!(
            progress,
            serde_json::json!({
                "operationId": "op-7",
                "state": "cancelling",
                "requestToken": null,
                "processed": 0,
                "total": 1,
                "indeterminate": true,
                "currentName": "a.txt"
            })
        );
    }

    /// The gate bounds concurrency exactly like the thumbnail provider bounds
    /// extraction, and the permit-outliving-the-caller rule matters here too: the
    /// Shell call owns the slot, not the thread that asked for it.
    #[test]
    fn the_operation_gate_holds_two_slots() {
        let gate = Arc::new(gate::Semaphore::new(MAX_INFLIGHT_OPERATIONS));
        let deadline = Instant::now() + Duration::from_secs(5);
        let first = gate.acquire_until(deadline).expect("first slot");
        let second = gate.acquire_until(deadline).expect("second slot");
        assert_eq!(gate.available(), 0, "both slots are taken");
        assert!(
            gate.acquire_until(Instant::now()).is_none(),
            "a third operation with an expired deadline gives up rather than queue"
        );
        drop(first);
        assert_eq!(gate.available(), 1);
        drop(second);
        assert_eq!(gate.available(), MAX_INFLIGHT_OPERATIONS);
    }

    /// Pinned against the real SDK bindings; named so it does not shadow the
    /// `windows` crate the bodies import.
    #[cfg(windows)]
    mod sdk_pin {
        use super::*;

        /// A wrong flag literal would silently cost a user their recycle bin, so the
        /// hand-written table is pinned against the SDK's own constants.
        #[test]
        fn the_flag_literals_match_the_sdk() {
            use ::windows::Win32::UI::Shell::{
                FILEOPERATION_FLAGS, FOF_ALLOWUNDO, FOF_NOCONFIRMMKDIR, FOF_NOCONFIRMATION,
                FOF_RENAMEONCOLLISION, FOF_WANTNUKEWARNING, FOFX_PRESERVEFILEEXTENSIONS,
                FOFX_RECYCLEONDELETE,
            };
            for (name, ours, sdk) in [
                ("FOF_RENAMEONCOLLISION", shell_flags::FOF_RENAMEONCOLLISION, FOF_RENAMEONCOLLISION),
                ("FOF_NOCONFIRMATION", shell_flags::FOF_NOCONFIRMATION, FOF_NOCONFIRMATION),
                ("FOF_ALLOWUNDO", shell_flags::FOF_ALLOWUNDO, FOF_ALLOWUNDO),
                ("FOF_NOCONFIRMMKDIR", shell_flags::FOF_NOCONFIRMMKDIR, FOF_NOCONFIRMMKDIR),
                ("FOF_WANTNUKEWARNING", shell_flags::FOF_WANTNUKEWARNING, FOF_WANTNUKEWARNING),
                ("FOFX_RECYCLEONDELETE", shell_flags::FOFX_RECYCLEONDELETE, FOFX_RECYCLEONDELETE),
                (
                    "FOFX_PRESERVEFILEEXTENSIONS",
                    shell_flags::FOFX_PRESERVEFILEEXTENSIONS,
                    FOFX_PRESERVEFILEEXTENSIONS,
                ),
            ] {
                assert_eq!(
                    shell_flags_of(ours),
                    FILEOPERATION_FLAGS(sdk.0),
                    "{name} is spelled wrong"
                );
            }
        }

        /// Same argument for the HRESULT table: these are the codes that decide
        /// whether the UI says 文件已不存在 or 没有权限.
        #[test]
        fn the_hresult_literals_match_the_sdk() {
            use ::windows::core::HRESULT;
            use ::windows::Win32::Foundation::{
                ERROR_ACCESS_DENIED, ERROR_ALREADY_EXISTS, ERROR_CANCELLED,
                ERROR_DISK_FULL, ERROR_FILE_NOT_FOUND, ERROR_SHARING_VIOLATION,
            };
            let cases = [
                (ERROR_FILE_NOT_FOUND, FileFailureReason::NotFound),
                (ERROR_ACCESS_DENIED, FileFailureReason::Denied),
                (ERROR_SHARING_VIOLATION, FileFailureReason::Denied),
                (ERROR_ALREADY_EXISTS, FileFailureReason::Exists),
                (ERROR_DISK_FULL, FileFailureReason::DiskFull),
                (ERROR_CANCELLED, FileFailureReason::CancelledByShell),
            ];
            for (code, expected) in cases {
                let hr: HRESULT = HRESULT::from_win32(code.0);
                assert_eq!(
                    reason_of_hresult(hr.0 as u32),
                    expected,
                    "{code:?} must map to {expected:?}"
                );
            }
        }

        /// The volume-root read is the one Windows call here that cannot be faked,
        /// so it is exercised on a path that exists on every Windows install — no
        /// file is created, moved or deleted by this test.
        #[test]
        fn a_real_volume_root_normalises_to_a_drive() {
            let temp = std::env::temp_dir().to_string_lossy().into_owned();
            // Reached through the platform module's own path so the wrapper stays
            // private: it is a plain Win32 read, no COM, no mutation.
            let root = crate::capabilities::shell_ops::platform::probe_volume_root(&temp)
                .expect("GetVolumePathNameW for the temp dir");
            let key = volume_key(&root, CASE_INSENSITIVE_PATHS);
            assert!(
                key.contains("volume{") || key.ends_with(':'),
                "unexpected volume root {root:?} normalised to {key:?}"
            );
        }
    }
}
