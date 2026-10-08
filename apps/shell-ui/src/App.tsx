/**
 * The base outer shell (roadmap P6-43, docs/01 §9.1/§9.3).
 *
 * Six regions, all base-owned because they are stable and carry zero business
 * logic: A `activity-rail-zone` / B `nav-zone` / C `main-view-zone` /
 * D `file-sidebar-zone` / toolbar `topbar-zone` / `statusbar-zone`
 * (+ `bottom-drawer`, a dev-only region). The shell only lays these out and mounts
 * whatever plugins contributed; the address bar, directory listings and item
 * counts that used to sit here moved into `plugin-file-browser` (docs/01 §6 red
 * line 2 — the base holds meta state, not business state).
 *
 * Rows, top to bottom: identity + sessions, then the full-width `topbar-zone`
 * toolbar, then A/B/C/D, then the status bar. The toolbar is a base ROW (it spans
 * the whole window) — a plugin that injects there never has to know how wide C is.
 *
 * The tab strip is the BROWSING SESSION layer: each tab owns one cascade snapshot
 * in `state.ts`, and activating a session emits `tab:activated` so the whole group
 * comes back together — that is the "切换会话不混乱" guarantee.
 *
 * Appearance is Mantine's: light by default (`main.tsx`), and the header switch
 * cycles 跟随系统 / 亮 / 暗 through `useMantineColorScheme`. Same provider, same
 * storage key as the settings plugin, so both stay in sync. Collapse flags and
 * panel widths are remembered in localStorage.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ActionIcon,
  Divider,
  Group,
  SegmentedControl,
  Text,
  Title,
  useMantineColorScheme,
} from "@mantine/core";
import {
  AppWindowMac,
  Monitor,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  Sun,
  X,
} from "lucide-react";
import { BaseSlots } from "@my-file-manager/plugin-sdk";
import { useMeta, activateTab } from "./state";
import { PluginSlot } from "./PluginSlot";

interface ShellLayout {
  bWidth: number;
  dWidth: number;
  bCollapsed: boolean;
  dCollapsed: boolean;
  drawerOpen: boolean;
}

const LS_KEY = "fm.shell.layout.v1";
const DEFAULT_LAYOUT: ShellLayout = {
  bWidth: 220,
  dWidth: 300,
  bCollapsed: false,
  dCollapsed: false,
  drawerOpen: true,
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function loadLayout(): ShellLayout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<ShellLayout>) } : DEFAULT_LAYOUT;
  } catch {
    return DEFAULT_LAYOUT;
  }
}

function useShellLayout(): { layout: ShellLayout; patch: (p: Partial<ShellLayout>) => void } {
  const [layout, setLayout] = useState<ShellLayout>(loadLayout);
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(layout));
    } catch {
      // storage unavailable (private mode): layout just won't be remembered
    }
  }, [layout]);
  const patch = useCallback((p: Partial<ShellLayout>) => setLayout((l) => ({ ...l, ...p })), []);
  return { layout, patch };
}

export function App() {
  const tabs = useMeta((s) => s.tabs);
  const activeTabId = useMeta((s) => s.activeTabId);
  const focusRef = useMeta((s) => s.snapshots[s.activeTabId]?.focusRef ?? null);
  const { layout, patch } = useShellLayout();

  return (
    <div style={rootStyle}>
      <header style={identityStyle}>
        <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
          <AppWindowMac size={18} color="var(--mantine-color-blue-6)" />
          <Title order={6} tt="none" style={{ whiteSpace: "nowrap" }}>
            我的文件管理器
          </Title>
        </Group>
        <SessionTabs
          tabs={tabs}
          activeTabId={activeTabId}
          onCreate={() => useMeta.getState().createTab()}
          onClose={(id) => useMeta.getState().closeTab(id)}
        />
        <ThemeSwitch />
      </header>

      {/* Full-width toolbar row: the topbar-zone rail + the base's panel toggles. */}
      <Toolbar
        layout={layout}
        onToggle={(which) =>
          patch(
            which === "b"
              ? { bCollapsed: !layout.bCollapsed }
              : { dCollapsed: !layout.dCollapsed },
          )
        }
      />

      <div style={bodyStyle}>
        {/* A — activity rail: the sidebar VIEW switcher (icons come from view plugins) */}
        <nav style={railStyle}>
          <PluginSlot slotId={BaseSlots.activityRail} />
        </nav>

        {/* B — panel content of the active view (exclusive by plugin-layout-views) */}
        {!layout.bCollapsed && (
          <>
            <aside style={{ ...asideStyle, width: clamp(layout.bWidth, 140, 560) }}>
              <PluginSlot slotId={BaseSlots.nav} />
            </aside>
            <PanelResizer side="b" width={layout.bWidth} onWidth={(w) => patch({ bWidth: w })} />
          </>
        )}

        {/* C — main content region (geometry owned by plugin-layout-panes) */}
        <main style={mainStyle}>
          <PluginSlot slotId={BaseSlots.mainView} />
        </main>

        {/* D — detail container region (tabs owned by plugin-inspector) */}
        {!layout.dCollapsed && (
          <>
            <PanelResizer side="d" width={layout.dWidth} onWidth={(w) => patch({ dWidth: w })} />
            <aside
              style={{
                ...asideStyle,
                width: clamp(layout.dWidth, 180, 640),
                borderLeft: "1px solid var(--mantine-color-default-border)",
                borderRight: "none",
              }}
            >
              <PluginSlot slotId={BaseSlots.fileSidebar} />
            </aside>
          </>
        )}
      </div>

      <footer style={footerStyle}>
        <Text size="xs" c="dimmed" truncate style={{ maxWidth: "45%" }}>
          会话 {activeTabId.replace(/^tab-/, "")} ·{" "}
          {focusRef ? `${kindLabel(focusRef.kind)} ${focusRef.id}` : "无焦点对象"}
        </Text>
        <Divider orientation="vertical" />
        <PluginSlot slotId={BaseSlots.statusbar} />
      </footer>

      <BottomDrawer open={layout.drawerOpen} onToggle={() => patch({ drawerOpen: !layout.drawerOpen })} />
    </div>
  );
}

const KIND_LABELS: Record<string, string> = { file: "文件", folder: "目录" };
const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;

/** The browsing-session layer: one tab = one cascade snapshot. */
function SessionTabs({
  tabs,
  activeTabId,
  onCreate,
  onClose,
}: {
  tabs: string[];
  activeTabId: string;
  onCreate: () => void;
  onClose: (tabId: string) => void;
}) {
  return (
    <Group gap={4} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
      <Group gap={0} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
        {tabs.map((id) => {
          const active = id === activeTabId;
          return (
            <div key={id} style={sessionTabStyle(active)}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => activateTab(id)}
                style={{ ...buttonResetStyle, fontSize: 12, color: "inherit" }}
              >
                {id.replace(/^tab-/, "会话 ")}
              </button>
              {tabs.length > 1 && (
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  title="关闭会话"
                  aria-label="关闭会话"
                  onClick={() => onClose(id)}
                >
                  <X size={12} />
                </ActionIcon>
              )}
            </div>
          );
        })}
      </Group>
      <ActionIcon
        size="xs"
        variant="subtle"
        color="blue"
        title="新建浏览会话"
        aria-label="新建浏览会话"
        onClick={onCreate}
      >
        <Plus size={14} />
      </ActionIcon>
    </Group>
  );
}

/** 跟随系统 / 亮色 / 暗色 — Mantine owns the value and persists it, so the settings
 *  plugin and this switch write the same storage key and stay in sync. */
function ThemeSwitch() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <SegmentedControl
      size="xs"
      value={colorScheme}
      onChange={(v) => setColorScheme(v as "auto" | "light" | "dark")}
      data={[
        { value: "auto", label: <AutoLabel /> },
        { value: "light", label: <LightLabel /> },
        { value: "dark", label: <DarkLabel /> },
      ]}
      style={{ flexShrink: 0 }}
    />
  );
}

const AutoLabel = () => (
  <Group gap={4} wrap="nowrap">
    <Monitor size={12} />
    <span>跟随系统</span>
  </Group>
);
const LightLabel = () => (
  <Group gap={4} wrap="nowrap">
    <Sun size={12} />
    <span>亮色</span>
  </Group>
);
const DarkLabel = () => (
  <Group gap={4} wrap="nowrap">
    <Moon size={12} />
    <span>暗色</span>
  </Group>
);

/** Navigation toolbar row: the `topbar-zone` extension rail + panel toggles. The address
 *  bar itself belongs to a pane content plugin, not to the shell. */
function Toolbar({
  layout,
  onToggle,
}: {
  layout: ShellLayout;
  onToggle: (which: "b" | "d") => void;
}) {
  return (
    <div style={toolbarStyle}>
      <PluginSlot slotId={BaseSlots.topbar} />
      <Group gap={4} wrap="nowrap" style={{ marginLeft: "auto" }}>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          title={layout.bCollapsed ? "展开 B 侧栏" : "折叠 B 侧栏"}
          aria-label={layout.bCollapsed ? "展开侧栏" : "折叠侧栏"}
          onClick={() => onToggle("b")}
        >
          {layout.bCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </ActionIcon>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          title={layout.dCollapsed ? "展开 D 详情" : "折叠 D 详情"}
          aria-label={layout.dCollapsed ? "展开详情" : "折叠详情"}
          onClick={() => onToggle("d")}
        >
          {layout.dCollapsed ? <PanelRightOpen size={16} /> : <PanelRightClose size={16} />}
        </ActionIcon>
      </Group>
    </div>
  );
}

/** Drag handle that resizes B (left) or D (right); the width lives in ShellLayout. */
function PanelResizer({
  side,
  width,
  onWidth,
}: {
  side: "b" | "d";
  width: number;
  onWidth: (w: number) => void;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const max = side === "b" ? 560 : 640;
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="拖动调整宽度"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, w: width };
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        onWidth(clamp(side === "b" ? s.w + dx : s.w - dx, 140, max));
      }}
      onPointerUp={() => {
        start.current = null;
      }}
      style={{
        width: 4,
        flexShrink: 0,
        cursor: "col-resize",
        background: "var(--mantine-color-default-border)",
      }}
    />
  );
}

/** Dev-only debugging region (`bottom-drawer`), collapsible, state remembered. */
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
      <button
        type="button"
        onClick={onToggle}
        style={{ ...buttonResetStyle, ...drawerToggleStyle }}
      >
        <span>{open ? "▾" : "▸"}</span>
        <span>调试抽屉</span>
      </button>
      {open && (
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", padding: "0 8px 8px" }}>
          <PluginSlot slotId={BaseSlots.bottomDrawer} />
        </div>
      )}
    </section>
  );
}

const rootStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  height: "100dvh",
  overflow: "hidden",
};

const identityStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 12,
  padding: "4px 10px",
  flexShrink: 0,
};

const bodyStyle: CSSProperties = { display: "flex", flex: 1, minHeight: 0 };

const railStyle: CSSProperties = {
  width: 48,
  flexShrink: 0,
  borderRight: "1px solid var(--mantine-color-default-border)",
  padding: 4,
  overflow: "auto",
  // A flex column so a view plugin can pin itself to the bottom (the settings gear
  // uses `marginTop: auto`) — the base still owns only geometry, never content order.
  display: "flex",
  flexDirection: "column",
};

const asideStyle: CSSProperties = {
  flexShrink: 0,
  borderRight: "1px solid var(--mantine-color-default-border)",
  padding: 8,
  overflow: "auto",
};

const mainStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  overflow: "auto",
  padding: "0 8px 8px",
};

const sessionTabStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: "2px 4px 2px 8px",
  fontSize: 12,
  borderRadius: "4px 4px 0 0",
  cursor: "pointer",
  whiteSpace: "nowrap",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
  color: active ? "var(--mantine-color-blue-7)" : "var(--mantine-color-dimmed)",
  borderTop: "1px solid var(--mantine-color-default-border)",
  borderRight: "1px solid var(--mantine-color-default-border)",
  borderLeft: "1px solid var(--mantine-color-default-border)",
  borderBottom: active ? "2px solid var(--mantine-color-blue-6)" : "1px solid transparent",
});

/** Buttons the shell draws itself (tab labels, drawer header): Mantine's look via
 *  CSS vars, without the component chrome. */
const buttonResetStyle: CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: "none",
  font: "inherit",
  padding: 0,
  cursor: "pointer",
};

const drawerToggleStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  height: 28,
  padding: "0 12px",
  color: "var(--mantine-color-dimmed)",
  flexShrink: 0,
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "4px 10px",
  alignItems: "center",
  flexWrap: "wrap",
  flexShrink: 0,
  borderBottom: "1px solid var(--mantine-color-default-border)",
  background: "var(--mantine-color-default-filled-hover)",
};

const footerStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  padding: "3px 12px",
  borderTop: "1px solid var(--mantine-color-default-border)",
  fontSize: 12,
  color: "var(--mantine-color-dimmed)",
  minHeight: 26,
  flexShrink: 0,
};
