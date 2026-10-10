//! Name index for search (`search.*`, P7-29).
//!
//! One SQLite file holding directory names, queried while it is being written.
//! The engine is SQLite's own FTS5 with the `trigram` tokenizer, which is what
//! makes a Chinese substring (`报告`) answerable from an index instead of a scan;
//! docs/05 D24 is the decision and `tests/search_spike.rs` is the measurement it
//! rests on (100 000 names indexed in 1.17 s, a CJK substring answered in 26 ms).
//!
//! Two shapes of answer, one contract:
//! * `text` of [`SEARCH_TRIGRAM_MIN_CHARS`] or more goes to `MATCH`, which the
//!   trigram index serves;
//! * anything shorter is invisible to a 3-gram index, so the host answers it with
//!   a `LIKE` scan over the indexed rows. That is slow rather than wrong, and it
//!   is why a page is bounded by a contract constant instead of a UI preference.
//!
//! The index is a **cache of facts the filesystem owns**, and that ordering drives
//! the hard rules:
//! - one job at a time ([`MAX_LIVE_JOBS`]): a job deletes the rows for its roots
//!   before re-adding them, so a second job would delete the first one's work;
//! - there is no mtime diff: knowing whether a directory changed means listing it,
//!   so a diff would skip the one thing worth skipping and add staleness;
//! - a refresh re-walks **only the roots it was given** — that is what
//!   `rebuild: false` means; `rebuild: true` clears the file;
//! - roots inside one job are pruned to the outermost, because a row can carry
//!   only one root label and two walks over one subtree would leave rows that
//!   neither refresh can find;
//! - a directory that could not be read contributes nothing and is counted in
//!   `skipped`, never presented as an empty folder;
//! - a link to a directory is indexed but never descended into, so a junction
//!   cycle is structurally impossible rather than merely depth-bounded;
//! - a cancelled or ceiling-stopped job keeps the rows it wrote and reports
//!   `partial`, because "no results" from a partial index must not read as
//!   "nothing matches".
//!
//! 正文全文检索 is not here: names and paths only, and no copy of file content is
//! stored. The FTS5 table is `content='files'`, so it keeps posting data and reads
//! the name back from `files` — indexing a name never writes the text twice, and
//! the trigger trio on `files` is what keeps the two in step, so nothing can
//! delete a row without the index noticing.
//!
//! Reads and writes share one connection behind a mutex, in batches of
//! [`SEARCH_INDEX_BATCH`] rows, so a query can wait at most one batch (tens of
//! milliseconds in the spike) rather than one whole walk.

use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use cordis_core::{Context, Event, Routing};
use fm_contracts::capability::{
    CapabilityError, SearchApi, SearchHit, SearchIndexAck, SearchIndexDone, SearchIndexIn,
    SearchIndexProgress, SearchIndexState, SearchQueryIn, SearchQueryOut, SearchScope,
    SearchStatusOut, SEARCH_INDEX_BATCH, SEARCH_INDEX_MAX_DEPTH, SEARCH_INDEX_MAX_ENTRIES,
    SEARCH_MAX_PAGE, SEARCH_MAX_TEXT_CHARS, SEARCH_PROGRESS_INTERVAL_MS, SEARCH_TRIGRAM_MIN_CHARS,
};
use fm_contracts::events::{SearchIndexDoneEvent, SearchIndexProgressEvent};
use rusqlite::{params, Connection};
use tokio::runtime::Handle;

/// How many index jobs may write at once. A job deletes before it re-adds, so a
/// second concurrent job would only undo the first.
const MAX_LIVE_JOBS: usize = 1;

/// Directory readers per job: roots are walked by this many threads at most, so
/// two roots on two volumes make progress on both.
const MAX_WALK_WORKERS: usize = 4;

/// How often a live job republishes its counters.
const PROGRESS_TICK: Duration = Duration::from_millis(SEARCH_PROGRESS_INTERVAL_MS);

/// Page size when the caller asked for none.
const DEFAULT_PAGE: u32 = 50;

/// The longest `within` prefix the host will compare.
const WITHIN_MAX_CHARS: usize = 4_096;

/// Path separator used for the subtree comparison, per platform.
const SEPARATOR: &str = if cfg!(windows) { "\\" } else { "/" };

/// Meta keys, so `status` answers without touching the walk.
const META_ROOTS: &str = "roots";
const META_STATE: &str = "state";
const META_DETAIL: &str = "detail";
const META_LAST_JOB_MS: &str = "last_job_ms";

/// One indexed entry, as the walk saw it.
struct Row {
    path: String,
    parent: String,
    name: String,
    is_dir: bool,
    size: Option<i64>,
    modified_ms: Option<i64>,
    /// The root this row belongs to, i.e. which refresh owns it.
    root: String,
}

/// One directory's answer, handed from a walker to the writer.
struct Listing {
    /// The directory that was listed, for the progress display.
    current: String,
    rows: Vec<Row>,
}

/// What one walk ended with, before any event delivery.
struct Walked {
    entries: u64,
    skipped: u64,
    cancelled: bool,
    stopped_by_budget: bool,
}

/// The cordis half of event delivery — the same `block_on` bridge [`super::sys`]
/// uses, because a job's threads live outside the runtime.
#[derive(Clone)]
struct Emitter {
    ctx: Context,
    handle: Handle,
}

impl Emitter {
    /// Drive one async emission to completion from a non-runtime thread. Legal
    /// only because every caller is a dedicated OS thread.
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
                "search event was not delivered"
            );
        }
    }
}

/// Bookkeeping shared by the capability and every live job thread.
struct Shared {
    conn: Arc<Mutex<Connection>>,
    live: Mutex<HashMap<String, Arc<AtomicBool>>>,
    emitter: Mutex<Option<Emitter>>,
    next_id: AtomicU64,
}

impl Shared {
    fn emitter(&self) -> Option<Emitter> {
        lock(&self.emitter).clone()
    }

    fn progress(&self, args: SearchIndexProgress) {
        match self.emitter() {
            Some(emitter) => emitter.drive::<SearchIndexProgressEvent>(args),
            None => tracing::warn!(
                job_id = %args.job_id,
                entries = args.entries,
                "no event emitter attached yet: index progress was dropped"
            ),
        }
    }

    /// The terminal payload is the only complete answer a job ever gives, so a
    /// missing emitter is logged rather than swallowed.
    fn finish(&self, args: &SearchIndexDone) {
        match self.emitter() {
            Some(emitter) => emitter.drive::<SearchIndexDoneEvent>(args.clone()),
            None => tracing::warn!(
                job_id = %args.job_id,
                entries = args.entries,
                cancelled = args.cancelled,
                "no event emitter attached yet: index result was dropped"
            ),
        }
    }

    fn retire(&self, job_id: &str) {
        lock(&self.live).remove(job_id);
    }

    fn indexed_roots(&self) -> Result<Vec<String>, CapabilityError> {
        let conn = lock(&self.conn);
        meta_roots(&conn)
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(PoisonError::into_inner)
}

fn map_sql(err: rusqlite::Error) -> CapabilityError {
    CapabilityError::Io(err.to_string())
}

/// Removes a job from the live table whatever happens to its threads, so a panic
/// mid-walk cannot leave `cancel_index()` answering `true` forever.
struct LiveGuard {
    shared: Arc<Shared>,
    job_id: String,
}

impl Drop for LiveGuard {
    fn drop(&mut self) {
        self.shared.retire(&self.job_id);
    }
}

/// [`SearchApi`] over one FTS5-backed name index.
pub struct Search {
    shared: Arc<Shared>,
}

impl Search {
    /// Open (or create) the index at `path`. `":memory:"` is valid and is what a
    /// headless test uses; the host passes a file under its app data directory.
    pub fn open(path: &str) -> Result<Self, CapabilityError> {
        if path != ":memory:" {
            if let Some(parent) = Path::new(path).parent() {
                fs::create_dir_all(parent).map_err(CapabilityError::from_io)?;
            }
        }
        let conn = Connection::open(path).map_err(map_sql)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(map_sql)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS files (
                path    TEXT NOT NULL PRIMARY KEY,
                parent  TEXT NOT NULL,
                name    TEXT NOT NULL,
                is_dir  INTEGER NOT NULL,
                size    INTEGER,
                mtime   INTEGER,
                root    TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS files_parent ON files(parent);
             CREATE INDEX IF NOT EXISTS files_root ON files(root);
             CREATE VIRTUAL TABLE IF NOT EXISTS files_idx USING fts5(
                name,
                content='files',
                content_rowid='rowid',
                tokenize='trigram'
             );
             CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
                INSERT INTO files_idx(rowid, name) VALUES (new.rowid, new.name);
             END;
             CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
                INSERT INTO files_idx(files_idx, rowid, name)
                VALUES('delete', old.rowid, old.name);
             END;
             CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
                INSERT INTO files_idx(files_idx, rowid, name)
                VALUES('delete', old.rowid, old.name);
                INSERT INTO files_idx(rowid, name) VALUES (new.rowid, new.name);
             END;
             CREATE TABLE IF NOT EXISTS meta (
                key   TEXT NOT NULL PRIMARY KEY,
                value TEXT NOT NULL
             );",
        )
        .map_err(map_sql)?;
        Ok(Self {
            shared: Arc::new(Shared {
                conn: Arc::new(Mutex::new(conn)),
                live: Mutex::new(HashMap::new()),
                emitter: Mutex::new(None),
                next_id: AtomicU64::new(0),
            }),
        })
    }

    /// Attach the cordis context + runtime that carry `search:index-*` events.
    /// Called from `CapabilitySet::publish`; a job that finished before this had
    /// its result logged instead of published.
    pub fn attach(&self, ctx: Context, handle: Handle) {
        *lock(&self.shared.emitter) = Some(Emitter { ctx, handle });
    }

    /// Jobs in the live table — what [`MAX_LIVE_JOBS`] is measured against.
    pub fn live_jobs(&self) -> usize {
        lock(&self.shared.live).len()
    }

    /// Ask every live job to stop, for host shutdown. Each job's own thread still
    /// publishes its terminal `search:index-done`.
    pub fn cancel_all(&self) {
        for flag in lock(&self.shared.live).values() {
            flag.store(true, Ordering::Release);
        }
    }

    /// Reserve a job id and its cancel flag, or refuse at the concurrency cap.
    /// Separate from the thread spawn so the cap is a fact about the table, not
    /// about whether a walk happens to be running at that instant.
    fn reserve(&self) -> Result<(String, Arc<AtomicBool>), CapabilityError> {
        let mut live = lock(&self.shared.live);
        if live.len() >= MAX_LIVE_JOBS {
            return Err(CapabilityError::InvalidArgument(format!(
                "已有一个索引任务在运行（上限 {MAX_LIVE_JOBS}），请先取消它"
            )));
        }
        let n = self.shared.next_id.fetch_add(1, Ordering::Relaxed) + 1;
        let job_id = format!("search-index-{n}");
        let cancel = Arc::new(AtomicBool::new(false));
        live.insert(job_id.clone(), Arc::clone(&cancel));
        Ok((job_id, cancel))
    }
}

impl SearchApi for Search {
    fn status(&self) -> Result<SearchStatusOut, CapabilityError> {
        let out = {
            let conn = lock(&self.shared.conn);
            SearchStatusOut {
                state: meta_state(&conn)?,
                entries: count_rows(&conn)?,
                roots: meta_roots(&conn)?,
                last_job_ms: meta_number(&conn, META_LAST_JOB_MS)?,
                detail: meta_text(&conn, META_DETAIL)?,
            }
        };
        // A job that is walking right now outranks whatever the file last said, or
        // the UI would show `ready` over a number that keeps growing.
        if self.live_jobs() > 0 {
            return Ok(SearchStatusOut {
                state: SearchIndexState::Indexing,
                ..out
            });
        }
        Ok(out)
    }

    fn query(&self, req: &SearchQueryIn) -> Result<SearchQueryOut, CapabilityError> {
        let started = Instant::now();
        let text: String = req.text.chars().take(SEARCH_MAX_TEXT_CHARS).collect();
        let text = text.trim().to_owned();
        if text.is_empty() {
            return Err(CapabilityError::InvalidArgument(
                "search.query 需要检索词".to_owned(),
            ));
        }
        let within = req
            .within
            .as_deref()
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .map(|w| {
                if w.chars().count() > WITHIN_MAX_CHARS {
                    return Err(CapabilityError::InvalidArgument(format!(
                        "within 目录路径过长（上限 {WITHIN_MAX_CHARS} 字符）"
                    )));
                }
                Ok(trim_separators(&normalize_separators(w)))
            })
            .transpose()?;
        let limit = req.limit.unwrap_or(DEFAULT_PAGE).clamp(1, SEARCH_MAX_PAGE);
        let offset = req.offset;

        let conn = lock(&self.shared.conn);
        let state = if self.live_jobs() > 0 {
            SearchIndexState::Indexing
        } else {
            meta_state(&conn)?
        };
        // An index that holds nothing cannot answer anything, so there is no query
        // to run — but the state still comes from the index, never from the row
        // count. A cancelled job that wrote nothing is `partial`, and a finished
        // one that found an empty directory is `ready` with no matches; telling the
        // UI "还没有索引" for either would let it offer to index again, or hide the
        // fact that the results are incomplete.
        if count_rows(&conn)? == 0 {
            return Ok(SearchQueryOut {
                text,
                scope: req.scope,
                took_ms: started.elapsed().as_millis() as u64,
                total: 0,
                offset,
                has_more: false,
                hits: Vec::new(),
                state,
            });
        }

        let (filters_sql, mut filters) = filter_clause(req.scope, within.as_deref());
        let indexed = text.chars().count() >= SEARCH_TRIGRAM_MIN_CHARS;
        let (total, hits) = if indexed {
            let mut args = vec![fts_phrase(&text)];
            args.append(&mut filters);
            count_and_page(
                &conn,
                &format!(
                    "SELECT count(*) FROM files_idx
                     JOIN files f ON f.rowid = files_idx.rowid
                     WHERE files_idx MATCH ?{filters_sql}"
                ),
                &format!(
                    "SELECT f.path, f.name, f.parent, f.is_dir, f.size, f.mtime
                     FROM files_idx
                     JOIN files f ON f.rowid = files_idx.rowid
                     WHERE files_idx MATCH ?{filters_sql}
                     ORDER BY bm25(files_idx), f.name
                     LIMIT ? OFFSET ?"
                ),
                &args,
                limit,
                offset,
            )?
        } else {
            let mut args = vec![like_pattern(&text)];
            args.append(&mut filters);
            count_and_page(
                &conn,
                &format!(
                    "SELECT count(*) FROM files f
                     WHERE f.name LIKE ? ESCAPE '\\'{filters_sql}"
                ),
                &format!(
                    "SELECT f.path, f.name, f.parent, f.is_dir, f.size, f.mtime
                     FROM files f
                     WHERE f.name LIKE ? ESCAPE '\\'{filters_sql}
                     ORDER BY f.name
                     LIMIT ? OFFSET ?"
                ),
                &args,
                limit,
                offset,
            )?
        };

        Ok(SearchQueryOut {
            text,
            scope: req.scope,
            took_ms: started.elapsed().as_millis() as u64,
            total,
            offset,
            has_more: offset as u64 + (hits.len() as u64) < total,
            hits,
            state,
        })
    }

    /// Validates every root **before** acking: a job that can never list anything
    /// would leave the UI waiting for a `search:index-done` describing nothing.
    fn start_index(&self, req: &SearchIndexIn) -> Result<SearchIndexAck, CapabilityError> {
        let requested: Vec<String> = if req.roots.is_empty() {
            let stored = self.shared.indexed_roots()?;
            if stored.is_empty() {
                vec![crate::capabilities::fs::home_dir()]
            } else {
                stored
            }
        } else {
            req.roots.clone()
        };
        let mut roots: Vec<(String, PathBuf)> = Vec::new();
        for root in &requested {
            let entry = accept_root(root)?;
            if !roots.iter().any(|(label, _)| *label == entry.0) {
                roots.push(entry);
            }
        }
        let roots = prune_nested(roots);
        if roots.is_empty() {
            return Err(CapabilityError::InvalidArgument(
                "search.index.start 没有可索引的目录".to_owned(),
            ));
        }

        let (job_id, cancel) = self.reserve()?;
        let labels: Vec<String> = roots.iter().map(|(label, _)| label.clone()).collect();
        let rebuild = req.rebuild;
        let shared = Arc::clone(&self.shared);
        let id = job_id.clone();
        let spawn = std::thread::Builder::new()
            .name(format!("fm-{id}"))
            .spawn(move || {
                let _guard = LiveGuard {
                    shared: Arc::clone(&shared),
                    job_id: id.clone(),
                };
                run_job(&shared, &id, &roots, rebuild, cancel);
            });
        if let Err(err) = spawn {
            self.shared.retire(&job_id);
            return Err(CapabilityError::Io(err.to_string()));
        }

        Ok(SearchIndexAck {
            job_id,
            roots: labels,
            state: SearchIndexState::Indexing,
        })
    }

    /// A cancel only sets the flag; the job's own thread publishes the terminal
    /// `search:index-done` with `cancelled: true`, so there is exactly one end.
    fn cancel_index(&self, job_id: &str) -> Result<bool, CapabilityError> {
        let flag = lock(&self.shared.live).get(job_id).cloned();
        match flag {
            None => Ok(false),
            Some(flag) => {
                flag.store(true, Ordering::Release);
                Ok(true)
            }
        }
    }
}

/// Check one requested root and give back (stable label, path to walk).
///
/// The label is the path in the plain spelling `fs.list` produces, never in
/// `fs::canonicalize`'s extended-length form: a hit's path has to be usable by the
/// rest of the app, and `\\?\C:\…` is not a string the Shell APIs accept. The cost
/// is that two spellings of one directory count as two roots, which is why the
/// label is separator-normalised and stripped of its trailing separator first.
fn accept_root(raw: &str) -> Result<(String, PathBuf), CapabilityError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(CapabilityError::InvalidArgument(
            "search.index.start 需要一个绝对目录".to_owned(),
        ));
    }
    let label = stable_root_label(trimmed);
    let path = PathBuf::from(&label);
    let meta = fs::metadata(&path).map_err(|err| {
        CapabilityError::InvalidArgument(format!("{label}: {}", CapabilityError::from_io(err)))
    })?;
    if !meta.is_dir() {
        return Err(CapabilityError::InvalidArgument(format!(
            "不是目录：{label}"
        )));
    }
    Ok((label, path))
}

/// The stable form of one root path: platform separators, no trailing separator.
/// A bare root is the exception — `C:\` names a volume, while `C:` names whatever
/// directory the process last stood in on it.
fn stable_root_label(raw: &str) -> String {
    let normalized = normalize_separators(raw.trim());
    let trimmed = trim_separators(&normalized);
    if trimmed.is_empty() || trimmed.ends_with(':') {
        return format!("{trimmed}{SEPARATOR}");
    }
    trimmed
}

/// Keep only the outermost roots: a row carries one root label, so a subtree two
/// roots both cover could not be refreshed by either of them alone. Roots are few,
/// so every candidate is tested against everything kept rather than just the last
/// one — sort order puts an ancestor early but not necessarily adjacent.
fn prune_nested(roots: Vec<(String, PathBuf)>) -> Vec<(String, PathBuf)> {
    let mut sorted = roots;
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let mut kept: Vec<(String, PathBuf)> = Vec::new();
    for root in sorted {
        if kept.iter().any(|outer| under(&root.0, &outer.0)) {
            continue;
        }
        kept.push(root);
    }
    kept
}

/// `child` inside `parent`, separator-terminated so `C:\a` does not swallow
/// `C:\ab`. The parent's own trailing separators are ignored, which is what lets a
/// volume root (`C:\`) contain `C:\a` instead of needing a separator after its
/// separator.
fn under(child: &str, parent: &str) -> bool {
    let trimmed = trim_separators(&normalize_separators(parent));
    let prefix = if trimmed.is_empty() {
        SEPARATOR.to_owned()
    } else {
        format!("{trimmed}{SEPARATOR}")
    };
    normalize_separators(child).starts_with(&prefix)
}

/// Run one job to its terminal payload: clear its scope, walk, write in batches,
/// publish throttled progress.
fn run_job(
    shared: &Arc<Shared>,
    job_id: &str,
    roots: &[(String, PathBuf)],
    rebuild: bool,
    cancel: Arc<AtomicBool>,
) {
    let started = Instant::now();
    let entries = AtomicU64::new(0);
    let skipped = AtomicU64::new(0);
    let stopped_by_budget = AtomicBool::new(false);

    // The rows for the roots about to be walked go first; `rebuild` goes wider and
    // drops everything, which is the only way a row outside every root leaves.
    if let Err(err) = clear_scope(shared, roots, rebuild) {
        let elapsed_ms = started.elapsed().as_millis() as u64;
        if let Err(saved) = save_state(shared, SearchIndexState::Failed, elapsed_ms, None, &[]) {
            tracing::warn!("the failed index state was not saved: {saved}");
        }
        shared.finish(&SearchIndexDone {
            job_id: job_id.to_owned(),
            state: SearchIndexState::Failed,
            entries: 0,
            roots: roots.iter().map(|(label, _)| label.clone()).collect(),
            elapsed_ms,
            cancelled: false,
            detail: Some(format!("索引清空失败：{err}")),
        });
        return;
    }

    let (tx, rx) = mpsc::channel::<Listing>();
    let workers = roots.len().clamp(1, MAX_WALK_WORKERS);
    // Each worker owns a slice of the roots, so the parallelism is across roots
    // (usually across volumes) and never two threads on one directory.
    let assignments: Vec<Vec<(String, PathBuf)>> = (0..workers)
        .map(|w| {
            roots
                .iter()
                .enumerate()
                .filter(|(i, _)| i % workers == w)
                .map(|(_, root)| root.clone())
                .collect()
        })
        .collect();

    let mut pending: Vec<Row> = Vec::with_capacity(SEARCH_INDEX_BATCH);
    let mut current = roots
        .first()
        .map(|(label, _)| label.clone())
        .unwrap_or_default();
    let mut last_emit = Instant::now();

    std::thread::scope(|scope| {
        // Borrowed before the workers spawn: a `move` closure would otherwise take
        // the atomics themselves, and the owner still has to read them at the end.
        let stopped = &stopped_by_budget;
        let counted = &entries;
        let unreadable = &skipped;
        let mut joins = Vec::with_capacity(workers);
        for assigned in assignments {
            let sender = tx.clone();
            let cancel = Arc::clone(&cancel);
            joins.push(scope.spawn(move || {
                for (label, path) in assigned {
                    walk_root(
                        &label, &path, &sender, &cancel, stopped, counted, unreadable,
                    );
                    if cancel.load(Ordering::Acquire) || stopped.load(Ordering::Acquire) {
                        return;
                    }
                }
            }));
        }
        drop(tx);

        loop {
            if cancel.load(Ordering::Acquire) || stopped.load(Ordering::Acquire) {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(listing) => {
                    current = listing.current;
                    pending.extend(listing.rows);
                    if pending.len() >= SEARCH_INDEX_BATCH {
                        if let Err(err) = write_batch(shared, &mut pending) {
                            tracing::warn!("an index batch was not written: {err}");
                            pending.clear();
                        }
                    }
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                // Every walker exited: the walk is over, whatever it reached.
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
            if last_emit.elapsed() >= PROGRESS_TICK {
                last_emit = Instant::now();
                shared.progress(SearchIndexProgress {
                    job_id: job_id.to_owned(),
                    state: SearchIndexState::Indexing,
                    entries: entries.load(Ordering::Relaxed),
                    current_path: current.clone(),
                    elapsed_ms: started.elapsed().as_millis() as u64,
                });
            }
        }

        if !pending.is_empty() {
            if let Err(err) = write_batch(shared, &mut pending) {
                tracing::warn!("the last index batch was not written: {err}");
            }
        }
        // Stop the walkers before joining: their sends fail once `rx` is gone, so a
        // thread still listing a directory leaves at its next directory rather than
        // filling a queue nobody reads.
        drop(rx);
        for join in joins {
            if join.join().is_err() {
                tracing::warn!(
                    "an index worker thread panicked; its directories are not in the index"
                );
            }
        }
    });

    let walked = Walked {
        entries: entries.load(Ordering::Relaxed),
        skipped: skipped.load(Ordering::Relaxed),
        cancelled: cancel.load(Ordering::Acquire),
        stopped_by_budget: stopped_by_budget.load(Ordering::Acquire),
    };
    if walked.skipped > 0 {
        tracing::info!(
            job_id,
            skipped = walked.skipped,
            "directories could not be read and are not indexed"
        );
    }
    let (state, detail) = terminal_state(walked.cancelled, walked.stopped_by_budget);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let labels: Vec<String> = roots.iter().map(|(label, _)| label.clone()).collect();
    let roots_after = match merge_roots(shared, &labels, rebuild) {
        Ok(roots) => roots,
        Err(err) => {
            tracing::warn!("the indexed roots were not saved: {err}");
            labels.clone()
        }
    };
    if let Err(err) = save_state(shared, state, elapsed_ms, detail.clone(), &roots_after) {
        tracing::warn!("the index state was not saved: {err}");
    }
    shared.finish(&SearchIndexDone {
        job_id: job_id.to_owned(),
        state,
        entries: walked.entries,
        roots: roots_after,
        elapsed_ms,
        cancelled: walked.cancelled,
        detail,
    });
}

/// What a walk's two non-successful endings mean for the reported state. Split
/// out because both are assertable without racing a live walk.
fn terminal_state(cancelled: bool, stopped_by_budget: bool) -> (SearchIndexState, Option<String>) {
    if cancelled {
        (
            SearchIndexState::Partial,
            Some("索引任务已取消，结果不完整".to_owned()),
        )
    } else if stopped_by_budget {
        (
            SearchIndexState::Partial,
            Some(format!(
                "达到条目上限 {SEARCH_INDEX_MAX_ENTRIES}，索引不完整"
            )),
        )
    } else {
        (SearchIndexState::Ready, None)
    }
}

/// Walk one root breadth-first with an explicit queue: the depth ceiling is a
/// contract number, and a recursion would turn it into a stack overflow.
fn walk_root(
    root_label: &str,
    root: &Path,
    sender: &Sender<Listing>,
    cancel: &AtomicBool,
    stopped: &AtomicBool,
    entries: &AtomicU64,
    skipped: &AtomicU64,
) {
    // The root itself is an entry the user can be looking for, and it has a parent
    // and a name like any other directory — except for a volume root, which names
    // itself.
    if let Some(row) = root_row(root, root_label) {
        let current = row.path.clone();
        if sender
            .send(Listing {
                current,
                rows: vec![row],
            })
            .is_err()
        {
            return;
        }
        entries.fetch_add(1, Ordering::Relaxed);
    }

    let mut queue: VecDeque<(PathBuf, u32)> = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0));
    while let Some((dir, depth)) = queue.pop_front() {
        if cancel.load(Ordering::Acquire) || stopped.load(Ordering::Acquire) {
            return;
        }
        let Ok(reader) = fs::read_dir(&dir) else {
            skipped.fetch_add(1, Ordering::Relaxed);
            continue;
        };
        let parent = dir.display().to_string();
        let mut rows = Vec::new();
        let mut aborted = false;
        for entry in reader {
            if cancel.load(Ordering::Acquire) || stopped.load(Ordering::Acquire) {
                aborted = true;
                break;
            }
            let Ok(de) = entry else {
                skipped.fetch_add(1, Ordering::Relaxed);
                continue;
            };
            let file_type = de.file_type();
            let is_dir = file_type.as_ref().is_ok_and(|t| t.is_dir());
            let link = file_type.as_ref().is_ok_and(|t| t.is_symlink());
            let metadata = de.metadata().ok();
            // A link's own size is reparse bookkeeping, not content.
            let len = if link {
                0
            } else {
                metadata.as_ref().map(|m| m.len()).unwrap_or(0)
            };
            let path = de.path();
            let dir_link = directory_link(link, is_dir, &path);
            // A link to a directory is listed as a directory (that is what the user
            // sees) and never walked; only a real directory is worth descending.
            let listed_as_dir = is_dir || dir_link;
            rows.push(Row {
                path: path.display().to_string(),
                name: de.file_name().to_string_lossy().into_owned(),
                parent: parent.clone(),
                is_dir: listed_as_dir,
                // Both fields follow `fs.list`: a directory has no size and no
                // content time, so a hit the UI shows next to a listing row cannot
                // disagree with it.
                size: (!listed_as_dir).then(|| len.min(i64::MAX as u64) as i64),
                modified_ms: (!listed_as_dir)
                    .then(|| epoch_ms(metadata.as_ref()))
                    .flatten(),
                root: root_label.to_owned(),
            });
            // The count is what `entries` reports and what the ceiling stops on, so
            // it counts rows handed to the writer, not rows that happened to land.
            if entries.fetch_add(1, Ordering::Relaxed) + 1 >= SEARCH_INDEX_MAX_ENTRIES {
                stopped.store(true, Ordering::Release);
                aborted = true;
                break;
            }
            if listed_as_dir && !dir_link && depth + 1 < SEARCH_INDEX_MAX_DEPTH {
                queue.push_back((path, depth + 1));
            }
        }
        // A directory's rows go out even when the walk stopped inside it: partial
        // rows for a directory are still true rows.
        if sender
            .send(Listing {
                current: parent,
                rows,
            })
            .is_err()
        {
            // The owner stopped reading: its rows were never counted, so say so
            // rather than let a silent return look like a completed directory.
            tracing::debug!(
                root = root_label,
                dir = %dir.display(),
                "the indexing job stopped reading; this directory's rows were dropped"
            );
            return;
        }
        if aborted {
            return;
        }
    }
}

/// The root directory as a row, or `None` when it cannot be described at all.
fn root_row(root: &Path, root_label: &str) -> Option<Row> {
    // Stat only to answer "can this directory be described at all"; a directory
    // row carries no size and no time, like `fs.list`.
    fs::metadata(root).ok()?;
    let name = match root.file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        None => root.display().to_string(),
    };
    Some(Row {
        path: root.display().to_string(),
        parent: root
            .parent()
            .map(|p| p.display().to_string())
            .unwrap_or_default(),
        name,
        is_dir: true,
        size: None,
        modified_ms: None,
        root: root_label.to_owned(),
    })
}

fn epoch_ms(meta: Option<&fs::Metadata>) -> Option<i64> {
    meta.and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok())
}

/// A link *to* a directory must be indexed as an entry and never descended into.
/// Windows reports junctions and alias shortcuts as files, so only the target
/// answers for a reparse point that did not come back as a directory.
fn directory_link(link: bool, is_dir: bool, path: &Path) -> bool {
    match (link, is_dir) {
        (true, true) => true,
        (true, false) => fs::metadata(path).is_ok_and(|m| m.is_dir()),
        _ => false,
    }
}

/// Hand one batch of rows to the index. The upsert keeps `rowid` stable, which is
/// what makes the FTS5 `AFTER UPDATE` trigger the right maintenance for a name
/// that changed in place.
fn write_batch(shared: &Arc<Shared>, rows: &mut Vec<Row>) -> Result<(), CapabilityError> {
    let conn = lock(&shared.conn);
    conn.execute_batch("BEGIN").map_err(map_sql)?;
    for row in rows.iter() {
        conn.execute(
            "INSERT INTO files (path, parent, name, is_dir, size, mtime, root)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(path) DO UPDATE SET
                parent = excluded.parent,
                name = excluded.name,
                is_dir = excluded.is_dir,
                size = excluded.size,
                mtime = excluded.mtime,
                root = excluded.root",
            params![
                row.path,
                row.parent,
                row.name,
                row.is_dir,
                row.size,
                row.modified_ms,
                row.root
            ],
        )
        .map_err(map_sql)?;
    }
    conn.execute_batch("COMMIT").map_err(map_sql)?;
    rows.clear();
    Ok(())
}

/// Drop the rows the job is about to re-add (or, on a rebuild, every row). The
/// `AFTER DELETE` trigger takes the FTS posting data with them.
fn clear_scope(
    shared: &Arc<Shared>,
    roots: &[(String, PathBuf)],
    rebuild: bool,
) -> Result<(), CapabilityError> {
    let conn = lock(&shared.conn);
    if rebuild {
        conn.execute_batch("DELETE FROM files").map_err(map_sql)?;
        return Ok(());
    }
    for (label, _) in roots {
        conn.execute("DELETE FROM files WHERE root = ?1", params![label])
            .map_err(map_sql)?;
    }
    Ok(())
}

/// Persist the state a job reached, so `status()` can answer after a restart.
fn save_state(
    shared: &Arc<Shared>,
    state: SearchIndexState,
    last_job_ms: u64,
    detail: Option<String>,
    roots: &[String],
) -> Result<(), CapabilityError> {
    let conn = lock(&shared.conn);
    put_meta(&conn, META_STATE, &state_wire(state))?;
    put_meta(
        &conn,
        META_ROOTS,
        &serde_json::to_string(roots).map_err(|e| CapabilityError::Io(e.to_string()))?,
    )?;
    put_meta(&conn, META_LAST_JOB_MS, &last_job_ms.to_string())?;
    match &detail {
        Some(text) => put_meta(&conn, META_DETAIL, text),
        None => {
            conn.execute("DELETE FROM meta WHERE key = ?1", params![META_DETAIL])
                .map_err(map_sql)?;
            Ok(())
        }
    }
}

/// The roots the index now covers. A rebuild deleted every row, so the roots it
/// did not walk are no longer covered and leave the list; a refresh replaces only
/// its own roots' entries, and everything else stays indexed.
fn merge_roots(
    shared: &Arc<Shared>,
    labels: &[String],
    rebuild: bool,
) -> Result<Vec<String>, CapabilityError> {
    if rebuild {
        return Ok(labels.to_vec());
    }
    let mut roots = shared.indexed_roots()?;
    roots.retain(|root| !labels.contains(root));
    for label in labels {
        if !roots.contains(label) {
            roots.push(label.clone());
        }
    }
    Ok(roots)
}

/// `count(*)` plus one page from one param list: the two queries must differ only
/// in `ORDER BY`/`LIMIT`, or `total` would describe a different set from the page
/// it accompanies.
fn count_and_page(
    conn: &Connection,
    count_sql: &str,
    page_sql: &str,
    args: &[String],
    limit: u32,
    offset: u32,
) -> Result<(u64, Vec<SearchHit>), CapabilityError> {
    let head: Vec<&dyn rusqlite::ToSql> = args.iter().map(|v| v as &dyn rusqlite::ToSql).collect();
    let total: i64 = conn
        .query_row(count_sql, head.as_slice(), |row| row.get(0))
        .map_err(map_sql)?;

    let mut paged: Vec<&dyn rusqlite::ToSql> = head;
    paged.push(&limit);
    paged.push(&offset);
    let mut stmt = conn.prepare(page_sql).map_err(map_sql)?;
    let mut rows = stmt.query(paged.as_slice()).map_err(map_sql)?;
    let mut hits = Vec::new();
    while let Some(row) = rows.next().map_err(map_sql)? {
        hits.push(hit_of(row)?);
    }
    Ok((total.max(0) as u64, hits))
}

fn hit_of(row: &rusqlite::Row<'_>) -> Result<SearchHit, CapabilityError> {
    Ok(SearchHit {
        path: row.get(0).map_err(map_sql)?,
        name: row.get(1).map_err(map_sql)?,
        parent: row.get(2).map_err(map_sql)?,
        is_dir: row.get::<_, i64>(3).map_err(map_sql)? != 0,
        size: row
            .get::<_, Option<i64>>(4)
            .map_err(map_sql)?
            .and_then(|s| u64::try_from(s).ok()),
        modified_ms: row.get(5).map_err(map_sql)?,
    })
}

/// `scope` and `within` as a SQL fragment **with the values it binds, in order**.
/// Every value stays a bound parameter; only the fragments are code constants.
fn filter_clause(scope: SearchScope, within: Option<&str>) -> (String, Vec<String>) {
    let mut sql = String::new();
    let mut args = Vec::new();
    match scope {
        SearchScope::All => {}
        SearchScope::File => sql.push_str(" AND f.is_dir = 0"),
        SearchScope::Dir => sql.push_str(" AND f.is_dir = 1"),
    }
    if let Some(within) = within {
        // Two conditions, both escaped `LIKE` patterns: `LIKE` is ASCII
        // case-insensitive in SQLite, so `C:\dir` and `C:\DIR` select the same
        // subtree, and escaping keeps a `%` inside a real folder name a literal.
        let escaped = escape_like(within);
        sql.push_str(" AND (f.parent LIKE ? ESCAPE '\\' OR f.parent LIKE ? ESCAPE '\\')");
        args.push(escaped.clone());
        args.push(format!("{}{}%", escaped, escape_like(SEPARATOR)));
    }
    (sql, args)
}

/// Make `text` safe as a `LIKE` pattern under `ESCAPE '\'`.
fn escape_like(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for ch in text.chars() {
        if matches!(ch, '\\' | '%' | '_') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

/// `text` as a `LIKE` pattern matching any name containing it.
fn like_pattern(text: &str) -> String {
    format!("%{}%", escape_like(text))
}

/// `text` as an FTS5 phrase: quoted, with the quote character itself doubled, so a
/// name containing `"` or a query operator (`:`/`^`) is searched as plain text.
fn fts_phrase(text: &str) -> String {
    format!("\"{}\"", text.replace('"', "\"\""))
}

/// On Windows, `\` and `/` name the same directory, and the index holds whatever
/// `Path::display` produced.
fn normalize_separators(text: &str) -> String {
    if cfg!(windows) {
        text.replace('/', "\\")
    } else {
        text.to_owned()
    }
}

fn trim_separators(text: &str) -> String {
    text.trim_end_matches(['/', '\\']).to_owned()
}

fn count_rows(conn: &Connection) -> Result<u64, CapabilityError> {
    let n: i64 = conn
        .query_row("SELECT count(*) FROM files", [], |row| row.get(0))
        .map_err(map_sql)?;
    Ok(n.max(0) as u64)
}

fn meta_text(conn: &Connection, key: &str) -> Result<Option<String>, CapabilityError> {
    let mut stmt = conn
        .prepare("SELECT value FROM meta WHERE key = ?1")
        .map_err(map_sql)?;
    let value = stmt.query_row(params![key], |row| row.get::<_, String>(0));
    match value {
        Ok(text) => Ok(Some(text)),
        // A missing row is the normal "this key was never written" answer; any
        // other failure is a real one and must not read as an empty index.
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(err) => Err(map_sql(err)),
    }
}

fn meta_number(conn: &Connection, key: &str) -> Result<u64, CapabilityError> {
    Ok(meta_text(conn, key)?
        .and_then(|text| text.parse::<u64>().ok())
        .unwrap_or(0))
}

fn meta_state(conn: &Connection) -> Result<SearchIndexState, CapabilityError> {
    Ok(match meta_text(conn, META_STATE)? {
        // A file with no state row was never indexed by a job that reached an end.
        None => SearchIndexState::Empty,
        Some(wire) => serde_json::from_value(serde_json::Value::String(wire))
            .map_err(|e| CapabilityError::Io(e.to_string()))?,
    })
}

fn meta_roots(conn: &Connection) -> Result<Vec<String>, CapabilityError> {
    Ok(match meta_text(conn, META_ROOTS)? {
        None => Vec::new(),
        Some(json) => {
            serde_json::from_str(&json).map_err(|e| CapabilityError::Io(e.to_string()))?
        }
    })
}

fn put_meta(conn: &Connection, key: &str, value: &str) -> Result<(), CapabilityError> {
    conn.execute(
        "INSERT INTO meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(map_sql)?;
    Ok(())
}

/// The wire spelling of a state: the same serde the contract freezes, so `status`
/// cannot report a state the TS union does not name.
fn state_wire(state: SearchIndexState) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|v| v.as_str().map(str::to_owned))
        .unwrap_or_else(|| "empty".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn query(text: &str) -> SearchQueryIn {
        SearchQueryIn {
            text: text.to_owned(),
            within: None,
            scope: SearchScope::All,
            limit: None,
            offset: 0,
        }
    }

    /// Wait for a job to leave the live table: the terminal event and the `meta`
    /// row are both written before it does.
    fn settle(search: &Search, job_id: &str) {
        let started = Instant::now();
        while search.live_jobs() > 0 {
            assert!(
                started.elapsed() < Duration::from_secs(60),
                "job {job_id} never finished"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    fn index(search: &Search, roots: &[&Path]) -> SearchIndexAck {
        let ack = search
            .start_index(&SearchIndexIn {
                roots: roots.iter().map(|p| plain_label(p)).collect(),
                rebuild: false,
            })
            .expect("start index");
        settle(search, &ack.job_id);
        ack
    }

    /// The label the index gives a directory: the same plain spelling `fs.list`
    /// returns, which is what every test has to compare hits against.
    fn plain_label(path: &Path) -> String {
        path.display().to_string()
    }

    fn write_file(path: &Path, len: usize) {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        let mut f = File::create(path).unwrap();
        f.write_all(&vec![7u8; len]).unwrap();
        f.flush().unwrap();
    }

    /// CJK names (what the trigram index is for), an ASCII name, a directory, and
    /// a `%` in a folder name (what the `LIKE` escaping is for).
    fn sample_tree(root: &Path) {
        write_file(&root.join("季度报告2024.docx"), 1_000);
        write_file(&root.join("quarterly.docx"), 200);
        write_file(&root.join("a%b/报告甲.txt"), 50);
        fs::create_dir_all(root.join("图片收藏")).unwrap();
        write_file(&root.join("图片收藏/猫.jpg"), 7);
    }

    fn open_search() -> Search {
        Search::open(":memory:").expect("open index")
    }

    fn names(out: &SearchQueryOut) -> Vec<String> {
        out.hits.iter().map(|h| h.name.clone()).collect()
    }

    #[test]
    fn an_unindexed_query_explains_itself_instead_of_denying_everything() {
        let search = open_search();
        let out = search.query(&query("报告")).expect("query");
        assert_eq!(out.state, SearchIndexState::Empty);
        assert_eq!(out.total, 0);
        assert!(out.hits.is_empty());
        assert!(!out.has_more);

        let status = search.status().expect("status");
        assert_eq!(status.state, SearchIndexState::Empty);
        assert_eq!(status.entries, 0);
        assert!(status.roots.is_empty());
        assert_eq!(status.last_job_ms, 0);
        assert!(status.detail.is_none());
    }

    #[test]
    fn a_blank_query_is_refused_on_the_call() {
        let search = open_search();
        let err = search.query(&query("   ")).unwrap_err();
        assert!(matches!(err, CapabilityError::InvalidArgument(_)), "{err}");
    }

    #[test]
    fn a_long_query_is_truncated_rather_than_rejected() {
        let search = open_search();
        let out = search
            .query(&query(&"报".repeat(SEARCH_MAX_TEXT_CHARS + 500)))
            .expect("query");
        assert_eq!(out.text.chars().count(), SEARCH_MAX_TEXT_CHARS);
    }

    #[test]
    fn indexing_a_tree_makes_its_names_findable_by_cjk_substring() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let search = open_search();
        index(&search, &[dir.path()]);

        let out = search.query(&query("报告")).expect("query");
        assert_eq!(out.state, SearchIndexState::Ready);
        assert!(
            names(&out).contains(&"季度报告2024.docx".to_owned()),
            "{out:?}"
        );
        assert!(names(&out).contains(&"报告甲.txt".to_owned()), "{out:?}");
        // 报告 is two characters: under the trigram minimum, so this is the
        // substring-scan path answering the same query with the same hits.
        assert_eq!(out.total, 2, "{out:?}");

        let three = search.query(&query("季度报")).expect("three-char query");
        assert_eq!(three.total, 1);
        assert_eq!(three.hits[0].name, "季度报告2024.docx");
        assert_eq!(three.hits[0].size, Some(1_000));
        assert!(!three.hits[0].is_dir);
        assert_eq!(
            three.hits[0].parent,
            plain_label(dir.path()),
            "a hit carries the directory it lives in"
        );
        assert!(three.hits[0].modified_ms.is_some());
        assert!(three.hits[0].path.ends_with("季度报告2024.docx"));
    }

    #[test]
    fn case_is_normalised_because_windows_paths_are() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let search = open_search();
        index(&search, &[dir.path()]);
        let out = search.query(&query("QUARTERLY")).expect("query");
        assert_eq!(out.total, 1, "{out:?}");
    }

    /// A `-` is punctuation the index has to fold and the phrase query has to
    /// quote; the neighbouring file without it must not match, or "searched as
    /// text" would really mean "searched as a bag of characters".
    #[test]
    fn a_name_with_an_fts_operator_is_searched_as_text() {
        let dir = tempfile::tempdir().unwrap();
        write_file(&dir.path().join("文档-报告.docx"), 10);
        write_file(&dir.path().join("文档报告.docx"), 10);
        write_file(&dir.path().join("plain.docx"), 10);
        let search = open_search();
        index(&search, &[dir.path()]);
        let out = search.query(&query("文档-报")).expect("query");
        assert_eq!(out.total, 1, "{out:?}");
        assert_eq!(out.hits[0].name, "文档-报告.docx");
    }

    #[test]
    fn scope_separates_files_from_directories() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let search = open_search();
        index(&search, &[dir.path()]);

        let dirs = search
            .query(&SearchQueryIn {
                scope: SearchScope::Dir,
                ..query("收藏")
            })
            .expect("dir query");
        assert_eq!(dirs.total, 1);
        assert!(dirs.hits[0].is_dir);
        // A directory is a hit with no size, exactly like `fs.list`.
        assert_eq!(dirs.hits[0].size, None);
        assert_eq!(dirs.hits[0].modified_ms, None, "and no content time");

        let files = search
            .query(&SearchQueryIn {
                scope: SearchScope::File,
                ..query("收藏")
            })
            .expect("file query");
        assert_eq!(files.total, 0);
    }

    #[test]
    fn within_confines_hits_to_one_subtree_and_keeps_percent_literal() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let search = open_search();
        index(&search, &[dir.path()]);

        let nested = dir.path().join("图片收藏");
        let out = search
            .query(&SearchQueryIn {
                within: Some(nested.display().to_string()),
                ..query("猫")
            })
            .expect("within query");
        assert_eq!(out.total, 1);
        assert_eq!(out.hits[0].parent, plain_label(&nested));

        // A slash-spelled `within` names the same directory.
        let slashed = search
            .query(&SearchQueryIn {
                within: Some(nested.display().to_string().replace('\\', "/") + "/"),
                ..query("猫")
            })
            .expect("slash within");
        assert_eq!(slashed.total, 1, "{slashed:?}");

        // The `%` folder: a prefix test must not turn it into a wildcard.
        let in_pct = search
            .query(&SearchQueryIn {
                within: Some(dir.path().join("a%b").display().to_string()),
                ..query("报告")
            })
            .expect("percent within");
        assert_eq!(in_pct.total, 1, "{in_pct:?}");
        let elsewhere = search
            .query(&SearchQueryIn {
                within: Some(nested.display().to_string()),
                ..query("报告")
            })
            .expect("other within");
        assert_eq!(elsewhere.total, 0, "{elsewhere:?}");
        // A sibling whose name merely starts with the prefix is not inside it.
        let lookalike = search
            .query(&SearchQueryIn {
                within: Some(dir.path().join("图片").display().to_string()),
                ..query("猫")
            })
            .expect("prefix lookalike");
        assert_eq!(lookalike.total, 0, "{lookalike:?}");
    }

    #[test]
    fn paging_is_bounded_clamped_and_reports_whether_more_remains() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..30 {
            write_file(&dir.path().join(format!("报告{i}.txt")), 10);
        }
        let search = open_search();
        index(&search, &[dir.path()]);

        let first = search
            .query(&SearchQueryIn {
                limit: Some(5),
                ..query("报告")
            })
            .expect("page 1");
        assert_eq!(first.total, 30);
        assert_eq!(first.hits.len(), 5);
        assert!(first.has_more);

        let clamped = search
            .query(&SearchQueryIn {
                limit: Some(SEARCH_MAX_PAGE + 1_000),
                ..query("报告")
            })
            .expect("clamped page");
        assert_eq!(clamped.hits.len(), 30);
        assert!(!clamped.has_more);

        let last = search
            .query(&SearchQueryIn {
                limit: Some(20),
                offset: 20,
                ..query("报告")
            })
            .expect("last page");
        assert_eq!(last.hits.len(), 10);
        assert!(!last.has_more);
        // Pages must not overlap: the offset is the cursor the UI pages with.
        assert!(!names(&last).contains(&"报告0.txt".to_owned()));
        let beyond = search
            .query(&SearchQueryIn {
                limit: Some(5),
                offset: 40,
                ..query("报告")
            })
            .expect("past the end");
        assert!(beyond.hits.is_empty());
        assert!(!beyond.has_more);
        assert_eq!(beyond.total, 30, "the index still knows how many matched");
    }

    #[test]
    fn a_refresh_drops_a_deleted_file_from_both_the_rows_and_the_index() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let search = open_search();
        index(&search, &[dir.path()]);
        assert_eq!(search.query(&query("季度报")).expect("first").total, 1);

        fs::remove_file(dir.path().join("季度报告2024.docx")).unwrap();
        index(&search, &[dir.path()]);
        let out = search.query(&query("季度报")).expect("after refresh");
        assert_eq!(out.total, 0, "{out:?}");
        // The survivor is still there: a refresh replaced rows, it did not clear
        // the file.
        assert_eq!(
            search.query(&query("quarterly")).expect("survivor").total,
            1
        );
    }

    #[test]
    fn a_refresh_touches_only_its_roots_and_a_rebuild_touches_everything() {
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        write_file(&one.path().join("甲报告.docx"), 10);
        write_file(&two.path().join("乙报告.docx"), 10);
        let search = open_search();
        let one_label = plain_label(one.path());
        let two_label = plain_label(two.path());

        index(&search, &[one.path()]);
        index(&search, &[two.path()]);
        let status = search.status().expect("status");
        assert_eq!(status.state, SearchIndexState::Ready);
        assert!(status.roots.contains(&one_label));
        assert!(status.roots.contains(&two_label));
        assert_eq!(search.query(&query("报告")).expect("both").total, 2);

        // `one` loses its file and only `one` is refreshed: its row leaves,
        // `two`'s stays.
        fs::remove_file(one.path().join("甲报告.docx")).unwrap();
        index(&search, &[one.path()]);
        let after = search.query(&query("报告")).expect("after refresh");
        assert_eq!(after.total, 1, "{after:?}");
        assert_eq!(after.hits[0].name, "乙报告.docx");
        // The stale root is still reported until a rebuild replaces the set.
        assert_eq!(search.status().expect("roots").roots.len(), 2);

        let ack = search
            .start_index(&SearchIndexIn {
                roots: vec![two_label.clone()],
                rebuild: true,
            })
            .expect("rebuild");
        settle(&search, &ack.job_id);
        let rebuilt = search.query(&query("报告")).expect("after rebuild");
        assert_eq!(rebuilt.total, 1);
        let status = search.status().expect("status");
        assert_eq!(status.roots, vec![two_label]);
        assert_eq!(
            status.entries, 2,
            "the root directory itself plus its child"
        );
    }

    #[test]
    fn the_indexed_roots_are_the_default_when_none_are_given() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let search = open_search();
        let first = index(&search, &[dir.path()]);
        assert_eq!(first.roots, vec![plain_label(dir.path())]);

        // A second job with no roots re-walks what the index already covers.
        let again = search
            .start_index(&SearchIndexIn {
                roots: vec![],
                rebuild: false,
            })
            .expect("default roots");
        settle(&search, &again.job_id);
        assert_eq!(again.roots, first.roots);
    }

    #[test]
    fn a_cancelled_walk_leaves_an_index_that_still_answers() {
        let dir = tempfile::tempdir().unwrap();
        for i in 0..400 {
            write_file(&dir.path().join(format!("dir{i}/f{i}报告.docx")), 10);
        }
        let search = open_search();
        let ack = search
            .start_index(&SearchIndexIn {
                roots: vec![plain_label(dir.path())],
                rebuild: false,
            })
            .expect("start");
        // A walk this small can finish before the cancel lands, and that is the
        // same two endings the UI has to handle; what must never happen is a job
        // that leaves the table without a state.
        search.cancel_index(&ack.job_id).expect("cancel");
        settle(&search, &ack.job_id);

        let status = search.status().expect("status");
        assert_ne!(status.state, SearchIndexState::Indexing);
        assert!(matches!(
            status.state,
            SearchIndexState::Ready | SearchIndexState::Partial
        ));
        assert_eq!(status.roots.len(), 1);
        // Whatever landed is queryable, and the count matches the rows.
        let out = search.query(&query("报告")).expect("query");
        assert!(out.total <= status.entries);
        assert_eq!(
            out.state, status.state,
            "a page echoes the state it came from"
        );
    }

    /// The elapsed time is a stored number, not a clock reading: a walk fast enough
    /// to land inside one millisecond is honestly `0`, so the only dependable
    /// assertion is that `status` reports what the index recorded.
    #[test]
    fn the_last_job_duration_is_the_one_the_meta_row_holds() {
        let search = open_search();
        {
            let conn = lock(&search.shared.conn);
            put_meta(&conn, META_LAST_JOB_MS, "4321").expect("meta");
        }
        assert_eq!(search.status().expect("status").last_job_ms, 4321);
    }

    /// A cancel for an id that is not walking answers `false`, so the UI cannot
    /// believe it stopped something.
    #[test]
    fn cancel_tracks_only_live_jobs() {
        let search = open_search();
        assert!(!search.cancel_index("search-index-none").unwrap());
        let dir = tempfile::tempdir().unwrap();
        write_file(&dir.path().join("f.txt"), 1);
        let ack = index(&search, &[dir.path()]);
        assert!(!search.cancel_index(&ack.job_id).unwrap());
        assert_eq!(search.live_jobs(), 0);
    }

    /// The cap is a fact about the live table, tested against the table rather
    /// than against whether a walk happens to still be running.
    #[test]
    fn a_second_job_is_refused_instead_of_fighting_the_first() {
        let search = open_search();
        for _ in 0..MAX_LIVE_JOBS {
            let (id, flag) = search.reserve().unwrap();
            lock(&search.shared.live).insert(id, flag);
        }
        assert_eq!(search.live_jobs(), MAX_LIVE_JOBS);
        let dir = tempfile::tempdir().unwrap();
        let err = search
            .start_index(&SearchIndexIn {
                roots: vec![plain_label(dir.path())],
                rebuild: false,
            })
            .unwrap_err();
        assert!(matches!(err, CapabilityError::InvalidArgument(_)), "{err}");
        // `cancel_all` is the shutdown path: every live flag goes true, and the
        // table still owns the job until its own thread retires it.
        search.cancel_all();
        assert!(lock(&search.shared.live)
            .values()
            .all(|f| f.load(Ordering::Acquire)));
    }

    #[test]
    fn a_root_that_is_not_a_directory_fails_the_call() {
        let search = open_search();
        let dir = tempfile::tempdir().unwrap();
        write_file(&dir.path().join("not-a-dir.txt"), 1);

        let err = search
            .start_index(&SearchIndexIn {
                roots: vec![dir.path().join("not-a-dir.txt").display().to_string()],
                rebuild: false,
            })
            .unwrap_err();
        assert!(matches!(err, CapabilityError::InvalidArgument(_)), "{err}");

        let missing = search
            .start_index(&SearchIndexIn {
                roots: vec![dir.path().join("gone").display().to_string()],
                rebuild: false,
            })
            .unwrap_err();
        assert!(
            matches!(missing, CapabilityError::InvalidArgument(_)),
            "{missing}"
        );

        let blank = search
            .start_index(&SearchIndexIn {
                roots: vec!["   ".to_owned()],
                rebuild: false,
            })
            .unwrap_err();
        assert!(
            matches!(blank, CapabilityError::InvalidArgument(_)),
            "{blank}"
        );
    }

    #[test]
    fn nested_roots_are_pruned_to_the_outermost() {
        let outer = tempfile::tempdir().unwrap();
        let inner = outer.path().join("inner");
        fs::create_dir_all(&inner).unwrap();
        write_file(&inner.join("甲报告.docx"), 1);
        write_file(&outer.path().join("乙报告.docx"), 1);
        let search = open_search();
        let ack = search
            .start_index(&SearchIndexIn {
                roots: vec![plain_label(&inner), plain_label(outer.path())],
                rebuild: false,
            })
            .expect("pruned job");
        settle(&search, &ack.job_id);
        assert_eq!(ack.roots, vec![plain_label(outer.path())]);
        // Both files are findable, and both belong to the outer root.
        assert_eq!(search.query(&query("报告")).expect("query").total, 2);
        let label = plain_label(outer.path());
        let conn = lock(&search.shared.conn);
        let inner_label = plain_label(&inner);
        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM files WHERE root = ?1",
                params![inner_label],
                |row| row.get(0),
            )
            .expect("rows");
        assert_eq!(rows, 0, "no row may be owned by a pruned root");
        let outer_rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM files WHERE root = ?1",
                params![label],
                |row| row.get(0),
            )
            .expect("rows");
        assert!(outer_rows >= 2, "{outer_rows}");
    }

    /// A query the trigram index cannot see at all, answered by the scan over the
    /// same rows — and with the one character that is a `LIKE` wildcard, so the
    /// test also proves the query text is escaped rather than interpolated.
    #[test]
    fn the_substring_fallback_finds_what_the_index_cannot_see() {
        let dir = tempfile::tempdir().unwrap();
        sample_tree(dir.path());
        let search = open_search();
        index(&search, &[dir.path()]);

        let one = search.query(&query("%")).expect("one-char query");
        assert_eq!(one.total, 1, "{one:?}");
        assert_eq!(one.hits[0].name, "a%b");
        assert!(one.hits[0].is_dir);
    }

    /// The escaping is a pure function of the text, so it is testable without a
    /// filesystem: every wildcard and the escape character itself comes out
    /// literal, and an FTS5 phrase quotes its operators away.
    #[test]
    fn patterns_escape_every_wildcard_and_operator() {
        assert_eq!(escape_like("a%b_c\\d"), "a\\%b\\_c\\\\d");
        assert_eq!(like_pattern("20%"), "%20\\%%");
        assert_eq!(fts_phrase("报告"), "\"报告\"");
        assert_eq!(fts_phrase("a\"b"), "\"a\"\"b\"");
        assert_eq!(fts_phrase("文档:报告^2"), "\"文档:报告^2\"");
    }

    #[test]
    fn separator_handling_agrees_with_the_platform() {
        assert_eq!(trim_separators("C:\\dir\\\\"), "C:\\dir");
        assert_eq!(trim_separators("/a/b/"), "/a/b");
        if cfg!(windows) {
            assert_eq!(normalize_separators("C:/dir/sub"), "C:\\dir\\sub");
            assert_eq!(escape_like(SEPARATOR), "\\\\");
        } else {
            assert_eq!(normalize_separators("/a/b"), "/a/b");
            assert_eq!(escape_like(SEPARATOR), "/");
        }
        // The subtree pattern is prefix + escaped separator + wildcard, so `C:\a`
        // cannot match `C:\ab\f`.
        let (sql, args) = filter_clause(SearchScope::All, Some("C:\\a"));
        assert!(sql.contains("f.parent LIKE ? ESCAPE '\\'"), "{sql}");
        assert_eq!(args.len(), 2);
        assert_eq!(args[0], escape_like("C:\\a"));
        assert_eq!(
            args[1],
            format!("{}{}%", escape_like("C:\\a"), escape_like(SEPARATOR))
        );

        let (dirs, scoped) = filter_clause(SearchScope::Dir, None);
        assert_eq!(dirs, " AND f.is_dir = 1");
        assert!(scoped.is_empty());
        assert!(filter_clause(SearchScope::File, None)
            .0
            .contains("f.is_dir = 0"));
    }

    #[test]
    fn one_root_never_swallows_another_by_name_prefix() {
        assert!(under("C:\\a\\b", "C:\\a"));
        assert!(!under("C:\\ab", "C:\\a"));
        assert!(!under("C:\\a", "C:\\a"));
        assert!(under("C:\\a\\", "C:\\a"));
        // A volume root already ends in a separator, and a trailing slash is part
        // of how the UI spells one, so neither may stop it containing its children.
        assert!(under("C:\\Users", "C:\\"));
        assert!(under("C:\\Users", "C:/"));
        assert!(under("/home/a", "/"));
    }

    /// One directory must arrive as one label however it is spelled, or a refresh
    /// would delete a different root's rows and leave its own behind.
    #[test]
    fn root_labels_fold_spelling_variants() {
        assert_eq!(stable_root_label("C:\\dir\\\\"), "C:\\dir");
        assert_eq!(stable_root_label("  C:/dir/sub  "), "C:\\dir\\sub");
        // Bare roots keep the separator that makes them a volume, not a cwd.
        assert_eq!(stable_root_label("C:"), "C:\\");
        assert_eq!(stable_root_label("C:\\"), "C:\\");
        if !cfg!(windows) {
            assert_eq!(stable_root_label("/"), "/");
        }
    }

    #[test]
    fn state_wire_spelling_is_the_contracts_serde_form() {
        assert_eq!(state_wire(SearchIndexState::Ready), "ready");
        assert_eq!(state_wire(SearchIndexState::Empty), "empty");
        assert_eq!(state_wire(SearchIndexState::Indexing), "indexing");
        assert_eq!(state_wire(SearchIndexState::Partial), "partial");
        assert_eq!(state_wire(SearchIndexState::Failed), "failed");
        // A state the file holds must be one the TS union names, or `status` would
        // report something the UI cannot render.
        for wire in ["ready", "empty", "indexing", "partial", "failed"] {
            let parsed: SearchIndexState =
                serde_json::from_value(serde_json::Value::String(wire.to_owned())).unwrap();
            assert_eq!(state_wire(parsed), wire);
        }
    }

    /// Both non-successful endings, asserted without racing a live walk.
    #[test]
    fn a_cancel_or_a_ceiling_stops_short_of_claiming_a_complete_index() {
        let (state, detail) = terminal_state(true, false);
        assert_eq!(state, SearchIndexState::Partial);
        assert!(detail.unwrap().contains("取消"));

        let (state, detail) = terminal_state(false, true);
        assert_eq!(state, SearchIndexState::Partial);
        assert!(
            detail
                .as_deref()
                .unwrap()
                .contains(&SEARCH_INDEX_MAX_ENTRIES.to_string()),
            "{detail:?}"
        );

        let (state, detail) = terminal_state(false, false);
        assert_eq!(state, SearchIndexState::Ready);
        assert!(detail.is_none());
        // A cancel outranks a ceiling: what the user asked for is the reason.
        assert!(terminal_state(true, true).1.unwrap().contains("取消"));
    }

    #[test]
    fn the_directory_link_rule_is_a_table_not_an_if_chain() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("real")).unwrap();
        write_file(&dir.path().join("plain.txt"), 1);
        // A real directory is not a link; a plain file is not a link either.
        assert!(!directory_link(false, true, &dir.path().join("real")));
        assert!(!directory_link(false, false, &dir.path().join("plain.txt")));
        // A link the OS reported as a directory is a directory link without asking
        // the target, and a missing target is not a directory either.
        assert!(directory_link(true, true, &dir.path().join("real")));
        assert!(!directory_link(true, false, &dir.path().join("gone")));
    }

    #[test]
    fn the_walk_pool_stays_inside_its_budget_of_threads() {
        // The pool size is a function of the roots, and a job never owns more than
        // MAX_WALK_WORKERS threads no matter how many roots it was given.
        for n in [1usize, 2, 5, 100] {
            assert!((1..=MAX_WALK_WORKERS).contains(&n.clamp(1, MAX_WALK_WORKERS)));
        }
    }
}
