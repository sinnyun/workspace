/**
 * `plugin-view-tags` — sidebar view (roadmap P6-48).
 *
 * Contributes an A icon and a `nav-panel:tags` panel (exclusion is
 * `plugin-layout-views`' job). Tags and their members are this plugin's own data in
 * localStorage; the base holds none.
 *
 * Cascade role both ways: clicking a tag publishes
 * `sidebar:selection:changed { kind: "tag" }` (B → C — a pane that understands tags
 * can react; `plugin-file-browser` deliberately ignores kinds it does not own, since
 * only plugins interpret `Ref.kind`), and clicking a member publishes
 * `focus:changed`, which is what drives region D.
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Events, type Ref, type SlotProps } from "@my-file-manager/plugin-sdk";

const VIEW_ID = "tags";
const PLUGIN_NAME = "plugin-view-tags";
const LS_KEY = "fm.view-tags.v1";

interface Member {
  path: string;
  kind: string;
}

type TagStore = Record<string, Member[]>;

const basename = (p: string): string => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 && idx < p.length - 1 ? p.slice(idx + 1) : p;
};

function load(): TagStore {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as TagStore) : {};
  } catch {
    return {};
  }
}

function save(store: TagStore): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
  } catch {
    // storage unavailable: tags simply are not remembered
  }
}

export function RailIcon({ host }: SlotProps) {
  const [active, setActive] = useState(host.getState().activeSidebarView);
  useEffect(() => host.onStateChange((s) => setActive(s.activeSidebarView)), [host]);
  return (
    <button
      type="button"
      title="标签"
      onClick={() => host.emit(Events.sidebarViewChanged, { viewId: VIEW_ID })}
      style={railButtonStyle(active === VIEW_ID)}
    >
      🏷
    </button>
  );
}

export function TagsPanel({ host }: SlotProps) {
  const [store, setStore] = useState<TagStore>(load);
  const [draft, setDraft] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState<Ref | null>(host.getState().focusRef);

  useEffect(() => host.onStateChange((s) => setFocus(s.focusRef)), [host]);

  const commit = (next: TagStore): void => {
    setStore(next);
    save(next);
  };

  const addTag = (): void => {
    const name = draft.trim();
    if (!name || store[name]) return;
    commit({ ...store, [name]: [] });
    setDraft("");
  };

  const tagFocus = (): void => {
    const name = open ?? Object.keys(store)[0];
    if (!name || !focus) return;
    const members = store[name] ?? [];
    if (members.some((m) => m.path === focus.id)) return;
    commit({ ...store, [name]: [...members, { path: focus.id, kind: focus.kind }] });
  };

  const removeMember = (tag: string, path: string): void =>
    commit({ ...store, [tag]: (store[tag] ?? []).filter((m) => m.path !== path) });

  const removeTag = (tag: string): void => {
    const next = { ...store };
    delete next[tag];
    commit(next);
    if (open === tag) setOpen(null);
  };

  const names = Object.keys(store);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <div style={headerStyle}>
        <span style={{ color: "var(--mantine-color-dimmed)" }}>标签</span>
      </div>

      <div style={{ display: "flex", gap: 4 }}>
        <input
          style={inputStyle}
          value={draft}
          placeholder="新标签名"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addTag()}
        />
        <button type="button" onClick={addTag} style={smallButtonStyle}>
          建
        </button>
      </div>

      {!names.length && <div style={{ color: "var(--mantine-color-dimmed)" }}>暂无标签</div>}

      {names.map((name) => (
        <div key={name}>
          <div style={rowStyle}>
            <button
              type="button"
              onClick={() => {
                setOpen(open === name ? null : name);
                host.emit(Events.sidebarSelectionChanged, {
                  kind: "tag",
                  id: name,
                  sourcePlugin: PLUGIN_NAME,
                } satisfies Ref);
              }}
              style={linkButtonStyle}
            >
              🏷 {name}
              <span style={{ color: "var(--mantine-color-dimmed)", marginLeft: 6 }}>
                {(store[name] ?? []).length}
              </span>
            </button>
            <button type="button" title="删除标签" onClick={() => removeTag(name)} style={smallButtonStyle}>
              ✕
            </button>
          </div>

          {open === name && (
            <div style={{ paddingLeft: 14 }}>
              <button type="button" onClick={tagFocus} disabled={!focus} style={smallButtonStyle}>
                ＋ 把焦点加入
              </button>
              {(store[name] ?? []).map((m) => (
                <div key={m.path} style={rowStyle}>
                  <button
                    type="button"
                    onClick={() =>
                      host.emit(Events.focusChanged, {
                        kind: m.kind,
                        id: m.path,
                        sourcePlugin: PLUGIN_NAME,
                      } satisfies Ref)
                    }
                    style={linkButtonStyle}
                  >
                    {m.kind === "folder" ? "📁" : "📄"} {basename(m.path)}
                  </button>
                  <button
                    type="button"
                    title="移出标签"
                    onClick={() => removeMember(name, m.path)}
                    style={smallButtonStyle}
                  >
                    ✕
                  </button>
                </div>
              ))}
              {!(store[name] ?? []).length && (
                <div style={{ color: "var(--mantine-color-dimmed)" }}>（标签为空）</div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const railButtonStyle = (active: boolean): CSSProperties => ({
  display: "block",
  width: 36,
  height: 36,
  margin: "2px auto",
  fontSize: 16,
  cursor: "pointer",
  borderRadius: 6,
  border: "none",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
});

const headerStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 6 };

const rowStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 4 };

const linkButtonStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  textAlign: "left",
  fontSize: 12,
  padding: "2px 4px",
  cursor: "pointer",
  border: "none",
  background: "none",
  color: "inherit",
};

const smallButtonStyle: CSSProperties = {
  fontSize: 11,
  padding: "1px 6px",
  cursor: "pointer",
  borderRadius: 4,
  border: "1px solid var(--mantine-color-default-border)",
  background: "transparent",
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: "2px 6px",
  fontSize: 12,
  border: "1px solid var(--mantine-color-default-border)",
  borderRadius: 4,
};
