/**
 * `plugin-view-favorites` — sidebar view (roadmap P6-48), and the merged home of
 * what `plugin-file-nav` used to demo: 主页 + 常用位置 + 手动收藏 (docs/08 §5.3).
 *
 * Contributes an A icon and a `nav-panel:favorites` panel; the exclusive rendering is
 * `plugin-layout-views`' job. Favorites are this plugin's own data, kept in
 * localStorage — the base holds none (red line 2, docs/01 §6).
 *
 * Cascade role: publishes `sidebar:selection:changed` (B → C); reads the opaque
 * `focusRef` only to offer "收藏当前焦点".
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Events, type Ref, type SlotProps } from "@my-file-manager/plugin-sdk";

const VIEW_ID = "favorites";
const PLUGIN_NAME = "plugin-view-favorites";
const LS_KEY = "fm.view-favorites.v1";

interface Favorite {
  path: string;
  kind: string;
  name: string;
}

const basename = (p: string): string => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 && idx < p.length - 1 ? p.slice(idx + 1) : p;
};

function load(): Favorite[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Favorite[]) : [];
  } catch {
    return [];
  }
}

function save(list: Favorite[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
  } catch {
    // storage unavailable: the list simply is not remembered
  }
}

export function RailIcon({ host }: SlotProps) {
  const [active, setActive] = useState(host.getState().activeSidebarView);
  useEffect(() => host.onStateChange((s) => setActive(s.activeSidebarView)), [host]);
  return (
    <button
      type="button"
      title="收藏"
      onClick={() => host.emit(Events.sidebarViewChanged, { viewId: VIEW_ID })}
      style={railButtonStyle(active === VIEW_ID)}
    >
      ⭐
    </button>
  );
}

export function FavoritesPanel({ host }: SlotProps) {
  const [home, setHome] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<Favorite[]>(load);
  const [focusPath, setFocusPath] = useState<string | null>(host.getState().focusRef?.id ?? null);
  const [focusKind, setFocusKind] = useState<string>("file");

  useEffect(
    () =>
      host.onStateChange((s) => {
        setFocusPath(s.focusRef?.id ?? null);
        setFocusKind(s.focusRef?.kind ?? "file");
      }),
    [host],
  );

  useEffect(() => {
    if (home) return;
    host
      .invoke<string>("fs.home")
      .then((h) => setHome(String(h)))
      .catch(() => setHome(""));
  }, [host, home]);

  const select = (fav: Favorite): void =>
    host.emit(Events.sidebarSelectionChanged, {
      kind: fav.kind,
      id: fav.path,
      sourcePlugin: PLUGIN_NAME,
    } satisfies Ref);

  const addFocus = (): void => {
    if (!focusPath) return;
    const next = [
      ...favorites.filter((f) => f.path !== focusPath),
      { path: focusPath, kind: focusKind, name: basename(focusPath) },
    ];
    setFavorites(next);
    save(next);
  };

  const remove = (path: string): void => {
    const next = favorites.filter((f) => f.path !== path);
    setFavorites(next);
    save(next);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
      <div style={headerStyle}>
        <span style={{ color: "var(--mantine-color-dimmed)" }}>收藏 / 常用位置</span>
        <button type="button" onClick={addFocus} disabled={!focusPath} style={smallButtonStyle}>
          ＋ 焦点
        </button>
      </div>

      {home && (
        <Row
          label="⌂ 主页"
          name={basename(home) || home}
          onClick={() => select({ path: home, kind: "folder", name: home })}
        />
      )}
      {favorites.map((f) => (
        <Row key={f.path} label={f.kind === "folder" ? "📁" : "📄"} name={f.name} onClick={() => select(f)} onRemove={() => remove(f.path)} />
      ))}
      {!favorites.length && (
        <div style={{ color: "var(--mantine-color-dimmed)" }}>
          暂无收藏：在 C 选中一个对象后点「＋ 焦点」
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  name,
  onClick,
  onRemove,
}: {
  label: string;
  name: string;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div style={rowStyle}>
      <button type="button" onClick={onClick} style={linkButtonStyle}>
        <span style={{ marginRight: 6 }}>{label}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
      </button>
      {onRemove && (
        <button type="button" title="移除收藏" onClick={onRemove} style={smallButtonStyle}>
          ✕
        </button>
      )}
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
