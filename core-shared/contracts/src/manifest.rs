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
    /// Nested-slot prefixes a CONTAINER plugin provides (docs/02 §4.5).
    /// Absent for ordinary plugins; the frontend enforces the provide gate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provides: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotDecl {
    pub id: String,
    pub export: String,
    /// Display label a container should show for this slot (e.g. a tab title).
    /// Optional: ordinary manifests omit it and the container falls back to the
    /// slot id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Permissions {
    #[serde(default)]
    pub capabilities: Vec<String>,
    pub events: EventPermissions,
    /// Slot-injection whitelist (docs/02 §2.2). Optional: v1 manifests written
    /// before nested slots existed simply omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub slots: Option<SlotPermissions>,
    /// Context-menu grants (docs/plugin-functional/plugin-context-menu.md).
    /// Optional; absent means the plugin gets no `host.contextMenu` face at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_menu: Option<ContextMenuPermissions>,
    /// Command grants (docs/04 P7-30). Optional; absent means the plugin gets
    /// no `host.commands` face at all.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commands: Option<CommandPermissions>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandPermissions {
    /// May publish commands (their `run` executes as this plugin) and declare
    /// shortcuts the base dispatches.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub register: Option<bool>,
    /// May claim the command palette itself. The base serves exactly one provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provide: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextMenuPermissions {
    /// Surface ids this plugin may ask the panel to open for.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub open: Option<Vec<String>>,
    /// May register menu items whose `execute` runs as this plugin.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contribute: Option<bool>,
    /// May claim the panel itself. The base serves exactly one provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provide: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlotPermissions {
    /// Slot ids or `prefix:*` patterns this plugin may inject into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contribute: Option<Vec<String>>,
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
                    return Err(format!(
                        "slot in plugin `{}` has empty id/export",
                        self.name
                    ));
                }
                if slot.label.as_deref().is_some_and(|l| l.trim().is_empty()) {
                    return Err(format!("slot in plugin `{}` has empty label", self.name));
                }
            }
            for prefix in fe.provides.iter().flatten() {
                if prefix.trim().is_empty() {
                    return Err(format!(
                        "provides in plugin `{}` has empty prefix",
                        self.name
                    ));
                }
            }
        }
        if let Some(slots) = self.permissions.slots.as_ref() {
            for pattern in slots.contribute.iter().flatten() {
                if pattern.trim().is_empty() {
                    return Err(format!(
                        "permissions.slots.contribute in plugin `{}` has empty entry",
                        self.name
                    ));
                }
            }
        }
        if let Some(cm) = self.permissions.context_menu.as_ref() {
            for surface in cm.open.iter().flatten() {
                if surface.trim().is_empty() {
                    return Err(format!(
                        "permissions.contextMenu.open in plugin `{}` has empty entry",
                        self.name
                    ));
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The nested-slot fields are a v1-compatible ADDITION: old manifests that
    /// omit them must still parse, and the host must forward them to the frontend
    /// loader (which enforces the provide/contribute gates) when present.
    #[test]
    fn slot_fields_are_optional_and_round_trip() {
        let old: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"p","version":"1.0.0",
                "frontend":{"entry":"e.js","slots":[{"id":"nav-zone","export":"C"}]},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]}}}"#,
        )
        .unwrap();
        assert_eq!(old.frontend.as_ref().unwrap().provides, None);
        assert_eq!(old.permissions.slots, None);
        assert!(old.validate().is_ok());

        let container: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"plugin-layout-panes","version":"1.0.0",
                "frontend":{"entry":"e.js","slots":[{"id":"main-view-zone","export":"P"}],
                            "provides":["pane-slot"]},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":["slot:reconfigured"]},
                               "slots":{"contribute":["main-view-zone","pane-slot:*"]}}}"#,
        )
        .unwrap();
        assert_eq!(container.validate(), Ok(()));
        let json = serde_json::to_value(&container).unwrap();
        assert_eq!(json["frontend"]["provides"][0], "pane-slot");
        assert_eq!(json["permissions"]["slots"]["contribute"][1], "pane-slot:*");
        assert_eq!(
            json["frontend"]["slots"][0]["label"],
            serde_json::Value::Null,
            "an absent label must not appear in the serialized manifest"
        );

        let labeled: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"plugin-file-history","version":"1.0.0",
                "frontend":{"entry":"e.js","slots":[
                    {"id":"detail-tab:history","export":"HistoryPanel","label":"版本"}]},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]},
                               "slots":{"contribute":["detail-tab:history"]}}}"#,
        )
        .unwrap();
        assert_eq!(
            labeled.frontend.as_ref().unwrap().slots.as_ref().unwrap()[0]
                .label
                .as_deref(),
            Some("版本")
        );
        assert_eq!(labeled.validate(), Ok(()));
    }

    /// `permissions.contextMenu` is an addition: absent means no menu face at all,
    /// and a blank surface id is refused on both sides of the bridge.
    #[test]
    fn context_menu_grants_round_trip_and_validate() {
        let m: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"plugin-context-menu","version":"1.0.0",
                "frontend":{"entry":"e.js","slots":[{"id":"main-view-zone","export":"C"}]},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]},
                               "contextMenu":{"open":["browser.list.item"],"contribute":true,"provide":true}}}"#,
        )
        .unwrap();
        assert_eq!(m.validate(), Ok(()));
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(
            json["permissions"]["contextMenu"]["open"][0],
            "browser.list.item"
        );
        assert_eq!(
            json["permissions"]["contextMenu"]["provide"],
            serde_json::Value::Bool(true)
        );

        let plain: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"p","version":"1.0.0",
                "frontend":{"entry":"e.js"},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]}}}"#,
        )
        .unwrap();
        assert_eq!(plain.permissions.context_menu, None);
        assert_eq!(
            serde_json::to_value(&plain).unwrap()["permissions"].get("contextMenu"),
            None,
            "an absent grant must not appear in the serialized manifest"
        );

        let bad: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"p","version":"1.0.0",
                "frontend":{"entry":"e.js"},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]},
                               "contextMenu":{"open":[""]}}}"#,
        )
        .unwrap();
        assert!(bad.validate().unwrap_err().contains("contextMenu.open"));
    }

    /// `permissions.commands` is an addition on the same pattern: absent means
    /// no command face at all, and the flags must survive the bridge verbatim.
    #[test]
    fn command_grants_round_trip() {
        let m: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"plugin-command-palette","version":"1.0.0",
                "frontend":{"entry":"e.js","slots":[{"id":"command-palette","export":"C"}]},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]},
                               "commands":{"register":true,"provide":true}}}"#,
        )
        .unwrap();
        assert_eq!(m.validate(), Ok(()));
        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(
            json["permissions"]["commands"]["register"],
            serde_json::Value::Bool(true)
        );
        assert_eq!(
            json["permissions"]["commands"]["provide"],
            serde_json::Value::Bool(true)
        );

        let plain: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"p","version":"1.0.0",
                "frontend":{"entry":"e.js"},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]}}}"#,
        )
        .unwrap();
        assert_eq!(plain.permissions.commands, None);
        assert_eq!(
            serde_json::to_value(&plain).unwrap()["permissions"].get("commands"),
            None,
            "an absent grant must not appear in the serialized manifest"
        );
    }

    #[test]
    fn empty_slot_entries_are_rejected() {
        let m: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"p","version":"1.0.0",
                "frontend":{"entry":"e.js","provides":["  "]},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]}}}"#,
        )
        .unwrap();
        assert!(m.validate().unwrap_err().contains("empty prefix"));

        let m: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"p","version":"1.0.0",
                "frontend":{"entry":"e.js"},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]},
                               "slots":{"contribute":[""]}}}"#,
        )
        .unwrap();
        assert!(m.validate().unwrap_err().contains("slots.contribute"));

        let m: PluginManifest = serde_json::from_str(
            r#"{"schemaVersion":1,"name":"p","version":"1.0.0",
                "frontend":{"entry":"e.js","slots":[
                    {"id":"detail-tab:x","export":"C","label":"   "}]},
                "permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]}}}"#,
        )
        .unwrap();
        assert!(m.validate().unwrap_err().contains("empty label"));
    }
}
