// SDK pure-function unit tests (roadmap P3-2/P3-4). Run with `node --test`
// (Node strips the SDK's TS types natively; no test framework dependency).
import test from "node:test";
import assert from "node:assert/strict";
import {
  matchesPermission,
  validateManifest,
  disposer,
  Events,
  Capabilities,
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
  assert.equal(Capabilities.fsList, "fs.list");
  assert.equal(Capabilities.watchSubscribe, "watch.subscribe");
});
