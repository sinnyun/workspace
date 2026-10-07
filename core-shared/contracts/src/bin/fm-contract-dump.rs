//! Prints the cross-language contract as JSON on stdout:
//!   { "events": { "<name>": [argFields...] },
//!     "capabilities": ["<domain.action>..."],
//!     "dtos": { "<Type>": [serdeFieldNames...] } }
//!
//! Consumed by `apps/shell-ui/scripts/contract-check.mjs`, which asserts the
//! TypeScript SDK mirrors these names and fields exactly (roadmap P3-3).
//! Field names come from serde itself, so a rename drift fails the check.

use fm_contracts::capability::names;
use fm_contracts::{
    FileChanged, FileChangedArgs, HistoryUpdated, HistoryUpdatedArgs, ListEntry, StatOut,
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

fn main() {
    let out = json!({
        "events": {
            FileChanged::NAME: fields(&FileChangedArgs { path: String::new(), kind: String::new() }),
            HistoryUpdated::NAME: fields(&HistoryUpdatedArgs { path: String::new() }),
        },
        "capabilities": [
            names::FS_HOME,
            names::FS_LIST,
            names::FS_STAT,
            names::FS_READ_CHUNK,
            names::FS_READ_TEXT,
            names::HASH_COMPUTE,
            names::WATCH_SUBSCRIBE,
        ],
        "dtos": {
            "ListEntry": fields(&ListEntry {
                name: String::new(),
                path: String::new(),
                is_dir: false,
                size: None,
            }),
            "StatOut": fields(&StatOut {
                path: String::new(),
                is_dir: false,
                size: 0,
                modified_ms: None,
            }),
        },
    });
    println!("{}", serde_json::to_string_pretty(&out).unwrap());
}
