//! `manifest.json` schema (docs/02 §2), mirrored on the frontend by
//! `@my-file-manager/plugin-sdk`'s `PluginManifest` type. The host parses every
//! discovered manifest through this struct so a malformed plugin is rejected at
//! discovery time instead of failing later at load.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

/// Current manifest schema version the host accepts.
pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub schema_version: u32,
    pub name: String,
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_host_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<BackendSection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontend: Option<FrontendSection>,
    pub permissions: Permissions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendSection {
    #[serde(rename = "crate", skip_serializing_if = "Option::is_none")]
    pub crate_: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled_by_default: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<HashMap<String, serde_json::Value>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendSection {
    pub entry: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<Vec<SlotDecl>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotDecl {
    pub id: String,
    pub export: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub events: EventPermissions,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EventPermissions {
    #[serde(default)]
    pub subscribe: Vec<String>,
    #[serde(default)]
    pub emit: Vec<String>,
}

impl PluginManifest {
    /// Semantic checks serde cannot express. Returns the first violation.
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(format!(
                "unsupported schemaVersion {} (host accepts {SCHEMA_VERSION})",
                self.schema_version
            ));
        }
        if self.name.trim().is_empty() {
            return Err("name must be non-empty".into());
        }
        if self.version.trim().is_empty() {
            return Err("version must be non-empty".into());
        }
        if self.backend.is_none() && self.frontend.is_none() {
            return Err("manifest declares neither backend nor frontend".into());
        }
        if let Some(fe) = &self.frontend {
            if fe.entry.trim().is_empty() {
                return Err("frontend.entry must be non-empty".into());
            }
            for slot in fe.slots.iter().flatten() {
                if slot.id.trim().is_empty() || slot.export.trim().is_empty() {
                    return Err(format!("slot in plugin `{}` has empty id/export", self.name));
                }
            }
        }
        Ok(())
    }
}
