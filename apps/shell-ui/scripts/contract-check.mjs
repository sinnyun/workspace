// TS <-> Rust contract guard (roadmap P3-3).
//
// The Rust side is authoritative at runtime, so this script asks Rust for the
// truth (`cargo run -p fm-contracts --bin fm-contract-dump`, which serializes
// real values through serde) and asserts the TypeScript SDK mirrors it:
//   - event names            (SDK `Events`        vs cordis `Event::NAME`)
//   - event payload fields   (SDK `*Args` ifaces  vs serde field names)
//   - capability names       (SDK `Capabilities`  vs `capability::names`)
//   - DTO field names        (SDK `ListEntry`/`StatOut` ifaces vs serde)
// Any drift on either side fails the check. Exits non-zero on mismatch.
//
// Run: node scripts/contract-check.mjs   (wired as `pnpm --filter shell-ui contract:check`)
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../.."); // workspace root
const sdkTs = resolve(root, "core-shared/plugin-sdk/src/index.ts");

// Events the frontend owns alone (base meta-state + nested slots); Rust has no
// counterpart, so these are excluded from the cross-language check (docs/02 §7.1).
const FRONTEND_ONLY_EVENTS = new Set([
  "selection:changed",
  "tab:activated",
  "sidebar:view:changed",
  "sidebar:selection:changed",
  "focus:changed",
  "detail:tab:changed",
  "slot:registered",
  "slot:reconfigured",
  "slot:disposed",
]);

function dumpRust() {
  const r = spawnSync("cargo", ["run", "-q", "-p", "fm-contracts", "--bin", "fm-contract-dump"], {
    cwd: root,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    console.error("cargo fm-contract-dump failed:\n" + (r.stderr || r.stdout));
    process.exit(2);
  }
  return JSON.parse(r.stdout);
}

/** Parse `export const Name = { key: "value", ... } as const;` from SDK source. */
function parseConstObject(src, name) {
  const m = src.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\} as const;`));
  if (!m) throw new Error(`cannot find \`export const ${name}\` in SDK`);
  const out = {};
  for (const pair of m[1].matchAll(/(\w+):\s*"([^"]+)"/g)) out[pair[1]] = pair[2];
  return out;
}

/** Parse `export interface Name { field: type; ... }` field names from SDK source. */
function parseInterfaceFields(src, name) {
  const m = src.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  if (!m) throw new Error(`cannot find \`export interface ${name}\` in SDK`);
  const fields = [];
  for (const line of m[1].split("\n")) {
    const f = line.match(/^\s*(\w+)\??:/);
    if (f) fields.push(f[1]);
  }
  return fields;
}

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const sorted = (a) => [...a].sort();

const failures = [];
function check(label, rust, ts) {
  if (eq(sorted(rust), sorted(ts))) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}\n         rust: ${JSON.stringify(sorted(rust))}\n         ts:   ${JSON.stringify(sorted(ts))}`);
  }
}

const rust = dumpRust();
const src = readFileSync(sdkTs, "utf8");

const sdkEvents = Object.values(parseConstObject(src, "Events"));
const sdkCaps = Object.values(parseConstObject(src, "Capabilities"));

console.log("contract check: TS SDK <-> fm-contracts (Rust)");
check("event names", Object.keys(rust.events), sdkEvents.filter((e) => !FRONTEND_ONLY_EVENTS.has(e)));
for (const [name, fields] of Object.entries(rust.events)) {
  const iface = name === "file:changed" ? "FileChangedArgs" : "HistoryUpdatedArgs";
  check(`event args ${name}`, fields, parseInterfaceFields(src, iface));
}
check("capability names", rust.capabilities, sdkCaps);
for (const [dto, fields] of Object.entries(rust.dtos)) {
  check(`dto fields ${dto}`, fields, parseInterfaceFields(src, dto));
}

if (failures.length > 0) {
  console.error(`\ncontract drift in: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("contract OK");
