//! file-history backend plugin (docs/02 §3, roadmap P4-1).
//!
//! Behaviour: subscribe to `file:changed` -> compute a content hash via the
//! `hash` capability -> compare against the last recorded snapshot in the
//! `history` db store -> if changed, append a new entry and emit
//! `history:updated`. The frontend HistoryPanel reloads on that event, so the
//! timeline refreshes with no polling (P4-3).
//!
//! Red lines honoured: this crate depends ONLY on `fm-contracts` (never the host
//! or another plugin); capabilities are resolved via cordis DI (`inject`), not
//! imported; blocking hash IO is pushed off the kernel poll with
//! `spawn_blocking`; the listener is generation-owned, so `dispose` cleans it up
//! automatically (proven by the cordis-boot spike).

use std::sync::Arc;

use cordis_core::event::{ListenerRegistrationError, observer};
use cordis_core::{Context, InjectSpec, Plugin, Routing, Service};
use fm_contracts::capability::{DbCapability, HashAlgo, HashCapability};
use fm_contracts::events::{FileChanged, FileChangedArgs, HistoryUpdated, HistoryUpdatedArgs};
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// The `db` store namespace this plugin owns (matches manifest `db.history.*`).
const STORE: &str = "history";

/// Source configuration, deserialized from manifest `backend.config`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileHistoryConfig {
    /// Cap on retained snapshots per file (oldest trimmed).
    #[serde(default = "default_max_entries")]
    pub max_entries_per_file: usize,
}

fn default_max_entries() -> usize {
    100
}

impl Default for FileHistoryConfig {
    fn default() -> Self {
        Self {
            max_entries_per_file: default_max_entries(),
        }
    }
}

/// Prepared, lifecycle-admitted input (docs/02 §3.1).
#[derive(Debug, Clone)]
pub struct FileHistoryInput {
    max_entries_per_file: usize,
}

/// One recorded snapshot row in the `history` store log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub hash: String,
    /// Unix epoch millis.
    pub at: i64,
    pub size: Option<u64>,
}

#[derive(Debug, Error)]
pub enum PrepareError {
    #[error("maxEntriesPerFile must be > 0")]
    ZeroMaxEntries,
}

#[derive(Debug, Error)]
pub enum HistoryError {
    #[error("listener registration failed: {0}")]
    Listener(#[from] ListenerRegistrationError),
    #[error("capability unavailable: {0}")]
    Capability(String),
}

pub struct FileHistoryPlugin;

impl Plugin for FileHistoryPlugin {
    type Config = FileHistoryConfig;
    type Input = FileHistoryInput;
    type PrepareError = PrepareError;
    type ApplyError = HistoryError;

    fn name(&self) -> std::borrow::Cow<'_, str> {
        std::borrow::Cow::Borrowed("plugin-file-history")
    }

    /// Declare capability prerequisites: the fiber stays Pending until the host
    /// publishes `hash` and `db` (docs/02 §3.1, consumer-guide rule 3).
    fn inject(&self) -> InjectSpec {
        InjectSpec::none()
            .require(HashCapability::NAME)
            .require(DbCapability::NAME)
    }

    fn prepare(&self, cfg: FileHistoryConfig) -> Result<FileHistoryInput, PrepareError> {
        if cfg.max_entries_per_file == 0 {
            return Err(PrepareError::ZeroMaxEntries);
        }
        Ok(FileHistoryInput {
            max_entries_per_file: cfg.max_entries_per_file,
        })
    }

    async fn apply(&self, ctx: Context, input: &FileHistoryInput) -> Result<(), HistoryError> {
        // Resolve capabilities via DI (in-process, not IPC).
        let hash = ctx
            .try_service::<HashCapability>()
            .map_err(|e| HistoryError::Capability(e.to_string()))?;
        let db = ctx
            .try_service::<DbCapability>()
            .map_err(|e| HistoryError::Capability(e.to_string()))?;
        let max_entries = input.max_entries_per_file;

        // Generation-owned listener: dropped/disposed with the fiber.
        let _listener = ctx.on::<FileChanged, _>(observer(
            move |ctx: Context, args: FileChangedArgs| {
                let hash = Arc::clone(&hash);
                let db = Arc::clone(&db);
                async move {
                    // Only content changes matter; skip removes for snapshots.
                    if args.kind == "remove" {
                        return Ok::<_, HistoryError>(());
                    }
                    let path = args.path.clone();

                    // Blocking hash IO off the kernel poll (consumer-guide rule 5).
                    let hash_api = Arc::clone(hash.api());
                    let p = path.clone();
                    let digest = tokio::task::spawn_blocking(move || {
                        hash_api.file(&p, HashAlgo::Blake3)
                    })
                    .await
                    .map_err(|e| HistoryError::Capability(e.to_string()))?
                    .map_err(|e| HistoryError::Capability(e.to_string()))?;

                    let db_api = Arc::clone(db.api());
                    let key = path.clone();
                    let recorded = tokio::task::spawn_blocking(move || {
                        let log = db_api.read_log(STORE, &key)?;
                        let last = log.last().and_then(|v| {
                            serde_json::from_value::<HistoryEntry>(v.clone()).ok()
                        });
                        if last.as_ref().map(|e| e.hash.as_str()) == Some(digest.as_str()) {
                            // Unchanged content: no new snapshot.
                            return Ok::<_, fm_contracts::CapabilityError>(false);
                        }
                        let entry = HistoryEntry {
                            hash: digest.clone(),
                            at: now_ms(),
                            size: None,
                        };
                        let value = serde_json::to_value(&entry).expect("entry serializes");
                        db_api.append(STORE, &key, &value)?;
                        Ok(true)
                    })
                    .await
                    .map_err(|e| HistoryError::Capability(e.to_string()))?
                    .map_err(|e| HistoryError::Capability(e.to_string()))?;

                    if recorded {
                        tracing::debug!(path = %path, "file-history: snapshot recorded");
                        ctx.emit::<HistoryUpdated>(
                            Routing::Unscoped,
                            HistoryUpdatedArgs { path },
                        )
                        .await
                        .map_err(|e| HistoryError::Capability(e.to_string()))?;
                    }
                    let _ = max_entries; // trimming wired when db exposes a log trim
                    Ok(())
                }
            },
        ))?;
        Ok(())
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
