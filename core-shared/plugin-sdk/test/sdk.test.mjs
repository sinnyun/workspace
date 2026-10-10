// SDK pure-function unit tests (roadmap P3-2/P3-4). Run with `node --test`
// (Node strips the SDK's TS types natively; no test framework dependency).

import assert from "node:assert/strict";
import test from "node:test";
import {
  BASE_SLOT_IDS,
  Capabilities,
  disposer,
  Events,
  errorMessage,
  FrontendCapabilities,
  formatClock,
  formatDate,
  formatDateTime,
  formatSize,
  matchesPermission,
  SEARCH_MAX_PAGE,
  SEARCH_MAX_TEXT_CHARS,
  SEARCH_PROGRESS_INTERVAL_MS,
  SEARCH_TRIGRAM_MIN_CHARS,
  slotPrefix,
  validateManifest,
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
  assert.match(validateManifest({ ...base, schemaVersion: 2 }), /unsupported schemaVersion/);
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
  assert.equal(Capabilities.shellThumbnailRead, "shell.thumbnail.read");
  assert.equal(Capabilities.watchSubscribe, "watch.subscribe");
  // `thumb.image` and the app-side `image` decode path were removed with P7-15:
  // thumbnails come from the Windows Shell only, so nothing may reintroduce it.
  assert.equal("thumbImage" in Capabilities, false);
});

test("search contract: names, bounds and the folded result event", () => {
  assert.equal(Capabilities.searchQuery, "search.query");
  assert.equal(Capabilities.searchStatus, "search.status");
  assert.equal(Capabilities.searchIndexStart, "search.index.start");
  assert.equal(Capabilities.searchIndexCancel, "search.index.cancel");
  assert.equal(Events.searchIndexProgress, "search:index-progress");
  assert.equal(Events.searchIndexDone, "search:index-done");
  // Bounds are part of the contract, not per-plugin opinion (D24).
  assert.equal(SEARCH_MAX_TEXT_CHARS, 128);
  assert.equal(SEARCH_MAX_PAGE, 200);
  assert.equal(SEARCH_TRIGRAM_MIN_CHARS, 3);
  assert.equal(SEARCH_PROGRESS_INTERVAL_MS, 120);
  // Results ride on the paged `search.query` reply; a broadcast event would let
  // every open pane re-render on an unrelated index.
  assert.equal(
    Object.values(Events).some((name) => name.startsWith("search:results")),
    false,
  );
});

test("BASE_SLOT_IDS is the outer-region grid the loader validates against", () => {
  assert.deepEqual(
    [...BASE_SLOT_IDS].sort(),
    [
      "activity-rail-zone",
      "bottom-drawer",
      "command-palette",
      "file-sidebar-zone",
      "main-view-zone",
      "nav-zone",
      "statusbar-zone",
      "topbar-zone",
    ].sort(),
  );
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

test("formatSize: one unit scale for the whole app, no second implementation", () => {
  assert.equal(formatSize(0), "0 B");
  assert.equal(formatSize(96), "96 B");
  assert.equal(formatSize(900), "900 B");
  assert.equal(formatSize(1024), "1 KiB");
  assert.equal(formatSize(3482), "3.4 KiB");
  assert.equal(formatSize(81 * 1024 * 1024), "81 MiB");
  // unrepresentable input never reaches the UI as NaN
  assert.equal(formatSize(null), "—");
  assert.equal(formatSize(undefined), "—");
  assert.equal(formatSize(-1), "—");
  assert.equal(formatSize(Number.NaN), "—");
});

test("date formatters: fixed shapes, placeholder instead of Invalid Date", () => {
  const at = new Date(2026, 9, 7, 8, 5, 3).getTime();
  assert.equal(formatDate(at), "2026-10-07");
  assert.equal(formatDateTime(at), "2026-10-07 08:05");
  assert.equal(formatClock(at), "08:05:03");
  // dense columns stay blank; sparse panels show the placeholder
  assert.equal(formatDate(null), "");
  assert.equal(formatDate(null, "—"), "—");
  assert.equal(formatDateTime(null), "—");
  assert.equal(formatDateTime(Number.NaN), "—");
  assert.equal(formatDateTime(0), "—");
  assert.equal(formatClock(undefined), "—");
});
