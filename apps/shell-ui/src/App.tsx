/**
 * The base outer shell (roadmap P6-43, docs/01 §9.1/§9.3).
 *
 * Six regions, all base-owned because they are stable and carry zero business
 * logic: A `activity-rail-zone` / B `nav-zone` / C `main-view-zone` /
 * D `file-sidebar-zone` / toolbar `topbar-zone` / `statusbar-zone`
 * (+ `bottom-drawer`, a dev-only region, and `command-palette`, an overlay
 * region). The shell only lays these out and mounts
 * whatever plugins contributed; the address bar, directory listings and item
 * counts that used to sit here moved into `plugin-file-browser` (docs/01 §6 red
 * line 2 — the base holds meta state, not business state).
 *
 * Reference layout: brand above A/B, sessions and topbar above C, D spans
 * the workspace from its top edge. The status bar spans the window bottom.
 * Navigation remains contributed by plugins into topbar-zone.
 *
 * The tab strip is the BROWSING SESSION layer: each tab owns one cascade snapshot
 * in `state.ts`, and activating a session emits `tab:activated` so the whole group
 * comes back together — that is the "切换会话不混乱" guarantee.
 *
 * Appearance uses Mantine; theme switching lives in the settings plugin. Collapse flags and
 * panel widths are remembered in localStorage.
 */

import { ActionIcon, Divider, Group, Text, Title } from "@mantine/core";
import { BaseSlots } from "@my-file-manager/plugin-sdk";
import {
  AppWindowMac,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Plus,
  X,
} from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { PluginSlot } from "./PluginSlot";
import { activateTab, useMeta } from "./state";

interface ShellLayout {
  bWidth: number;
  dWidth: number;
  bCollapsed: boolean;
  dCollapsed: boolean;
  drawerOpen: boolean;
}

const LS_KEY = "fm.shell.layout.v2";
const DEFAULT_LAYOUT: ShellLayout = {
  bWidth: 184,
  dWidth: 320,
  bCollapsed: false,
  dCollapsed: false,
  drawerOpen: false,
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function loadLayout(): ShellLayout {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return { ...DEFAULT_LAYOUT, ...(JSON.parse(raw) as Partial<ShellLayout>) };
    const legacy = localStorage.getItem("fm.shell.layout.v1");
    return legacy
      ? { ...DEFAULT_LAYOUT, ...(JSON.parse(legacy) as Partial<ShellLayout>), drawerOpen: false }
      : DEFAULT_LAYOUT;
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

  const leftWidth = 56 + (layout.bCollapsed ? 0 : clamp(layout.bWidth, 140, 560) + 4);
  const togglePanel = (which: "b" | "d") =>
    patch(which === "b" ? { bCollapsed: !layout.bCollapsed } : { dCollapsed: !layout.dCollapsed });

  return (
    <div className="fm-shell" style={rootStyle}>
      <div
        className="fm-workspace"
        style={{
          display: "grid",
          gridTemplateColumns: `${leftWidth}px minmax(0, 1fr) ${layout.dCollapsed ? 0 : clamp(layout.dWidth, 180, 640)}px`,
          flex: 1,
          minHeight: 0,
        }}
      >
        <div className="fm-left-workspace">
          <header className="fm-brand" data-collapsed={layout.bCollapsed}>
            <span className="fm-brand-icon">
              <AppWindowMac size={24} />
            </span>
            <Title className="fm-brand-title" order={6}>
              我的文件管理器
            </Title>
          </header>
          <div style={bodyStyle}>
            <nav className="fm-rail" aria-label="视图导航" style={railStyle}>
              <PluginSlot slotId={BaseSlots.activityRail} />
            </nav>
            {!layout.bCollapsed && (
              <>
                <aside className="fm-sidebar" style={{ ...asideStyle, width: clamp(layout.bWidth, 140, 560) }}>
                  <PluginSlot slotId={BaseSlots.nav} />
                </aside>
                <PanelResizer side="b" width={layout.bWidth} onWidth={(w) => patch({ bWidth: w })} />
              </>
            )}
          </div>
        </div>

        <div className="fm-center-workspace">
          <header className="fm-identity" style={identityStyle}>
            <PanelToggle side="b" collapsed={layout.bCollapsed} onToggle={() => togglePanel("b")} />
            <SessionTabs
              tabs={tabs}
              activeTabId={activeTabId}
              onCreate={() => useMeta.getState().createTab()}
              onClose={(id) => useMeta.getState().closeTab(id)}
            />
            <PanelToggle side="d" collapsed={layout.dCollapsed} onToggle={() => togglePanel("d")} />
          </header>
          <div className="fm-toolbar" style={toolbarStyle}>
            <PluginSlot slotId={BaseSlots.topbar} />
          </div>
          <main className="fm-main" style={mainStyle}>
            <PluginSlot slotId={BaseSlots.mainView} />
          </main>
        </div>

        {!layout.dCollapsed && (
          <aside
            className="fm-sidebar fm-details"
            style={{ ...asideStyle, position: "relative", borderRight: "none", minWidth: 0, overflow: "hidden" }}
          >
            <PanelResizer side="d" width={layout.dWidth} onWidth={(w) => patch({ dWidth: w })} />
            <PluginSlot slotId={BaseSlots.fileSidebar} />
          </aside>
        )}
      </div>

      <PluginSlot slotId={BaseSlots.commandPalette} />
      <BottomDrawer open={layout.drawerOpen} onToggle={() => patch({ drawerOpen: !layout.drawerOpen })} />
      <footer className="fm-status" style={footerStyle}>
        <Text size="xs" c="dimmed" truncate style={{ maxWidth: "45%" }}>
          会话 {activeTabId.replace(/^tab-/, "")} ·{" "}
          {focusRef ? `${kindLabel(focusRef.kind)} ${focusRef.id}` : "未选中项目"}
        </Text>
        <Divider orientation="vertical" />
        <PluginSlot slotId={BaseSlots.statusbar} />
        <button
          className="fm-debug-toggle"
          type="button"
          aria-expanded={layout.drawerOpen}
          onClick={() => patch({ drawerOpen: !layout.drawerOpen })}
        >
          {layout.drawerOpen ? "收起调试台" : "调试台"}
        </button>
      </footer>
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
    <Group className="fm-sessions" gap={8} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
      <Group className="fm-session-scroll" gap={6} wrap="nowrap" style={{ flex: "0 1 auto", minWidth: 0 }}>
        {tabs.map((id) => {
          const active = id === activeTabId;
          return (
            <div key={id} className="fm-session" data-active={active} style={sessionTabStyle(active)}>
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

/** Shell geometry controls; the navigation toolbar itself is plugin-owned. */
function PanelToggle({ side, collapsed, onToggle }: { side: "b" | "d"; collapsed: boolean; onToggle: () => void }) {
  const label = side === "b" ? "侧栏" : "详情";
  return (
    <ActionIcon
      variant="subtle"
      color="gray"
      size="sm"
      title={`${collapsed ? "展开" : "折叠"}${label}`}
      aria-label={`${collapsed ? "展开" : "折叠"}${label}`}
      onClick={onToggle}
    >
      {side === "b" ? (
        collapsed ? (
          <PanelLeftOpen size={17} />
        ) : (
          <PanelLeftClose size={17} />
        )
      ) : collapsed ? (
        <PanelRightOpen size={17} />
      ) : (
        <PanelRightClose size={17} />
      )}
    </ActionIcon>
  );
}

/** Drag handle that resizes B (left) or D (right); the width lives in ShellLayout. */
function PanelResizer({ side, width, onWidth }: { side: "b" | "d"; width: number; onWidth: (w: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null);
  const max = side === "b" ? 560 : 640;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 指针拖拽的分隔条是交互式 window splitter；<hr> 无可交互语义且会带入浏览器默认样式
    <div
      className="fm-resizer"
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
  if (!open) return null;
  return (
    <section
      className="fm-drawer"
      style={{
        display: "flex",
        flexDirection: "column",
        height: open ? 260 : 32,
        minHeight: 28,
        borderTop: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="fm-drawer-toggle"
        aria-expanded={open}
        style={{ ...buttonResetStyle, ...drawerToggleStyle }}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
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
  padding: "8px 16px",
  height: 50,
  flexShrink: 0,
};

const bodyStyle: CSSProperties = { display: "flex", flex: 1, minHeight: 0 };

const railStyle: CSSProperties = {
  width: 56,
  flexShrink: 0,
  borderRight: "1px solid var(--mantine-color-default-border)",
  padding: "10px 6px",
  overflow: "auto",
  // A flex column so a view plugin can pin itself to the bottom (the settings gear
  // uses `marginTop: auto`) — the base still owns only geometry, never content order.
  display: "flex",
  flexDirection: "column",
};

const asideStyle: CSSProperties = {
  flexShrink: 0,
  borderRight: "1px solid var(--mantine-color-default-border)",
  padding: "12px 10px",
  overflow: "auto",
};

const mainStyle: CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  padding: "12px 16px 16px",
};

const sessionTabStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 2,
  padding: "2px 8px 2px 12px",
  fontSize: 12,
  borderRadius: "var(--mantine-radius-md)",
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
  height: 32,
  padding: "0 12px",
  color: "var(--mantine-color-dimmed)",
  flexShrink: 0,
};

const toolbarStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "6px 16px",
  alignItems: "center",
  minHeight: 50,
  flexShrink: 0,
  borderBottom: "1px solid var(--mantine-color-default-border)",
  background: "var(--mantine-color-default)",
};

const footerStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  padding: "3px 12px",
  borderTop: "1px solid var(--mantine-color-default-border)",
  fontSize: 12,
  color: "var(--mantine-color-dimmed)",
  minHeight: 30,
  flexShrink: 0,
};
