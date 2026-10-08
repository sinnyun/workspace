// SDK pure-function unit tests (roadmap P3-2/P3-4). Run with `node --test`
// (Node strips the SDK's TS types natively; no test framework dependency).
import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesPermission,
  slotPrefix,
  validateManifest,
  disposer,
  errorMessage,
  Events,
  Capabilities,
  FrontendCapabilities,
  BASE_SLOT_IDS,
} from "../src/index.ts";

test("matchesPermission: exact, prefix and wildcard", () => {
  assert.equal(matchesPermission("fs.list", ["fs.list"]), true);
  assert.equal(matchesPermission("fs.stat", ["fs.list"]), false);
  assert.equal(matchesPermission("db.history.list", ["db.history.*"]), true);
  assert.equal(matchesPermission("db.history", ["db.history.*"]), false);
  assert.equal(matchesPermission("db.history2.list", ["db.history.*"]), false);
  assert.equal(matchesPermission("anything.at.all", ["*"]), true);
  assert.equal(matchesPermission("fs.list", []), false);
});

test("matchesPermission: slot id patterns (colon instance suffix)", () => {
  assert.equal(matchesPermission("pane-slot:2", ["pane-slot:*"]), true);
  assert.equal(matchesPermission("pane-slot", ["pane-slot:*"]), false);
  assert.equal(matchesPermission("detail-tab:history", ["detail-tab:*"]), true);
  assert.equal(matchesPermission("nav-zone", ["nav-zone"]), true);
});

test("slotPrefix splits the instance suffix off a nested slot id", () => {
  assert.equal(slotPrefix("pane-slot:2"), "pane-slot");
  assert.equal(slotPrefix("detail-tab:history"), "detail-tab");
  assert.equal(slotPrefix("nav-zone"), "nav-zone");
});

test("validateManifest accepts a minimal valid manifest", () => {
  const err = validateManifest({
    schemaVersion: 1,
    name: "p",
    version: "1.0.0",
    frontend: { entry: "frontend/dist/index.js" },
    permissions: { capabilities: [], events: { subscribe: [], emit: [] } },
  });
  assert.equal(err, null);
});

test("validateManifest accepts the v1 additive slot fields", () => {
  assert.equal(
    validateManifest({
      schemaVersion: 1,
      name: "container",
      version: "1.0.0",
      frontend: {
        entry: "frontend/dist/index.js",
        slots: [{ id: "main-view-zone", export: "Panes" }],
        provides: ["pane-slot"],
      },
      permissions: {
        capabilities: [],
        events: { subscribe: ["slot:registered"], emit: ["slot:reconfigured"] },
        slots: { contribute: ["main-view-zone"] },
      },
    }),
    null,
  );
});

test("validateManifest treats a slot label as optional metadata", () => {
  assert.equal(
    validateManifest({
      schemaVersion: 1,
      name: "labeled",
      version: "1.0.0",
      frontend: {
        entry: "frontend/dist/index.js",
        slots: [{ id: "detail-tab:history", export: "HistoryPanel", label: "版本" }],
      },
      permissions: {
        capabilities: [],
        events: { subscribe: [], emit: [] },
        slots: { contribute: ["detail-tab:history"] },
      },
    }),
    null,
  );
  const base = {
    name: "p",
    version: "1.0.0",
    permissions: { capabilities: [], events: { subscribe: [], emit: [] } },
  };
  assert.match(
    validateManifest({
      ...base,
      schemaVersion: 1,
      frontend: { entry: "x.js", slots: [{ id: "detail-tab:x", export: "C", label: "  " }] },
    }),
    /empty label/,
  );
});

test("validateManifest rejects drift the type system cannot catch", () => {
  const base = {
    name: "p",
    version: "1.0.0",
    permissions: { capabilities: [], events: { subscribe: [], emit: [] } },
  };
  assert.match(
    validateManifest({ ...base, schemaVersion: 2 }),
    /unsupported schemaVersion/,
  );
  assert.match(validateManifest({ ...base, schemaVersion: 1, name: "  " }), /name/);
  assert.match(validateManifest({ ...base, schemaVersion: 1, version: "" }), /version/);
  assert.match(validateManifest({ ...base, schemaVersion: 1 }), /neither backend nor frontend/);
  assert.match(
    validateManifest({
      ...base,
      schemaVersion: 1,
      frontend: { entry: "x.js", slots: [{ id: "", export: "C" }] },
    }),
    /empty id\/export/,
  );
  assert.match(
    validateManifest({
      ...base,
      schemaVersion: 1,
      frontend: { entry: "x.js", provides: ["  "] },
    }),
    /provides .* empty prefix/,
  );
  assert.match(
    validateManifest({
      ...base,
      schemaVersion: 1,
      frontend: { entry: "x.js" },
      permissions: {
        capabilities: [],
        events: { subscribe: [], emit: [] },
        slots: { contribute: [""] },
      },
    }),
    /slots\.contribute .* empty entry/,
  );
});

test("disposer runs teardowns in reverse and swallows throws", () => {
  const order = [];
  const d = disposer(
    () => order.push("a"),
    () => {
      throw new Error("boom");
    },
    () => order.push("c"),
  );
  assert.doesNotThrow(d);
  assert.deepEqual(order, ["c", "a"]);
});

test("well-known names are stable string literals", () => {
  assert.equal(Events.fileChanged, "file:changed");
  assert.equal(Events.historyUpdated, "history:updated");
  assert.equal(Events.tabActivated, "tab:activated");
  assert.equal(Events.sidebarSelectionChanged, "sidebar:selection:changed");
  assert.equal(Events.focusChanged, "focus:changed");
  assert.equal(Events.slotDisposed, "slot:disposed");
  assert.equal(Capabilities.fsList, "fs.list");
  assert.equal(Capabilities.thumbImage, "thumb.image");
  assert.equal(Capabilities.watchSubscribe, "watch.subscribe");
});

test("BASE_SLOT_IDS is the outer-region grid the loader validates against", () => {
  assert.deepEqual([...BASE_SLOT_IDS].sort(), [
    "activity-rail-zone",
    "bottom-drawer",
    "command-palette",
    "file-sidebar-zone",
    "main-view-zone",
    "nav-zone",
    "statusbar-zone",
    "topbar-zone",
  ].sort());
});

test("errorMessage: provider text reaches the UI without the Error: class prefix", () => {
  assert.equal(errorMessage(new Error("模拟读取失败")), "模拟读取失败");
  assert.equal(errorMessage("直接字符串"), "直接字符串");
  assert.equal(errorMessage(undefined), "undefined");
});

test("frontend base capabilities stay out of the Rust capability set", () => {
  assert.equal(FrontendCapabilities.pluginsList, "plugins.list");
  assert.equal(FrontendCapabilities.pluginsSetEnabled, "plugins.setEnabled");
  // `contract:check` compares `Capabilities` against the Rust dump 1:1, so a
  // base-served name must never be added to that const.
  const kernel = Object.values(Capabilities);
  for (const name of Object.values(FrontendCapabilities)) {
    assert.equal(kernel.includes(name), false, `${name} must not be a kernel capability`);
  }
  // Permission patterns work the same way, so a plugin can whitelist the pair.
  assert.equal(matchesPermission("plugins.list", ["plugins.*"]), true);
  assert.equal(matchesPermission("plugins.list", ["plugins.list"]), true);
  assert.equal(matchesPermission("plugins.list", ["fs.list"]), false);
});
