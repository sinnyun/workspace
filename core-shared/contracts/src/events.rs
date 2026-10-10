//! Typed cordis `Event`s shared across the kernel/plugin boundary.
//!
//! Event `NAME`s follow the `domain:action` (past tense) convention
//! (docs/03-project-layout.md §7). The same names are used verbatim on the
//! frontend bus; a contract test (P3-3) will assert the two sides agree.

use cordis_core::Event;
use serde::{Deserialize, Serialize};

/// Emitted by the `watch` capability when a watched path changes.
pub struct FileChanged;

impl Event for FileChanged {
    const NAME: &'static str = "file:changed";
    type Args = FileChangedArgs;
    type Output = ();
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileChangedArgs {
    pub path: String,
    /// create / modify / remove / ...
    pub kind: String,
}

/// Emitted by the file-history backend plugin after it records a new snapshot.
pub struct HistoryUpdated;

impl Event for HistoryUpdated {
    const NAME: &'static str = "history:updated";
    type Args = HistoryUpdatedArgs;
    type Output = ();
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HistoryUpdatedArgs {
    /// The file whose history gained an entry.
    pub path: String,
}

/// Emitted while a `shell.fileOperation` runs. The payload states plainly
/// whether progress is trustworthy, so the UI can be indeterminate rather than
/// invent a percentage (docs/09 §9.4, roadmap P7-18).
pub struct ShellOperationProgress;

impl Event for ShellOperationProgress {
    const NAME: &'static str = "shell:operation:progress";
    type Args = crate::capability::FileOperationProgress;
    type Output = ();
}

/// Emitted once, with the per-item truth, when an operation reaches a terminal
/// state. Deliberately a separate event from progress: `partial-failure` must not
/// be inferable from the absence of a further progress tick.
pub struct ShellOperationDone;

impl Event for ShellOperationDone {
    const NAME: &'static str = "shell:operation:done";
    type Args = crate::capability::FileOperationResult;
    type Output = ();
}

/// Emitted while a `sys.scan.start` job walks the tree. Throttled by the
/// provider and deliberately *counter-only*: an entry ceiling means the total is
/// unknown up front, so a percentage would be a fabrication
/// (docs/plugin-functional/plugin-storage-analysis.md, roadmap P7-23).
pub struct ScanProgressEvent;

impl Event for ScanProgressEvent {
    const NAME: &'static str = "scan:progress";
    type Args = crate::capability::ScanProgress;
    type Output = ();
}

/// Emitted once when a scan reaches a terminal state, carrying the aggregate
/// tree, the skipped list and whether the result is partial. Separate from
/// progress for the same reason `shell:operation:done` is: a cancelled scan must
/// not have to be inferred from a missing tick.
pub struct ScanDoneEvent;

impl Event for ScanDoneEvent {
    const NAME: &'static str = "scan:done";
    type Args = crate::capability::ScanDone;
    type Output = ();
}

/// Emitted while a `search.index.start` job walks the roots. Counters only:
/// the entry ceiling means the total is unknown up front.
///
/// Results themselves are **not** an event. `search.query` is paged
/// request/response (`offset` + `hasMore`), which gives the same incremental
/// behaviour without a second channel that has to be correlated with a query —
/// the roadmap's `search:results` name was folded into it (docs/05 D24).
pub struct SearchIndexProgressEvent;

impl Event for SearchIndexProgressEvent {
    const NAME: &'static str = "search:index-progress";
    type Args = crate::capability::SearchIndexProgress;
    type Output = ();
}

/// Emitted once when an indexing job reaches a terminal state, partial or not.
/// Separate from progress so a cancelled job cannot be inferred from a missing
/// tick, exactly like `scan:done`.
pub struct SearchIndexDoneEvent;

impl Event for SearchIndexDoneEvent {
    const NAME: &'static str = "search:index-done";
    type Args = crate::capability::SearchIndexDone;
    type Output = ();
}
