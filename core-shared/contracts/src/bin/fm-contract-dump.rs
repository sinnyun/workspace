//! Prints the cross-language contract as JSON on stdout:
//!   { "events": { "<name>": { "args": "<TsInterface>", "fields": [...] } },
//!     "capabilities": ["<domain.action>..."],
//!     "dtos": { "<Type>": [serdeFieldNames...] },
//!     "enums": { "<TsUnion>": [variant...] } }
//!
//! Consumed by `apps/shell-ui/scripts/contract-check.mjs`, which asserts the
//! TypeScript SDK mirrors these names and fields exactly (roadmap P3-3).
//! Field names come from serde itself, so a rename drift fails the check.
//!
//! Every contract type is constructed **here and nowhere else**: adding a DTO to
//! this list is what puts it under the guard, and the `contracts` crate re-exports
//! its whole surface at the root, so a type can be added without editing this file
//! only if the reviewer accepts it being unchecked — which `contract:check` makes
//! visible rather than silently tolerating.

use fm_contracts::capability::names;
use fm_contracts::{
    FileChanged, FileChangedArgs, FileConflictPolicy, FileFailureReason, FileItemOutcome,
    FileKind, FileKindOut, FileOperationKind, FileOperationIn, FileOperationItem, FileOperationOut, FileOperationProgress,
    FileOperationResult, FileOperationState, HistoryUpdated, HistoryUpdatedArgs, ListEntry,
    PickFilter, PickIn, PickOut, ReadResourceIn, ReadResourceOut, ReadTextOut, ResourceIn,
    ResourceOut, ScanAck, ScanDone, ScanDoneEvent, ScanIn, ScanNode, ScanProgress, ScanProgressEvent,
    ScanSkipReason, ScanSkipped, ScanState, DiskListIn, DiskListOut, DiskVolume,
    ShellThumbnailOut, StatOut, TextReadState,
    ThumbnailPolicy, ThumbnailState,
};
use cordis_core::Event;
use serde::Serialize;
use serde_json::{json, Value};

fn fields<T: Serialize>(v: &T) -> Vec<String> {
    match serde_json::to_value(v).unwrap() {
        Value::Object(map) => map.keys().cloned().collect(),
        _ => panic!("contract type must serialize to an object"),
    }
}

/// Wire names of an enum's variants, in declaration order. The TS SDK mirrors
/// these as a string union, so a renamed variant fails `contract:check`.
fn variants<T: Serialize>(vs: &[T]) -> Vec<String> {
    vs.iter()
        .map(|v| match serde_json::to_value(v).unwrap() {
            Value::String(s) => s,
            other => panic!("contract enum must serialize to a string, got {other}"),
        })
        .collect()
}

/// One event entry: the payload's TS interface name plus its serde field names.
fn event<A: Serialize>(args_iface: &str, sample: &A) -> Value {
    json!({ "args": args_iface, "fields": fields(sample) })
}

fn main() {
    let out = json!({
        "events": {
            FileChanged::NAME: event("FileChangedArgs", &FileChangedArgs { path: String::new(), kind: String::new() }),
            HistoryUpdated::NAME: event("HistoryUpdatedArgs", &HistoryUpdatedArgs { path: String::new() }),
            fm_contracts::ShellOperationProgress::NAME: event(
                "FileOperationProgress",
                &FileOperationProgress {
                    operation_id: String::new(),
                    state: FileOperationState::Running,
                    request_token: None,
                    processed: 0,
                    total: 0,
                    indeterminate: true,
                    current_name: None,
                },
            ),
            fm_contracts::ShellOperationDone::NAME: event(
                "FileOperationResult",
                &FileOperationResult {
                    operation_id: String::new(),
                    state: FileOperationState::Completed,
                    request_token: None,
                    items: Vec::new(),
                    cross_volume_move: false,
                },
            ),
            ScanProgressEvent::NAME: event(
                "ScanProgressPayload",
                &ScanProgress {
                    scan_id: String::new(),
                    path: String::new(),
                    entries: 0,
                    bytes: 0,
                    skipped: Vec::new(),
                    state: ScanState::Running,
                },
            ),
            ScanDoneEvent::NAME: event(
                "ScanDonePayload",
                &ScanDone {
                    scan_id: String::new(),
                    tree: ScanNode {
                        name: String::new(),
                        path: String::new(),
                        is_dir: true,
                        bytes: 0,
                        child_count: None,
                        children: None,
                        kinds: None,
                    },
                    skipped: Vec::new(),
                    cancelled: false,
                    truncated_at_depth: None,
                    elapsed_ms: 0,
                    entries: 0,
                },
            ),
        },
        "capabilities": [
            names::FS_HOME,
            names::FS_LIST,
            names::FS_STAT,
            names::FS_READ_CHUNK,
            names::FS_READ_TEXT,
            names::FS_OPEN_RESOURCE,
            names::FS_READ_RESOURCE,
            names::FS_CLOSE_RESOURCE,
            names::HASH_COMPUTE,
            names::SHELL_THUMBNAIL_READ,
            names::SHELL_FILE_OPERATION,
            names::SHELL_CANCEL_FILE_OPERATION,
            names::SHELL_OPEN_PATH,
            names::SHELL_REVEAL_ITEM,
            names::SHELL_PICK_FILE,
            names::SHELL_PICK_DIRECTORY,
            names::FILE_KIND,
            names::WATCH_SUBSCRIBE,
            names::SYS_DISK_LIST,
            names::SYS_SCAN_START,
            names::SYS_SCAN_CANCEL,
        ],
        "dtos": {
            "ListEntry": fields(&ListEntry {
                name: String::new(),
                path: String::new(),
                is_dir: false,
                size: None,
                modified_ms: None,
            }),
            "ReadTextOut": fields(&ReadTextOut {
                path: String::new(),
                state: TextReadState::Ok,
                text: None,
                encoding: None,
                byte_length: 0,
            }),
            "ResourceIn": fields(&ResourceIn { path: String::new() }),
            "ResourceOut": fields(&ResourceOut {
                handle: String::new(),
                path: String::new(),
                byte_length: 0,
                mime: None,
                expires_ms: 0,
            }),
            "ReadResourceIn": fields(&ReadResourceIn {
                handle: String::new(),
                offset: 0,
                length: 0,
                request_token: None,
            }),
            "ReadResourceOut": fields(&ReadResourceOut {
                handle: String::new(),
                offset: 0,
                data: String::new(),
                total: 0,
                eof: false,
                request_token: None,
            }),
            "StatOut": fields(&StatOut {
                path: String::new(),
                is_dir: false,
                size: 0,
                modified_ms: None,
            }),
            "ShellThumbnailOut": fields(&ShellThumbnailOut {
                state: ThumbnailState::Ready,
                data_url: None,
                mime: None,
                edge: 0,
                from_cache: false,
            }),
            "FileOperationIn": fields(&FileOperationIn {
                op: FileOperationKind::Copy,
                sources: Vec::new(),
                destination: None,
                new_name: None,
                to_recycle_bin: true,
                conflict: FileConflictPolicy::default(),
                request_token: None,
            }),
            "FileOperationOut": fields(&FileOperationOut {
                operation_id: String::new(),
                state: FileOperationState::Queued,
                total: 0,
                indeterminate: true,
            }),
            "FileOperationProgress": fields(&FileOperationProgress {
                operation_id: String::new(),
                state: FileOperationState::Running,
                request_token: None,
                processed: 0,
                total: 0,
                indeterminate: true,
                current_name: None,
            }),
            "FileOperationItem": fields(&FileOperationItem {
                source: String::new(),
                destination: None,
                outcome: FileItemOutcome::Completed,
                reason: None,
                message: None,
            }),
            "FileOperationResult": fields(&FileOperationResult {
                operation_id: String::new(),
                state: FileOperationState::Completed,
                request_token: None,
                items: Vec::new(),
                cross_volume_move: false,
            }),
            "PickIn": fields(&PickIn {
                title: None,
                initial_dir: None,
                filters: Vec::new(),
                multiple: false,
            }),
            "PickFilter": fields(&PickFilter {
                description: String::new(),
                patterns: Vec::new(),
            }),
            "PickOut": fields(&PickOut { paths: Vec::new(), cancelled: false }),
            "FileKindOut": fields(&FileKindOut {
                path: String::new(),
                kind: FileKind::Unknown,
                extension: String::new(),
                mime: None,
            }),
            "DiskListIn": fields(&DiskListIn { path: String::new() }),
            "DiskVolume": fields(&DiskVolume {
                root_path: String::new(),
                label: String::new(),
                filesystem: String::new(),
                total_bytes: 0,
                used_bytes: 0,
                free_bytes: 0,
            }),
            "DiskListOut": fields(&DiskListOut {
                path: String::new(),
                volumes: Vec::new(),
            }),
            "ScanIn": fields(&ScanIn {
                root_path: String::new(),
            }),
            "ScanAck": fields(&ScanAck {
                scan_id: String::new(),
                state: ScanState::Queued,
                root_path: String::new(),
            }),
            "ScanSkipped": fields(&ScanSkipped {
                path: String::new(),
                reason: ScanSkipReason::ReadFailed,
            }),
            "ScanNode": fields(&ScanNode {
                name: String::new(),
                path: String::new(),
                is_dir: false,
                bytes: 0,
                child_count: None,
                children: None,
                kinds: None,
            }),
            "ScanProgressPayload": fields(&ScanProgress {
                scan_id: String::new(),
                path: String::new(),
                entries: 0,
                bytes: 0,
                skipped: Vec::new(),
                state: ScanState::Running,
            }),
            "ScanDonePayload": fields(&ScanDone {
                scan_id: String::new(),
                tree: ScanNode {
                    name: String::new(),
                    path: String::new(),
                    is_dir: true,
                    bytes: 0,
                    child_count: None,
                    children: None,
                    kinds: None,
                },
                skipped: Vec::new(),
                cancelled: false,
                truncated_at_depth: None,
                elapsed_ms: 0,
                entries: 0,
            }),
        },
        "enums": {
            "TextReadState": variants(&[
                TextReadState::Ok,
                TextReadState::TooLarge,
                TextReadState::Binary,
            ]),
            "ThumbnailPolicy": variants(&[ThumbnailPolicy::CacheOnly, ThumbnailPolicy::Extract]),
            "ThumbnailState": variants(&[
                ThumbnailState::Ready,
                ThumbnailState::CacheMiss,
                ThumbnailState::UnsupportedPlatform,
                ThumbnailState::UnsupportedType,
                ThumbnailState::Denied,
                ThumbnailState::Missing,
                ThumbnailState::Timeout,
                ThumbnailState::Cancelled,
                ThumbnailState::Error,
            ]),
            "FileOperationKind": variants(&[
                FileOperationKind::Copy,
                FileOperationKind::Move,
                FileOperationKind::Rename,
                FileOperationKind::Create,
                FileOperationKind::Delete,
            ]),
            "FileConflictPolicy": variants(&[
                FileConflictPolicy::Fail,
                FileConflictPolicy::Rename,
                FileConflictPolicy::Overwrite,
            ]),
            "FileOperationState": variants(&[
                FileOperationState::Queued,
                FileOperationState::Running,
                FileOperationState::Cancelling,
                FileOperationState::Completed,
                FileOperationState::PartialFailure,
                FileOperationState::Failed,
                FileOperationState::Cancelled,
            ]),
            "FileItemOutcome": variants(&[
                FileItemOutcome::Completed,
                FileItemOutcome::Renamed,
                FileItemOutcome::Skipped,
                FileItemOutcome::Failed,
                FileItemOutcome::Cancelled,
            ]),
            "FileFailureReason": variants(&[
                FileFailureReason::NotFound,
                FileFailureReason::Denied,
                FileFailureReason::Exists,
                FileFailureReason::ReadOnly,
                FileFailureReason::DiskFull,
                FileFailureReason::CancelledByShell,
                FileFailureReason::Unsupported,
                FileFailureReason::Other,
            ]),
            "ScanState": variants(&[
                ScanState::Queued,
                ScanState::Running,
                ScanState::Completed,
                ScanState::Cancelled,
                ScanState::Failed,
            ]),
            "ScanSkipReason": variants(&[
                ScanSkipReason::NotFound,
                ScanSkipReason::Denied,
                ScanSkipReason::InvalidArgument,
                ScanSkipReason::ReadFailed,
                ScanSkipReason::BudgetExceeded,
                ScanSkipReason::TooDeep,
                ScanSkipReason::SymlinkSkipped,
                ScanSkipReason::NotADirectory,
            ]),
            "FileKind": variants(&[
                FileKind::Directory,
                FileKind::Text,
                FileKind::Code,
                FileKind::Markdown,
                FileKind::Image,
                FileKind::Vector,
                FileKind::Video,
                FileKind::Audio,
                FileKind::Container,
                FileKind::Pdf,
                FileKind::Archive,
                FileKind::Document,
                FileKind::Sheet,
                FileKind::Presentation,
                FileKind::Font,
                FileKind::Executable,
                FileKind::Model,
                FileKind::Unknown,
            ]),
        },
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}

