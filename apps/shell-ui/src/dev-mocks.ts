/**
 * Browser-dev mocks. When the shell runs under plain `vite dev` (no Tauri),
 * capability invokes would otherwise reject. These in-memory mocks let the UI
 * and plugin loading be exercised headless. Inside Tauri the real commands win
 * (invokeCapability tries Tauri first and only falls back to a mock on throw).
 */
import { registerMock } from "./invoke";
import type { ListEntry, PluginManifest, StatOut } from "@my-file-manager/plugin-sdk";
import fileHistoryManifest from "../../../plugins/plugin-file-history/manifest.json";

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

export function registerMocks(): void {
  registerMock("fs.home", () => "/demo");

  registerMock("fs.list", (args) => {
    const path = String(args.path ?? "/demo");
    return fakeTree[path] ?? [];
  });

  registerMock("fs.stat", (args): StatOut => {
    const path = String(args.path ?? "");
    const ent = Object.values(fakeTree)
      .flat()
      .find((e) => e.path === path);
    return {
      path,
      isDir: ent?.isDir ?? false,
      size: ent?.size ?? 0,
      modifiedMs: Date.now(),
    };
  });

  registerMock("fs.readText", (args) => `mock content of ${String(args.path ?? "")}`);

  registerMock("hash.compute", (args) =>
    `mockhash-${String(args.path ?? "").length}-${String(args.algo ?? "blake3")}`,
  );

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

  // Browser-dev plugin index: serve the built file-history frontend over the
  // vite `/dev-plugins` route so the real runtime-ESM loading path is exercised
  // without Tauri. Inside Tauri the real `plugins_list_frontend` command wins.
  const devPlugins = [
    {
      ...(fileHistoryManifest as unknown as PluginManifest),
      frontend: {
        ...(fileHistoryManifest as unknown as PluginManifest).frontend,
        entry: "/dev-plugins/plugin-file-history/index.js",
      },
    },
  ];
  registerMock("plugins_list_frontend", () => devPlugins);
}
