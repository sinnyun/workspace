//! Manifest schema validation (roadmap P3-2): the shipped plugin manifest must
//! parse into the typed contract and pass semantic validation, and malformed
//! manifests must be rejected.

use fm_contracts::PluginManifest;

fn manifest_path() -> String {
    concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../plugins/plugin-file-history/manifest.json"
    )
    .to_owned()
}

#[test]
fn bundled_manifest_parses_and_validates() {
    let text = std::fs::read_to_string(manifest_path()).expect("shipped manifest must exist");
    let m: PluginManifest = serde_json::from_str(&text).expect("manifest must match the schema");
    m.validate().expect("manifest must pass semantic validation");

    assert_eq!(m.name, "plugin-file-history");
    let fe = m.frontend.expect("file-history ships a frontend");
    assert_eq!(fe.entry, "frontend/dist/index.js");
    let slots = fe.slots.expect("declares slots");
    assert_eq!(slots[0].id, "detail-tab:history");
    assert_eq!(slots[0].export, "HistoryPanel");
    assert!(m.permissions.capabilities.contains(&"db.history.*".to_owned()));
}

#[test]
fn rejects_unsupported_schema_version() {
    let m: PluginManifest = serde_json::from_str(
        r#"{"schemaVersion":2,"name":"x","version":"1.0.0","permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]}}}"#,
    )
    .unwrap();
    assert!(m.validate().is_err());
}

#[test]
fn rejects_manifest_without_backend_or_frontend() {
    let m: PluginManifest = serde_json::from_str(
        r#"{"schemaVersion":1,"name":"x","version":"1.0.0","permissions":{"capabilities":[],"events":{"subscribe":[],"emit":[]}}}"#,
    )
    .unwrap();
    assert!(m.validate().is_err());
}

#[test]
fn rejects_missing_permissions_at_parse() {
    let err = serde_json::from_str::<PluginManifest>(
        r#"{"schemaVersion":1,"name":"x","version":"1.0.0"}"#,
    );
    assert!(err.is_err());
}
