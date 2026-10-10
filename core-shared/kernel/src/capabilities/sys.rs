//! Disk volume metadata and cancellable recursive size scans (`sys.*`, P7-23).
//!
//! Two halves, one reason to exist: the space-analysis panel has to answer "what
//! is using this volume, and which directory inside it" without the WebView ever
//! holding a file list of its own.
//!
//! * `sys.disk.list` reads the platform's own volume accounting — bytes, never
//!   percentages — and puts the volume containing the caller's path **first**,
//!   because that is the one the panel labels.
//! * `sys.scan.start` queues a job and returns an id. Everything else arrives as
//!   `scan:progress` / `scan:done`, for the same reason Shell file operations do:
//!   the work outlives any request timeout, and a tree of a hundred thousand
//!   entries is not something to hand back on a call stack.
//!
//! The traversal is **parallel** (a pool of OS threads pulling directories off
//! one work queue) and **cancellable** (one flag per job, checked before every
//! entry). It cannot stall the rest of the app because it never runs on an async
//! worker: the job owns its threads, and event publication goes through the same
//! `block_on` bridge [`super::shell_ops`] uses.
//!
//! Byte discipline, which is the whole point of doing this in Rust rather than in
//! a panel loop:
//! - a directory's `bytes` is a **subtree total**, folded up the parent chain as
//!   each successful listing lands, so no second pass and no estimate;
//! - a directory that could not be read contributes **nothing** and appears in
//!   `skipped` with a reason code — it is not silently an empty folder;
//! - links to directories are never followed (`symlink-skipped`), so a junction
//!   loop is structurally impossible rather than merely depth-bounded;
//! - the walk is bounded by [`SCAN_MAX_ENTRIES`]; what it did not reach is
//!   reported as `budget-exceeded` rather than counted as zero.
//!
//! Hard links are counted **per path** (their bytes are added wherever they are
//! visible). Deduplicating them needs a file identity the standard library does
//! not expose, and under-counting a real directory is the worse error. See
//! docs/04-roadmap.md batch 7 for the recorded decision.

use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::time::{Duration, Instant};

use cordis_core::{Context, Event, Routing};
use fm_contracts::capability::{
    CapabilityError, DiskListIn, DiskListOut, DiskVolume, ScanAck, ScanDone, ScanIn, ScanNode,
    ScanProgress, ScanSkipReason, ScanSkipped, ScanState, SysApi, SCAN_MAX_DEPTH, SCAN_MAX_ENTRIES,
    SCAN_PROGRESS_INTERVAL_MS, SCAN_TREE_DEPTH,
};
use fm_contracts::events::{ScanDoneEvent, ScanProgressEvent};
use tokio::runtime::Handle;

/// Ceiling on worker threads per scan: a scan is device-latency bound, and past a
/// handful of readers a spinning disk only gets thrashed.
const MAX_SCAN_WORKERS: usize = 8;

/// How many scans may run at once. Each owns threads and a work queue, so a
/// fourth is a consumer that lost track of the first three — refuse it loudly.
const MAX_LIVE_SCANS: usize = 3;

/// How often the walk republishes counters while it is making progress.
const PROGRESS_TICK: Duration = Duration::from_millis(SCAN_PROGRESS_INTERVAL_MS);

/// One entry inside a listed directory, as the worker saw it.
struct Hit {
    name: String,
    path: PathBuf,
    is_dir: bool,
    /// A link *to* a directory: counted as an entry, never descended into.
    dir_link: bool,
    bytes: u64,
    /// Lower-case extension without the dot, empty when there is none.
    ext: String,
}

/// The answer for one directory. `failed` replaces the whole listing rather than
/// accompanying a partial one: a directory that could not be read all the way
/// through did not contribute, and folding its half-read bytes in would put
/// invented numbers in the treemap.
struct Listing {
    node: usize,
    path: PathBuf,
    depth: u32,
    hits: Vec<Hit>,
    failed: Option<ScanSkipReason>,
}

/// A queued directory waiting to be read.
struct Job {
    node: usize,
    path: PathBuf,
    depth: u32,
}

/// The work queue. `closed` is set only by the combiner, and only when nothing is
/// queued and nothing is in flight — so a worker can never conclude the scan is
/// over while another one is still producing listings.
///
/// `inflight` and `pending` share one lock because the hand-over has to be
/// atomic: a worker that finished a directory is between "its listing is on the
/// way" and "its subdirectories are queued", and a worker looking at that gap
/// would quit with real work still owed to the scan. The combiner folds the
/// listing and re-queues under the same lock, so there is no empty moment to
/// observe.
struct Queue {
    state: Mutex<QueueState>,
    work: Condvar,
}

struct QueueState {
    pending: VecDeque<Job>,
    /// Jobs counted by [`Queue::submit`]: queued or read but not yet folded back
    /// in. Dropped only by `settle`/`abandon`.
    inflight: usize,
    closed: bool,
}

impl Queue {
    fn new() -> Self {
        Self {
            state: Mutex::new(QueueState {
                pending: VecDeque::new(),
                inflight: 0,
                closed: false,
            }),
            work: Condvar::new(),
        }
    }

    fn submit(&self, job: Job) {
        let mut state = lock(&self.state);
        if state.closed {
            return;
        }
        state.inflight += 1;
        state.pending.push_back(job);
        drop(state);
        self.work.notify_all();
    }

    /// Wait for the next directory. `None` means this worker is done: the walk is
    /// closed, or nothing is queued **and** nothing is in flight.
    fn take(&self) -> Option<Job> {
        let mut state = lock(&self.state);
        loop {
            if state.closed {
                return None;
            }
            if let Some(job) = state.pending.pop_front() {
                return Some(job);
            }
            if state.inflight == 0 {
                return None;
            }
            state = self
                .work
                .wait(state)
                .unwrap_or_else(PoisonError::into_inner);
        }
    }

    /// The listing for one job is folded in: release the job and queue what it
    /// discovered, as one step.
    fn settle(&self, derived: Vec<Job>) {
        let mut state = lock(&self.state);
        state.inflight = state.inflight.saturating_sub(1);
        if state.closed {
            // The walk ended around this listing. The directories it discovered
            // stay unqueued and uncounted rather than hanging the workers.
            drop(state);
            return;
        }
        state.inflight += derived.len();
        state.pending.extend(derived);
        drop(state);
        self.work.notify_all();
    }

    /// A job whose listing the walk will never see (cancelled mid-read, or the
    /// channel already gone).
    fn abandon(&self) {
        let mut state = lock(&self.state);
        state.inflight = state.inflight.saturating_sub(1);
        drop(state);
        self.work.notify_all();
    }

    fn drained(&self) -> bool {
        let state = lock(&self.state);
        state.inflight == 0 && state.pending.is_empty()
    }

    fn close(&self) {
        lock(&self.state).closed = true;
        self.work.notify_all();
    }

    fn is_closed(&self) -> bool {
        lock(&self.state).closed
    }

    fn leftover(&self) -> Vec<Job> {
        let mut state = lock(&self.state);
        state.closed = true;
        let jobs: Vec<Job> = state.pending.drain(..).collect();
        state.inflight = state.inflight.saturating_sub(jobs.len());
        drop(state);
        self.work.notify_all();
        jobs
    }
}

/// A node in the combiner's arena. `bytes` is already a subtree total.
struct Agg {
    name: String,
    path: PathBuf,
    is_dir: bool,
    bytes: u64,
    parent: Option<usize>,
    depth: u32,
    /// Immediate children kept for the delivered tree — only for directories
    /// above [`SCAN_TREE_DEPTH`], which is what bounds the payload.
    children: Vec<usize>,
    /// Every immediate child counted, whether or not it is in `children`.
    child_total: u64,
    kinds: HashMap<String, u64>,
}

/// What one scan produced. Kept out of the publishing path so a test can drive
/// the walk without a cordis runtime.
struct Walked {
    done: ScanDone,
    /// `true` when the entry ceiling stopped the walk.
    budget_stop: bool,
}

/// The cordis half of event delivery — the same `block_on` bridge
/// [`super::shell_ops`] uses, because a scan's threads live outside the runtime.
#[derive(Clone)]
struct Emitter {
    ctx: Context,
    handle: Handle,
}

impl Emitter {
    /// Drive one async emission to completion from a non-runtime thread. Legal
    /// only because every caller is a dedicated OS thread — from a Tokio worker
    /// `block_on` would panic, which is why the host never calls straight from a
    /// command body.
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
            tracing::warn!(
                event = E::NAME,
                error = %err,
                "scan event was not delivered"
            );
        }
    }
}

/// Bookkeeping shared by the capability and every live scan thread.
struct Shared {
    live: Mutex<HashMap<String, Arc<AtomicBool>>>,
    emitter: Mutex<Option<Emitter>>,
    next_id: AtomicU64,
}

impl Shared {
    fn emitter(&self) -> Option<Emitter> {
        lock(&self.emitter).clone()
    }

    fn progress(&self, args: ScanProgress) {
        match self.emitter() {
            Some(emitter) => emitter.drive::<ScanProgressEvent>(args),
            None => tracing::warn!(
                scan_id = %args.scan_id,
                entries = args.entries,
                "no event emitter attached yet: scan progress was dropped"
            ),
        }
    }

    /// The terminal payload is the only complete answer a scan ever gives, so a
    /// missing emitter is logged rather than swallowed.
    fn finish(&self, args: &ScanDone) {
        match self.emitter() {
            Some(emitter) => emitter.drive::<ScanDoneEvent>(args.clone()),
            None => tracing::warn!(
                scan_id = %args.scan_id,
                entries = args.entries,
                cancelled = args.cancelled,
                "no event emitter attached yet: scan result was dropped"
            ),
        }
    }

    fn retire(&self, scan_id: &str) {
        lock(&self.live).remove(scan_id);
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Removes a scan from the live table whatever happens to its thread, so a panic
/// mid-walk cannot leave `cancel_scan()` answering `true` forever.
struct LiveGuard {
    shared: Arc<Shared>,
    scan_id: String,
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.shared.retire(&self.scan_id);
    }
}

/// [`SysApi`] over platform volume accounting and a threaded directory walk.
pub struct Sys {
    shared: Arc<Shared>,
}

impl Default for Sys {
    fn default() -> Self {
        Self::new()
    }
}

impl Sys {
    /// A provider with no live scans and no event emitter (valid: results are
    /// logged instead of published).
    pub fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                live: Mutex::new(HashMap::new()),
                emitter: Mutex::new(None),
                next_id: AtomicU64::new(0),
            }),
        }
    }

    /// Attach the cordis context + runtime that carry `scan:*` events. Called from
    /// `CapabilitySet::publish`; safe to call late — a scan that finished before
    /// this had its result logged instead of published.
    pub fn attach(&self, ctx: Context, handle: Handle) {
        *lock(&self.shared.emitter) = Some(Emitter { ctx, handle });
    }

    /// Scans still in the live table — the count [`MAX_LIVE_SCANS`] is measured
    /// against, and what a finished walk removes itself from.
    pub fn live_scans(&self) -> usize {
        lock(&self.shared.live).len()
    }

    /// Reserve a scan id and its cancel flag, or refuse at the concurrency cap.
    /// Separate from the thread spawn so the cap is a fact about the table, not
    /// about whether a walk happens to be running at that instant.
    fn reserve(&self) -> Result<(String, Arc<AtomicBool>), CapabilityError> {
        let mut live = lock(&self.shared.live);
        if live.len() >= MAX_LIVE_SCANS {
            return Err(CapabilityError::InvalidArgument(format!(
                "too many scans are already running (limit {MAX_LIVE_SCANS})"
            )));
        }
        let n = self.shared.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let scan_id = format!("scan-{n}");
        let cancel = Arc::new(AtomicBool::new(false));
        live.insert(scan_id.clone(), Arc::clone(&cancel));
        Ok((scan_id, cancel))
    }
}

impl SysApi for Sys {
    fn disks(&self, req: &DiskListIn) -> Result<DiskListOut, CapabilityError> {
        let path = req.path.trim();
        if path.is_empty() {
            return Err(CapabilityError::InvalidArgument(
                "sys.disk.list needs a path".to_owned(),
            ));
        }
        Ok(DiskListOut {
            path: req.path.clone(),
            volumes: list_volumes(path)?,
        })
    }

    /// Validates the root **before** acking: a root that is not a directory must
    /// fail the call, because a queued job with nothing to read would leave the
    /// panel waiting for an event that describes nothing.
    fn start_scan(&self, req: &ScanIn) -> Result<ScanAck, CapabilityError> {
        let root = Path::new(req.root_path.trim());
        if root.as_os_str().is_empty() {
            return Err(CapabilityError::InvalidArgument(
                "sys.scan.start needs a root path".to_owned(),
            ));
        }
        let meta = fs::metadata(root).map_err(CapabilityError::from_io)?;
        if !meta.is_dir() {
            return Err(CapabilityError::InvalidArgument(format!(
                "not a directory: {}",
                req.root_path
            )));
        }

        let (scan_id, cancel) = self.reserve()?;
        let shared = Arc::clone(&self.shared);
        let root_path = req.root_path.clone();
        let id = scan_id.clone();
        let spawn = std::thread::Builder::new()
            .name(format!("fm-{id}"))
            .spawn(move || {
                let _guard = LiveGuard {
                    shared: Arc::clone(&shared),
                    scan_id: id.clone(),
                };
                let publisher = |args: ScanProgress| shared.progress(args);
                let walked = walk(&id, Path::new(&root_path), &cancel, &publisher);
                if walked.budget_stop {
                    tracing::info!(scan_id = %id, entries = walked.done.entries, "scan hit the entry ceiling");
                }
                shared.finish(&walked.done);
            });
        if let Err(err) = spawn {
            self.shared.retire(&scan_id);
            return Err(CapabilityError::Io(err.to_string()));
        }

        Ok(ScanAck {
            scan_id,
            state: ScanState::Queued,
            root_path: req.root_path.clone(),
        })
    }

    /// A cancel only sets the flag; the walk's own thread publishes the terminal
    /// `scan:done` with `cancelled: true`, so there is exactly one end to a scan.
    fn cancel_scan(&self, scan_id: &str) -> Result<bool, CapabilityError> {
        let cancel = lock(&self.shared.live).get(scan_id).cloned();
        match cancel {
            None => Ok(false),
            Some(flag) => {
                flag.store(true, Ordering::Release);
                Ok(true)
            }
        }
    }
}

/// Run one scan to its terminal payload, handing throttled counters to
/// `on_progress`.
///
/// Kept apart from event delivery on purpose: the numbers a scan produced are
/// assertable without a cordis runtime, which is what makes the byte discipline
/// above a tested fact instead of a comment.
fn walk(
    scan_id: &str,
    root: &Path,
    cancel: &AtomicBool,
    on_progress: &dyn Fn(ScanProgress),
) -> Walked {
    let started = Instant::now();
    let queue = Arc::new(Queue::new());
    let (tx, rx) = mpsc::channel::<Listing>();

    let mut arena: Vec<Agg> = Vec::new();
    let mut skipped: Vec<ScanSkipped> = Vec::new();
    let mut visited: HashSet<PathBuf> = HashSet::new();
    let root_canonical = canonical(root);
    visited.insert(root_canonical.clone());
    let root_id = arena.len();
    arena.push(dir_node(root, root_canonical, 0, None));
    queue.submit(Job {
        node: root_id,
        path: root.to_path_buf(),
        depth: 0,
    });

    let mut entries: u64 = 0;
    let mut current = root.to_path_buf();
    let mut last_emit = Instant::now();
    let mut budget_stop = false;
    let workers = worker_count();

    std::thread::scope(|scope| {
        let mut joins = Vec::with_capacity(workers);
        for _ in 0..workers {
            let queue = Arc::clone(&queue);
            let sender = tx.clone();
            joins.push(scope.spawn(move || worker(&queue, &sender, cancel)));
        }
        drop(tx);

        loop {
            if cancel.load(Ordering::Acquire) {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(listing) => {
                    current = listing.path.clone();
                    let derived = combine(listing, &mut arena, &mut skipped, &mut entries, &mut visited);
                    queue.settle(derived);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                // All senders dropped: the pool exited, so nothing more will land.
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if entries >= SCAN_MAX_ENTRIES {
                budget_stop = true;
                break;
            }
            if queue.drained() {
                break;
            }
            if last_emit.elapsed() >= PROGRESS_TICK {
                last_emit = Instant::now();
                on_progress(ScanProgress {
                    scan_id: scan_id.to_owned(),
                    path: current.display().to_string(),
                    entries,
                    bytes: arena[root_id].bytes,
                    skipped: skipped.clone(),
                    state: ScanState::Running,
                });
            }
        }

        // Close before joining: a worker blocked between directories has to see
        // that the walk is over, or `join` would wait for a job that will never
        // be queued again.
        queue.close();
        for join in joins {
            if join.join().is_err() {
                tracing::warn!("a scan worker thread panicked; its directories are not counted");
            }
        }
    });

    if budget_stop {
        // Whatever is still queued was never read: say so, and drop the zero-byte
        // stub so the treemap cannot present an unscanned directory as an empty one.
        for job in queue.leftover() {
            skipped.push(ScanSkipped {
                path: job.path.display().to_string(),
                reason: ScanSkipReason::BudgetExceeded,
            });
            detach(&mut arena, job.node);
        }
    }

    let mut truncated_at_depth = None;
    let tree = to_dto(&arena, root_id, &mut truncated_at_depth);
    let cancelled = cancel.load(Ordering::Acquire);
    Walked {
        done: ScanDone {
            scan_id: scan_id.to_owned(),
            tree,
            skipped,
            cancelled,
            truncated_at_depth,
            elapsed_ms: started.elapsed().as_millis() as u64,
            entries,
        },
        budget_stop,
    }
}

/// Worker half: take directories, read them, hand the whole answer back.
fn worker(queue: &Arc<Queue>, sender: &Sender<Listing>, cancel: &AtomicBool) {
    while !queue.is_closed() {
        let Some(job) = queue.take() else { break };
        let mut hits = Vec::new();
        let mut failed = None;
        match fs::read_dir(&job.path) {
            Ok(reader) => {
                for entry in reader {
                    if cancel.load(Ordering::Acquire) || queue.is_closed() {
                        break;
                    }
                    match entry {
                        Ok(de) => hits.push(hit_of(&de)),
                        Err(err) => {
                            failed = Some(classify(&err));
                            hits.clear();
                            break;
                        }
                    }
                }
            }
            Err(err) => failed = Some(classify(&err)),
        }
        if cancel.load(Ordering::Acquire) || queue.is_closed() {
            // The job belongs to nothing: the walk ends with what it already has.
            queue.abandon();
            return;
        }
        let listing = Listing {
            node: job.node,
            path: job.path,
            depth: job.depth,
            hits,
            failed,
        };
        if sender.send(listing).is_err() {
            queue.abandon();
            return;
        }
    }
}

/// Fold one directory answer into the arena, returning the subdirectories to read.
fn combine(
    listing: Listing,
    arena: &mut Vec<Agg>,
    skipped: &mut Vec<ScanSkipped>,
    entries: &mut u64,
    visited: &mut HashSet<PathBuf>,
) -> Vec<Job> {
    let Listing {
        node,
        path,
        depth,
        hits,
        failed,
    } = listing;
    if let Some(reason) = failed {
        skipped.push(ScanSkipped {
            path: path.display().to_string(),
            reason,
        });
        detach(arena, node);
        return Vec::new();
    }

    let mut derived = Vec::new();
    // Only directories above the delivered depth keep their children as blocks;
    // deeper ones still fold bytes, they just are not itemised.
    let detail = depth < SCAN_TREE_DEPTH;
    for hit in hits {
        *entries += 1;
        if hit.dir_link {
            skipped.push(ScanSkipped {
                path: hit.path.display().to_string(),
                reason: ScanSkipReason::SymlinkSkipped,
            });
            continue;
        }
        if hit.is_dir {
            if depth + 1 >= SCAN_MAX_DEPTH {
                skipped.push(ScanSkipped {
                    path: hit.path.display().to_string(),
                    reason: ScanSkipReason::TooDeep,
                });
                continue;
            }
            let target = canonical(&hit.path);
            if visited.contains(&target) {
                skipped.push(ScanSkipped {
                    path: hit.path.display().to_string(),
                    reason: ScanSkipReason::SymlinkSkipped,
                });
                continue;
            }
            visited.insert(target.clone());
            let id = arena.len();
            arena.push(dir_node(&hit.path, target, depth + 1, Some(node)));
            arena[node].child_total += 1;
            if detail {
                arena[node].children.push(id);
            }
            derived.push(Job {
                node: id,
                path: hit.path,
                depth: depth + 1,
            });
            continue;
        }

        if detail {
            let id = arena.len();
            let mut kinds = HashMap::new();
            if !hit.ext.is_empty() {
                kinds.insert(hit.ext.clone(), hit.bytes);
            }
            arena.push(Agg {
                name: hit.name,
                path: hit.path,
                is_dir: false,
                bytes: hit.bytes,
                parent: Some(node),
                depth: depth + 1,
                children: Vec::new(),
                child_total: 0,
                kinds,
            });
            arena[node].children.push(id);
        }
        arena[node].child_total += 1;
        fold(arena, node, hit.bytes, &hit.ext);
    }
    derived
}

/// Add a file's bytes to its directory and every ancestor, so a parent's `bytes`
/// and `kinds` are subtree facts rather than a listing of one level.
fn fold(arena: &mut [Agg], from: usize, bytes: u64, ext: &str) {
    let mut cursor = Some(from);
    while let Some(id) = cursor {
        let parent = {
            let agg = &mut arena[id];
            agg.bytes += bytes;
            if !ext.is_empty() {
                *agg.kinds.entry(ext.to_owned()).or_insert(0) += bytes;
            }
            agg.parent
        };
        cursor = parent;
    }
}

/// Drop a directory that contributed nothing: no block, and no slot in its
/// parent's child count.
fn detach(arena: &mut [Agg], node: usize) {
    let parent = arena[node].parent;
    arena[node].bytes = 0;
    arena[node].children.clear();
    arena[node].child_total = 0;
    if let Some(pid) = parent {
        arena[pid].children.retain(|c| *c != node);
        arena[pid].child_total = arena[pid].child_total.saturating_sub(1);
    }
}

/// Cut the arena into the delivered DTO: children above [`SCAN_TREE_DEPTH`],
/// `childCount` at and below it.
fn to_dto(arena: &[Agg], id: usize, cut: &mut Option<u32>) -> ScanNode {
    let agg = &arena[id];
    let kinds = (!agg.kinds.is_empty()).then(|| agg.kinds.clone());
    let path = agg.path.display().to_string();
    if !agg.is_dir {
        return ScanNode {
            name: agg.name.clone(),
            path,
            is_dir: false,
            bytes: agg.bytes,
            child_count: None,
            children: None,
            kinds,
        };
    }
    if agg.depth >= SCAN_TREE_DEPTH {
        if agg.child_total > 0 {
            *cut = Some(cut.map_or(agg.depth, |d| d.min(agg.depth)));
        }
        return ScanNode {
            name: agg.name.clone(),
            path,
            is_dir: true,
            bytes: agg.bytes,
            child_count: Some(agg.child_total),
            children: None,
            kinds,
        };
    }
    let children = agg
        .children
        .iter()
        .map(|child| to_dto(arena, *child, cut))
        .collect();
    ScanNode {
        name: agg.name.clone(),
        path,
        is_dir: true,
        bytes: agg.bytes,
        child_count: None,
        children: Some(children),
        kinds,
    }
}

fn dir_node(raw: &Path, canonical: PathBuf, depth: u32, parent: Option<usize>) -> Agg {
    Agg {
        name: label(raw),
        path: canonical,
        is_dir: true,
        bytes: 0,
        parent,
        depth,
        children: Vec::new(),
        child_total: 0,
        kinds: HashMap::new(),
    }
}

/// Display name for a path: its file name, or the path itself for a drive root.
fn label(path: &Path) -> String {
    match path.file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        None => path.display().to_string(),
    }
}

/// Best-effort identity for a directory. Used only to refuse re-visiting the same
/// subtree; a path that will not canonicalise is walked as its own thing rather
/// than dropped.
fn canonical(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn hit_of(de: &fs::DirEntry) -> Hit {
    let file_type = de.file_type();
    let is_dir = file_type.as_ref().is_ok_and(|t| t.is_dir());
    let link = file_type.as_ref().is_ok_and(|t| t.is_symlink());
    // A link's own "size" is reparse bookkeeping, not content: counting it would
    // make a directory of aliases look like it held data.
    let bytes = if link {
        0
    } else {
        de.metadata().map(|m| m.len()).unwrap_or(0)
    };
    let dir_link = match (link, is_dir) {
        (true, true) => true,
        // A reparse point reported as a file may still target a directory (Windows
        // junctions and alias shortcuts behave this way); only the target answers.
        (true, false) => fs::metadata(de.path()).is_ok_and(|m| m.is_dir()),
        _ => false,
    };
    let name = de.file_name().to_string_lossy().into_owned();
    let ext = extension_of(&name);
    Hit {
        name,
        path: de.path(),
        is_dir: is_dir && !dir_link,
        dir_link,
        bytes,
        ext,
    }
}

fn extension_of(name: &str) -> String {
    match name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => ext.to_lowercase(),
        _ => String::new(),
    }
}

fn classify(err: &std::io::Error) -> ScanSkipReason {
    match err.kind() {
        std::io::ErrorKind::NotFound => ScanSkipReason::NotFound,
        std::io::ErrorKind::PermissionDenied => ScanSkipReason::Denied,
        std::io::ErrorKind::InvalidInput => ScanSkipReason::InvalidArgument,
        _ => ScanSkipReason::ReadFailed,
    }
}

fn worker_count() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get().clamp(2, MAX_SCAN_WORKERS))
        .unwrap_or(2)
}

/// Volume accounting for the volume behind `path` first, then every other local
/// drive the platform reports.
#[cfg(windows)]
fn list_volumes(path: &str) -> Result<Vec<DiskVolume>, CapabilityError> {
    let root = volume_root_of(path).ok_or_else(|| {
        CapabilityError::InvalidArgument(format!("cannot tell which volume holds: {path}"))
    })?;
    let first = volume_of(&root).ok_or_else(|| {
        CapabilityError::NotFound(format!("volume is not available: {root}"))
    })?;
    let mut volumes = vec![first];
    for other in drive_roots().into_iter().filter(|r| *r != root) {
        if let Some(vol) = volume_of(&other) {
            volumes.push(vol);
        }
    }
    Ok(volumes)
}

/// `C:\\` from `C:\dir\file.txt`, `\\server\share\` from a UNC path.
#[cfg(windows)]
fn volume_root_of(path: &str) -> Option<String> {
    let bytes = path.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        let letter = bytes[0].to_ascii_uppercase() as char;
        return Some(format!("{letter}:\\"));
    }
    if path.starts_with("\\\\") {
        let rest = &path[2..];
        let mut parts = rest.split('\\');
        let host = parts.next()?;
        let share = parts.next()?;
        if !host.is_empty() && !share.is_empty() {
            return Some(format!("\\\\{host}\\{share}\\"));
        }
    }
    None
}

#[cfg(windows)]
fn drive_roots() -> Vec<String> {
    use windows::Win32::Storage::FileSystem::GetLogicalDrives;
    let mask = unsafe { GetLogicalDrives() };
    (0..26u32)
        .filter(|bit| mask & (1 << bit) != 0)
        .filter_map(|bit| {
            char::from_u32(u32::from(b'A') + bit).map(|l| format!("{l}:\\"))
        })
        .collect()
}

#[cfg(windows)]
fn volume_of(root: &str) -> Option<DiskVolume> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{GetDiskFreeSpaceExW, GetVolumeInformationW};

    let wide = to_wide(root);
    let mut available = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    unsafe {
        GetDiskFreeSpaceExW(
            PCWSTR::from_raw(wide.as_ptr()),
            Some(&mut available),
            Some(&mut total),
            Some(&mut free),
        )
        .ok()?;
    }

    let mut label_buf = [0u16; 64];
    let mut fs_buf = [0u16; 32];
    let mut serial = 0u32;
    let mut component = 0u32;
    let mut flags = 0u32;
    let mut filesystem = String::new();
    let mut label = String::new();
    let named = unsafe {
        GetVolumeInformationW(
            PCWSTR::from_raw(wide.as_ptr()),
            Some(&mut label_buf),
            Some(&mut serial),
            Some(&mut component),
            Some(&mut flags),
            Some(&mut fs_buf),
        )
    };
    if named.is_ok() {
        filesystem = from_wide(&fs_buf);
        label = from_wide(&label_buf);
    }
    Some(DiskVolume {
        root_path: root.to_owned(),
        label,
        filesystem: if filesystem.is_empty() {
            "unknown".to_owned()
        } else {
            filesystem
        },
        total_bytes: total,
        // What the volume is *holding*, from the volume's own point of view;
        // `free_bytes` is what this caller may still write, which is smaller under
        // a quota and the panel must not add the two.
        used_bytes: total.saturating_sub(free),
        free_bytes: available,
    })
}

#[cfg(windows)]
fn to_wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn from_wide(buf: &[u16]) -> String {
    let end = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    // The label and the filesystem name are text, and a UTF-16 buffer with no
    // terminator is a truncated read, not an error worth failing a scan over.
    String::from_utf16_lossy(&buf[..end])
}

/// This app's platform is Windows; volume enumeration is deliberately not faked
/// with zeroes on another OS, because a `used_bytes` of 0 would read as an empty
/// disk.
#[cfg(not(windows))]
fn list_volumes(path: &str) -> Result<Vec<DiskVolume>, CapabilityError> {
    Err(CapabilityError::InvalidArgument(format!(
        "sys.disk.list needs Windows: {path}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn file_at(path: &Path, len: usize) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        let mut f = File::create(path).unwrap();
        f.write_all(&vec![7u8; len]).unwrap();
        f.flush().unwrap();
    }

    /// Real sizes, several extensions, and a level deeper than the delivered
    /// depth — the shape the panel drills. Total is exact and asserted below.
    fn sample_tree(root: &Path) {
        file_at(&root.join("a.txt"), 100);
        file_at(&root.join("b.PNG"), 200);
        file_at(&root.join("one/c.bin"), 1_000);
        file_at(&root.join("one/d.txt"), 50);
        file_at(&root.join("one/two/e.md"), 25);
        file_at(&root.join("three/f.md"), 7);
        fs::create_dir_all(root.join("empty")).unwrap();
    }

    const SAMPLE_TOTAL: u64 = 100 + 200 + 1_000 + 50 + 25 + 7;

    fn scan(root: &Path) -> Walked {
        let cancel = AtomicBool::new(false);
        walk("scan-test", root, &cancel, &|_| {})
    }

    fn child<'a>(node: &'a ScanNode, name: &str) -> &'a ScanNode {
        node.children
            .as_ref()
            .unwrap_or_else(|| panic!("{} has no delivered children", node.name))
            .iter()
            .find(|c| c.name == name)
            .unwrap_or_else(|| panic!("no child named {name} under {}", node.name))
    }

    #[test]
    fn a_directory_node_carries_its_whole_subtree() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let out = scan(dir.path());

        assert!(out.done.tree.is_dir);
        assert_eq!(out.done.tree.bytes, SAMPLE_TOTAL);
        assert!(!out.done.cancelled);
        assert!(!out.budget_stop);

        let kinds = out.done.tree.kinds.clone().unwrap();
        assert_eq!(kinds.get("txt").copied(), Some(150));
        // The extension is normalised, so `b.PNG` is not a fifth of the map.
        assert_eq!(kinds.get("png").copied(), Some(200));
        assert_eq!(kinds.get("md").copied(), Some(32));
        assert_eq!(kinds.get("bin").copied(), Some(1_000));
        assert!(!kinds.contains_key("PNG"));
    }

    #[test]
    fn the_tree_is_cut_at_the_contract_depth_while_totals_stay_complete() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let out = scan(dir.path());

        assert_eq!(out.done.truncated_at_depth, Some(SCAN_TREE_DEPTH));
        let one = child(&out.done.tree, "one");
        assert_eq!(one.bytes, 1_075);
        // Depth 1 still itemises; `two/` sits at the cut and reports a count.
        let two = child(one, "two");
        assert_eq!(two.child_count, Some(1));
        assert_eq!(two.children, None);
        assert_eq!(two.bytes, 25);
        // Files are blocks too: a directory's own files must not vanish from the
        // picture, or the children could not add up to their parent.
        assert!(child(&out.done.tree, "a.txt").is_dir == false);
        assert_eq!(child(&out.done.tree, "a.txt").bytes, 100);
        let empty = child(&out.done.tree, "empty");
        assert_eq!(empty.bytes, 0);
        // Above the cut a directory is itemised, so an empty one is *shown* empty
        // (children: []) instead of carrying a count — the panel must not be able
        // to read "no children delivered" as "not scanned yet".
        assert_eq!(empty.children.as_deref(), Some(&[] as &[ScanNode]));
        assert_eq!(empty.child_count, None);
    }

    #[test]
    fn every_counted_entry_is_reported_and_nothing_is_double_counted() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let out = scan(dir.path());
        // 3 files at the root level are 2 files + 4 dirs + ... — count them the way
        // the walk does: every entry seen, including the directories themselves.
        // root: a.txt, b.PNG, one/, three/, empty/  = 5
        // one/: c.bin, d.txt, two/                  = 3
        // three/: f.md                              = 1
        // one/two/: e.md                            = 1
        assert_eq!(out.done.entries, 10);
    }

    #[test]
    fn an_unreadable_directory_is_skipped_and_contributes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let locked = dir.path().join("locked");
        fs::create_dir_all(locked.join("hidden")).unwrap();
        file_at(&locked.join("hidden/secret.txt"), 9_999);

        let mut arena: Vec<Agg> = Vec::new();
        let root_id = 0usize;
        arena.push(Agg {
            name: "root".into(),
            path: dir.path().to_path_buf(),
            is_dir: true,
            bytes: 10,
            parent: None,
            depth: 0,
            children: vec![1],
            child_total: 1,
            kinds: HashMap::new(),
        });
        arena.push(Agg {
            name: "locked".into(),
            path: locked.clone(),
            is_dir: true,
            bytes: 0,
            parent: Some(root_id),
            depth: 1,
            children: Vec::new(),
            child_total: 0,
            kinds: HashMap::new(),
        });

        let mut skipped = Vec::new();
        let mut entries = 0u64;
        let mut visited = HashSet::new();
        let derived = combine(
            Listing {
                node: 1,
                path: locked.clone(),
                depth: 1,
                // Bytes the worker saw before the error — which must not survive.
                hits: vec![Hit {
                    name: "x.bin".into(),
                    path: locked.join("x.bin"),
                    is_dir: false,
                    dir_link: false,
                    bytes: 5,
                    ext: "bin".into(),
                }],
                failed: Some(ScanSkipReason::Denied),
            },
            &mut arena,
            &mut skipped,
            &mut entries,
            &mut visited,
        );
        assert!(derived.is_empty(), "a failed directory owes the queue nothing");

        assert_eq!(skipped.len(), 1);
        assert_eq!(skipped[0].reason, ScanSkipReason::Denied);
        assert_eq!(skipped[0].path, locked.display().to_string());
        assert_eq!(arena[0].bytes, 10, "a failed listing must not add bytes");
        assert!(arena[0].children.is_empty(), "and must not leave a block");
        assert_eq!(arena[0].child_total, 0, "nor a hole in the count");
    }

    #[test]
    fn a_link_to_a_directory_is_explained_and_never_walked() {
        let mut arena: Vec<Agg> = Vec::new();
        arena.push(Agg {
            name: "root".into(),
            path: PathBuf::from("/root"),
            is_dir: true,
            bytes: 0,
            parent: None,
            depth: 0,
            children: Vec::new(),
            child_total: 0,
            kinds: HashMap::new(),
        });
        let mut skipped = Vec::new();
        let mut entries = 0u64;
        let mut visited = HashSet::new();
        let derived = combine(
            Listing {
                node: 0,
                path: PathBuf::from("/root"),
                depth: 0,
                hits: vec![Hit {
                    name: "loop".into(),
                    path: PathBuf::from("/root/loop"),
                    is_dir: false,
                    dir_link: true,
                    bytes: 0,
                    ext: String::new(),
                }],
                failed: None,
            },
            &mut arena,
            &mut skipped,
            &mut entries,
            &mut visited,
        );
        assert_eq!(skipped[0].reason, ScanSkipReason::SymlinkSkipped);
        assert_eq!(entries, 1, "the link is an entry, just not a subtree");
        assert!(arena[0].children.is_empty());
        assert!(
            derived.is_empty(),
            "a directory link must not be queued for reading"
        );
    }

    #[test]
    fn an_extensionless_and_a_dotfile_name_never_invent_a_kind() {
        assert_eq!(extension_of("Makefile"), "");
        assert_eq!(extension_of(".gitignore"), "");
        assert_eq!(extension_of("archive.tar.GZ"), "gz");
        assert_eq!(extension_of("no.such.thing.zip"), "zip");
    }

    #[test]
    fn a_root_that_is_not_a_directory_fails_the_call() {
        let dir = tempfile::tempdir().unwrap();
        file_at(&dir.path().join("not-a-dir.txt"), 1);
        let sys = Sys::new();

        let err = sys
            .start_scan(&ScanIn {
                root_path: dir.path().join("not-a-dir.txt").display().to_string(),
            })
            .unwrap_err();
        assert!(matches!(err, CapabilityError::InvalidArgument(_)), "{err}");

        let missing = sys
            .start_scan(&ScanIn {
                root_path: dir.path().join("gone").display().to_string(),
            })
            .unwrap_err();
        assert!(matches!(missing, CapabilityError::NotFound(_)), "{missing}");

        let blank = sys
            .start_scan(&ScanIn {
                root_path: "   ".to_owned(),
            })
            .unwrap_err();
        assert!(matches!(blank, CapabilityError::InvalidArgument(_)), "{blank}");
    }

    #[test]
    fn cancel_tracks_only_live_scans() {
        let sys = Sys::new();
        assert!(!sys.cancel_scan("scan-does-not-exist").unwrap());

        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let ack = sys
            .start_scan(&ScanIn {
                root_path: dir.path().display().to_string(),
            })
            .unwrap();
        assert_eq!(ack.state, ScanState::Queued);
        assert_eq!(sys.live_scans(), 1);
        assert!(sys.cancel_scan(&ack.scan_id).unwrap());
        // The walk's own thread retires the scan, and that is what the test waits
        // for: a scan that stayed in the table after its end would pin a slot of
        // the concurrency cap forever.
        let retired = (0..300).any(|_| {
            if sys.live_scans() == 0 {
                return true;
            }
            std::thread::sleep(Duration::from_millis(10));
            false
        });
        assert!(retired, "a cancelled scan must leave the live table");
        assert!(!sys.cancel_scan(&ack.scan_id).unwrap());
    }

    /// The cap is a fact about the live table, so it is tested against the table —
    /// never against "did three walks happen to still be running".
    #[test]
    fn the_live_scan_cap_refuses_instead_of_degrading() {
        let sys = Sys::new();
        for _ in 0..MAX_LIVE_SCANS {
            let (id, flag) = sys.reserve().unwrap();
            lock(&sys.shared.live).insert(id, flag);
        }
        let err = sys.reserve().unwrap_err();
        assert!(matches!(err, CapabilityError::InvalidArgument(_)), "{err}");
        assert_eq!(sys.live_scans(), MAX_LIVE_SCANS);
    }

    #[test]
    fn a_cancelled_scan_says_so_instead_of_passing_off_a_partial_tree() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..40 {
            file_at(&dir.path().join(format!("d{i}/sub{i}/f{i}.bin")), 10);
        }
        // Cancelled before the first listing is folded: the only honest answer is
        // "nothing was counted, and this is cancelled".
        let cancel = AtomicBool::new(true);
        let out = walk("scan-cancelled", dir.path(), &cancel, &|_| {});
        assert!(out.done.cancelled);
        assert_eq!(out.done.entries, 0);
        assert_eq!(out.done.tree.bytes, 0);
        assert_eq!(
            out.done.tree.children.as_deref(),
            Some(&[] as &[ScanNode]),
            "the delivered root must not look like a scanned directory with content"
        );
        assert!(out.done.truncated_at_depth.is_none());
        assert!(!out.budget_stop);
    }

    #[test]
    fn progress_reports_the_counters_the_panel_shows() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let cancel = AtomicBool::new(false);
        let seen = Arc::new(Mutex::new(Vec::<ScanProgress>::new()));
        let sink = Arc::clone(&seen);
        walk(
            "scan-progress",
            dir.path(),
            &cancel,
            &|args| lock(&sink).push(args),
        );
        // A small tree finishes before the throttle can fire, so the assertion is
        // about shape, not about how many ticks happened to land.
        for tick in lock(&seen).iter() {
            assert_eq!(tick.scan_id, "scan-progress");
            assert_eq!(tick.state, ScanState::Running);
            assert!(!tick.path.is_empty());
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_volume_is_found_by_the_path_it_was_asked_about() {
        let temp = tempfile::tempdir().unwrap();
        let out = list_volumes(&temp.path().display().to_string()).unwrap();
        assert!(!out.is_empty());
        let first = &out[0];
        assert!(
            temp
                .path()
                .display()
                .to_string()
                .to_ascii_uppercase()
                .starts_with(&first.root_path.to_ascii_uppercase()),
            "{} does not live on {}",
            temp.path().display(),
            first.root_path
        );
        assert!(first.total_bytes > 0);
        assert!(first.used_bytes <= first.total_bytes);
        assert!(first.free_bytes <= first.total_bytes);
        assert!(!first.filesystem.is_empty());
    }

    #[cfg(windows)]
    #[test]
    fn a_path_with_no_volume_is_refused_not_guessed() {
        assert!(list_volumes("relative/only.txt").is_err());
        assert!(volume_root_of("C:\\dir\\file.txt").is_some());
        assert_eq!(
            volume_root_of("c:\\dir").as_deref(),
            Some("C:\\"),
            "drive letters are normalised, so two cases of one volume are one volume"
        );
        assert_eq!(
            volume_root_of("\\\\srv\\share\\deep\\path").as_deref(),
            Some("\\\\srv\\share\\")
        );
    }

    #[test]
    fn the_worker_pool_stays_inside_its_budget() {
        let n = worker_count();
        assert!((2..=MAX_SCAN_WORKERS).contains(&n), "{n}");
    }
}
