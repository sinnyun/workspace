import { useCallback, useEffect, useState } from "react";
import type { PluginHost } from "@my-file-manager/plugin-sdk";
import { bus } from "./eventbus";
import { metaSnapshot, useMeta } from "./state";
import { slotRegistry } from "./slots";
import { invokeCapability } from "./invoke";
import { PluginSlot } from "./PluginSlot";
import type { ListEntry } from "@my-file-manager/plugin-sdk";

/** A host object for base-owned UI (the file browser). The base is not a plugin,
 *  but reusing the same surface keeps capability access uniform. It is ungated
 *  (no manifest) because it is the trusted base itself. */
const baseHost: PluginHost = {
  registerSlot: (id, c) => slotRegistry.register("base", id, c),
  on: (e, h) => bus.on(e, h as (p: unknown) => void),
  emit: (e, p) => bus.emit(e, p),
  invoke: (c, a) => invokeCapability(c, a),
  getState: () => metaSnapshot(),
  onStateChange: (cb) =>
    useMeta.subscribe((s) => cb({ currentFileId: s.currentFileId })),
};

export function App() {
  const [cwd, setCwd] = useState<string>("");
  const [entries, setEntries] = useState<ListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const currentFileId = useMeta((s) => s.currentFileId);
  const setCurrentFile = useMeta((s) => s.setCurrentFile);
  const [, force] = useState(0);

  useEffect(() => slotRegistry.subscribe(() => force((n) => n + 1)), []);

  const open = useCallback(async (dir: string) => {
    setError(null);
    try {
      const list = await invokeCapability<ListEntry[]>("fs.list", { path: dir });
      list.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
      setEntries(list);
      setCwd(dir);
    } catch (err) {
      setError(String(err));
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    // Seed with the home directory if the host exposes it; otherwise stay empty.
    invokeCapability<string>("fs.home")
      .then(open)
      .catch(() => setError("Enter a directory path above and press Open."));
  }, [open]);

  const onNavigate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const p = String(data.get("path") ?? "").trim();
    if (p) void open(p);
  };

  const up = () => {
    if (!cwd) return;
    const idx = Math.max(cwd.lastIndexOf("/"), cwd.lastIndexOf("\\"));
    if (idx > 0) void open(cwd.slice(0, idx));
  };

  return (
    <div style={{ display: "flex", height: "100vh", flexDirection: "column" }}>
      <TopBar />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        <nav
          style={{
            width: 220,
            borderRight: "1px solid var(--mantine-color-default-border)",
            padding: 8,
            overflow: "auto",
          }}
        >
          <PluginSlot slotId="nav-zone" slotProps={{ host: baseHost }} />
        </nav>

        <main style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <form
            onSubmit={onNavigate}
            style={{ display: "flex", gap: 8, padding: 8, alignItems: "center" }}
          >
            <button type="button" onClick={up} disabled={!cwd} title="Up">
              ↑
            </button>
            <input
              name="path"
              defaultValue={cwd}
              placeholder="/path/to/dir"
              style={{ flex: 1, padding: "4px 8px" }}
            />
            <button type="submit">Open</button>
          </form>

          {error && (
            <div style={{ padding: "0 12px", color: "var(--mantine-color-red-6)" }}>
              {error}
            </div>
          )}

          <div style={{ flex: 1, overflow: "auto", padding: "0 8px 8px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {entries.map((ent) => (
                  <tr
                    key={ent.path}
                    onClick={() => {
                      if (ent.isDir) void open(ent.path);
                      else setCurrentFile(ent.path);
                    }}
                    style={{
                      cursor: "pointer",
                      background:
                        ent.path === currentFileId
                          ? "var(--mantine-color-blue-light)"
                          : undefined,
                    }}
                  >
                    <td style={{ padding: "3px 6px" }}>{ent.isDir ? "📁" : "📄"}</td>
                    <td style={{ padding: "3px 6px" }}>{ent.name}</td>
                    <td
                      style={{
                        padding: "3px 6px",
                        textAlign: "right",
                        color: "var(--mantine-color-dimmed)",
                      }}
                    >
                      {ent.isDir ? "" : formatSize(ent.size ?? 0)}
                    </td>
                  </tr>
                ))}
                {entries.length === 0 && !error && (
                  <tr>
                    <td style={{ padding: 12, color: "var(--mantine-color-dimmed)" }}>
                      (empty)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </main>

        <aside
          style={{
            width: 300,
            borderLeft: "1px solid var(--mantine-color-default-border)",
            padding: 8,
            overflow: "auto",
          }}
        >
          <PluginSlot slotId="file-sidebar-zone" slotProps={{ host: baseHost }} />
        </aside>
      </div>

      <BottomDrawer open={drawerOpen} onToggle={() => setDrawerOpen((o) => !o)} />

      <StatusBar currentFileId={currentFileId} count={entries.length} />
    </div>
  );
}

function TopBar() {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "6px 12px",
        borderBottom: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <strong>My File Manager</strong>
      <PluginSlot slotId="topbar-zone" slotProps={{ host: baseHost }} />
    </header>
  );
}

function BottomDrawer({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        height: open ? 260 : 28,
        minHeight: 28,
        borderTop: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          height: 28,
          padding: "0 12px",
          fontSize: 12,
          color: "var(--mantine-color-dimmed)",
          cursor: "pointer",
          flexShrink: 0,
        }}
        onClick={onToggle}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>调试抽屉</span>
      </div>
      {open && (
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "0 8px 8px" }}>
          <PluginSlot slotId="bottom-drawer" slotProps={{ host: baseHost }} />
        </div>
      )}
    </section>
  );
}

function StatusBar({
  currentFileId,
  count,
}: {
  currentFileId: string | null;
  count: number;
}) {
  return (
    <footer
      style={{
        display: "flex",
        gap: 16,
        padding: "4px 12px",
        borderTop: "1px solid var(--mantine-color-default-border)",
        fontSize: 12,
        color: "var(--mantine-color-dimmed)",
      }}
    >
      <span>{count} items</span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {currentFileId ?? "no selection"}
      </span>
    </footer>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}
