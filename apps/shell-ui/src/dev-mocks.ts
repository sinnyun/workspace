/**
 * Browser-dev mocks. When the shell runs under plain `vite dev` (no Tauri),
 * capability invokes would otherwise reject. These in-memory mocks let the UI
 * and plugin loading be exercised headless. Inside Tauri the real commands win
 * (invokeCapability tries Tauri first and only falls back to a mock on throw).
 */
import { registerMock } from "./invoke";
import type { ListEntry, PluginManifest, StatOut } from "@my-file-manager/plugin-sdk";

import fileHistoryManifest from "../../../plugins/plugin-file-history/manifest.json";
import devtoolsLogManifest from "../../../plugins/plugin-devtools-log/manifest.json";
import fileDetailsManifest from "../../../plugins/plugin-file-details/manifest.json";
import fileNavManifest from "../../../plugins/plugin-file-nav/manifest.json";
import mockDataManifest from "../../../plugins/plugin-mock-data/manifest.json";

const fakeTree: Record<string, ListEntry[]> = {
  "/demo": [
    { name: "notes.txt", path: "/demo/notes.txt", isDir: false, size: 1284 },
    { name: "report.md", path: "/demo/report.md", isDir: false, size: 5321 },
    { name: "src", path: "/demo/src", isDir: true, size: null },
  ],
  "/demo/src": [
    { name: "main.rs", path: "/demo/src/main.rs", isDir: false, size: 2048 },
    { name: "lib.rs", path: "/demo/src/lib.rs", isDir: false, size: 900 },
  ],
};

const EXTENSIONS = ["txt", "md", "rs", "json", "png", "csv", "log", "toml"];

/** Generate `n` synthetic entries with varied, unique paths for the stress view. */
function stressRows(n: number): ListEntry[] {
  const out: ListEntry[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const isDir = i % 17 === 0;
    const ext = EXTENSIONS[i % EXTENSIONS.length];
    out[i] = {
      name: isDir ? `folder_${i}` : `item_${i}.${ext}`,
      path: `/demo/stress/${i}`,
      isDir,
      size: isDir ? null : ((i * 2654435761) % 4_000_000) + 1,
    };
  }
  return out;
}

export function registerMocks(): void {
  registerMock("fs.home", () => "/demo");

  registerMock("fs.list", (args) => {
    const path = String(args.path ?? "/demo");
    if (path.startsWith("/demo/stress")) {
      // Support the stress region: /demo/stress?n=<count>, default 1000.
      const match = /[?&]n=(\d+)/.exec(path);
      return stressRows(match ? Number(match[1]) : 1000);
    }
    return fakeTree[path] ?? [];
  });

  registerMock("fs.stat", (args): StatOut => {
    const path = String(args.path ?? "");
    const ent = Object.values(fakeTree)
      .flat()
      .find((e) => e.path === path);
    const stressIdx = /^\/demo\/stress\/(\d+)$/.exec(path);
    const isDir = ent?.isDir ?? (stressIdx ? Number(stressIdx[1]) % 17 === 0 : false);
    const size =
      ent?.size ??
      (stressIdx ? (Number(stressIdx[1]) * 2654435761) % 4_000_000 + 1 : 0);
    return { path, isDir, size, modifiedMs: Date.now() };
  });

  registerMock("fs.readText", (args) => `mock content of ${String(args.path ?? "")}`);

  registerMock("hash.compute", (args) =>
    `mockhash-${String(args.path ?? "").length}-${String(args.algo ?? "blake3")}`,
  );

  // Dev-only data source for the mock-data stress plugin.
  registerMock("mock.stress", (args) => stressRows(Number(args.n ?? 1000)));

  // A tiny in-memory db.history store so the file-history panel has data in dev.
  const history: Record<string, Array<{ hash: string; at: number }>> = {
    "/demo/notes.txt": [
      { hash: "a1b2c3d4e5f60718", at: Date.parse("2026-10-01T09:12:00Z") },
      { hash: "9f8e7d6c5b4a3928", at: Date.parse("2026-10-03T15:40:00Z") },
    ],
  };
  registerMock("db.history.list", (args) => {
    const path = String(args.path ?? "");
    return history[path] ?? [];
  });
  registerMock("db.history.append", (args) => {
    const path = String(args.path ?? "");
    (history[path] ??= []).push({
      hash: String(args.hash ?? "x"),
      at: Number(args.at ?? Date.now()),
    });
    return { ok: true };
  });

  // Browser-dev plugin index: serve the built plugin frontends over the vite
  // `/dev-plugins` route so the real runtime-ESM loading path is exercised
  // without Tauri. Inside Tauri the real `plugins_list_frontend` command wins.
  // ORDER MATTERS: devtools-log loads FIRST so its global capture hooks (console
  // / window errors / PerformanceObserver) are installed before the others run.
  const devPlugins: PluginManifest[] = [
    devtoolsLogManifest,
    fileNavManifest,
    fileDetailsManifest,
    fileHistoryManifest,
    mockDataManifest,
  ].map((m) => {
    const manifest = m as unknown as PluginManifest;
    return {
      ...manifest,
      frontend: {
        ...manifest.frontend!,
        entry: `/dev-plugins/${manifest.name}/index.js`,
      },
    };
  });
  registerMock("plugins_list_frontend", () => devPlugins);
}
