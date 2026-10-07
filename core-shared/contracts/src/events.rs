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
