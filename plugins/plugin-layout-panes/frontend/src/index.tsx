/**
 * `plugin-layout-panes` — region C's split container (roadmap P6-46, docs/01 §9.3,
 * docs/02 §4.5).
 *
 * Owns **geometry only**: how many panes, which pane is where, divider ratios. It
 * provides the nested slots `pane-slot:<n>`; content plugins (file-browser today)
 * inject themselves into those outlets, so this container never touches their data.
 *
 * Stable paneId is what makes mode switching lossless: every live pane stays a
 * child of ONE css-grid parent, keyed by its id, and is only hidden (`display:none`)
 * when the mode shows fewer panes than exist. Reparenting a React subtree would
 * remount it and drop the pane's local state, so reparenting is deliberately avoided.
 *
 * `layoutMode`/`panes` are this plugin's LOCAL state, kept per browsing session and
 * remembered in localStorage — the base only supplies the opaque `activeTabId`.
 */

import { Button, Menu } from "@mantine/core";
import { Events, type PluginHost, type SlotProps } from "@my-file-manager/plugin-sdk";
import { Check, ChevronDown, X } from "lucide-react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

const MODES = [1, 2, 4] as const;
type Mode = (typeof MODES)[number];

interface PaneState {
  mode: Mode;
  /** Live pane ids in layout order; ids are never reused while alive. */
  ids: string[];
  seq: number;
  colPct: number;
  rowPct: number;
}

const DEFAULT_STATE: PaneState = { mode: 1, ids: ["p0"], seq: 1, colPct: 50, rowPct: 50 };
const LS_KEY = "fm.layout-panes.v1";
const GAP = 6;

// Both contributions belong to this plugin; pane state stays out of the shell.
type LayoutController = { mode: Mode; setMode: (mode: Mode) => void };
const controllers = new Map<string, LayoutController>();
const listeners = new Set<() => void>();
const notifyToolbar = () => {
  for (const listener of listeners) listener();
};
const subscribeToolbar = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export function PanesToolbar({ host }: SlotProps) {
  const [tabId, setTabId] = useState(host.getState().activeTabId);
  useEffect(() => host.onStateChange((state) => setTabId(state.activeTabId)), [host]);
  const controller = useSyncExternalStore(subscribeToolbar, () => controllers.get(tabId));
  if (!controller) return null;
  return (
    <div className="fm-layout-toolbar" style={toolbarStyle}>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <Button
            className="fm-dropdown-button"
            variant="default"
            size="xs"
            aria-label="分栏布局"
            rightSection={<ChevronDown size={14} />}
          >
            {controller.mode === 1 ? "单栏" : controller.mode === 2 ? "双栏" : "四栏"}
          </Button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>分栏布局</Menu.Label>
          {MODES.map((mode) => (
            <Menu.Item
              key={mode}
              onClick={() => controller.setMode(mode)}
              rightSection={
                controller.mode === mode ? (
                  <span title="当前布局">
                    <Check size={14} />
                  </span>
                ) : undefined
              }
            >
              {mode === 1 ? "单栏" : mode === 2 ? "左右双栏" : "四栏"}
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </div>
  );
}

const clampPct = (n: number): number => Math.min(85, Math.max(15, n));
/** The widest layout that still fits the number of live panes. */
const fitMode = (count: number, want: Mode): Mode => (count >= 4 ? want : count >= 2 ? (want === 4 ? 2 : want) : 1);

function loadAll(): Record<string, PaneState> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, PaneState>) : {};
  } catch {
    return {};
  }
}

function saveAll(map: Record<string, PaneState>): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    // storage unavailable: layout simply is not remembered
  }
}

export function PanesContainer({ host }: SlotProps) {
  const [byTab, setByTab] = useState<Record<string, PaneState>>(loadAll);
  const [tabId, setTabId] = useState<string>(host.getState().activeTabId);

  useEffect(
    () =>
      host.onStateChange((s) => {
        setTabId(s.activeTabId);
      }),
    [host],
  );

  const st = byTab[tabId] ?? DEFAULT_STATE;

  const commit = useCallback(
    (next: PaneState, reconfigured?: { slotId: string; action: "add" | "remove" }): void => {
      setByTab((all) => {
        const merged = { ...all, [tabId]: next };
        saveAll(merged);
        return merged;
      });
      if (reconfigured) host.emit(Events.slotReconfigured, reconfigured);
    },
    [tabId, host],
  );

  const setMode = useCallback(
    (mode: Mode): void => {
      if (mode === st.mode) return;
      const ids = [...st.ids];
      let seq = st.seq;
      const created: string[] = [];
      while (ids.length < mode) {
        const id = `p${seq++}`;
        ids.push(id);
        created.push(`pane-slot:${id}`);
      }
      commit({ ...st, mode, ids, seq });
      // docs/02 §4.5: a pane added is announced after the state lands, so the
      // outlet exists and content plugins can inject into it.
      for (const slotId of created) {
        host.emit(Events.slotReconfigured, { slotId, action: "add" } as const);
      }
    },
    [st, commit, host],
  );

  const controller = useMemo(() => ({ mode: st.mode, setMode }), [st.mode, setMode]);
  useEffect(() => {
    controllers.set(tabId, controller);
    notifyToolbar();
  }, [tabId, controller]);
  useEffect(
    () => () => {
      controllers.delete(tabId);
      notifyToolbar();
    },
    [tabId],
  );

  const closePane = (id: string): void => {
    if (st.ids.length <= 1) return;
    const ids = st.ids.filter((x) => x !== id);
    commit(
      { ...st, ids, mode: fitMode(ids.length, st.mode) },
      {
        slotId: `pane-slot:${id}`,
        action: "remove",
      },
    );
  };

  const visible = st.ids.slice(0, Math.min(st.ids.length, st.mode));
  const four = st.mode === 4 && visible.length === 4;
  const cols = visible.length === 2 && !four;

  const dragCol = (dx: number, axis: number): void =>
    commit({ ...st, colPct: clampPct(st.colPct + (dx / axis) * 100) });
  const dragRow = (dy: number, axis: number): void =>
    commit({ ...st, rowPct: clampPct(st.rowPct + (dy / axis) * 100) });

  return (
    <div
      className="fm-layout-panes"
      data-mode={st.mode}
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
    >
      <div style={{ flex: 1, minHeight: 0 }}>
        {/* Keyed by session: a browsing session owns its own pane instances, so a
            pane's local path can never leak into another tab (docs/01 §9.1). The
            layout itself is restored from this session's persisted state. */}
        <div key={tabId} style={gridStyle(st, four, cols)}>
          {st.ids.map((id, order) => {
            const i = visible.indexOf(id);
            const area = i < 0 ? "c1" : four ? ["a1", "a2", "a3", "a4"][i] : i === 0 ? "c1" : "c2";
            return (
              // Every live pane lives in ONE keyed array: a mode change only rewrites
              // its grid-area, so React moves the subtree by key instead of remounting
              // it — which is what keeps each pane's path/selection alive (docs/02 §4.5).
              <Pane
                key={id}
                host={host}
                paneId={id}
                order={order + 1}
                area={area}
                hidden={i < 0}
                onClose={() => closePane(id)}
              />
            );
          })}

          {four ? (
            <>
              <Divider orientation="col" area="h1" onDrag={dragCol} />
              <Divider orientation="col" area="h2" onDrag={dragCol} />
              <Divider orientation="row" area="v" onDrag={dragRow} />
            </>
          ) : (
            cols && <Divider orientation="col" area="d1" onDrag={dragCol} />
          )}
        </div>
      </div>
    </div>
  );
}

/** One live pane = one `pane-slot:<id>` outlet plus a close affordance. A pane the
 *  current mode has no room for stays mounted and is hidden, so its content plugin
 *  keeps its local state. */
function Pane({
  host,
  paneId,
  order,
  area,
  hidden,
  onClose,
}: {
  host: PluginHost;
  paneId: string;
  order: number;
  area: string;
  hidden: boolean;
  onClose: () => void;
}) {
  const slotId = `pane-slot:${paneId}`;
  const Outlet = host.provideSlot(slotId);
  return (
    <section className="fm-pane" style={{ ...paneStyle(hidden), gridArea: area }}>
      <div className="fm-pane-header" style={paneHeaderStyle}>
        <span title={slotId}>栏 {order}</span>
        <button
          type="button"
          className="fm-pane-close"
          onClick={onClose}
          aria-label={`关闭栏 ${order}`}
          title="关闭此栏"
          style={closeButtonStyle}
        >
          <X size={12} />
        </button>
      </div>
      <div style={paneOutletStyle}>
        <Outlet id={slotId} />
      </div>
    </section>
  );
}

/** Draggable grid gutter: reports the axis delta plus the axis length so the
 *  caller can convert it into a percentage. */
function Divider({
  orientation,
  area,
  onDrag,
}: {
  orientation: "col" | "row";
  area: string;
  onDrag: (delta: number, axis: number) => void;
}) {
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const axis = useRef(1);
  return (
    // biome-ignore lint/a11y/useSemanticElements: 指针拖拽的分栏条是交互式 window splitter；<hr> 无可交互语义且会带入默认样式
    <div
      className="fm-resizer"
      role="separator"
      aria-orientation={orientation === "col" ? "vertical" : "horizontal"}
      title="拖动调整分栏"
      style={{
        gridArea: area,
        cursor: orientation === "col" ? "col-resize" : "row-resize",
        background: "var(--mantine-color-default-border)",
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        anchor.current = { x: e.clientX, y: e.clientY };
        const parent = e.currentTarget.parentElement;
        axis.current = (orientation === "col" ? parent?.clientWidth : parent?.clientHeight) || 1;
      }}
      onPointerMove={(e) => {
        const a = anchor.current;
        if (!a) return;
        onDrag(orientation === "col" ? e.clientX - a.x : e.clientY - a.y, axis.current);
        anchor.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => {
        anchor.current = null;
      }}
    />
  );
}

function gridStyle(st: PaneState, four: boolean, cols: boolean): CSSProperties {
  // Every row track is bounded by the container height (`minmax(0, …)`), never
  // by its content: an auto row would grow to whatever the pane inside asks for,
  // and a content plugin that virtualizes needs a viewport of finite height.
  if (four) {
    return {
      display: "grid",
      height: "100%",
      gridTemplateColumns: `${st.colPct}% ${GAP}px calc(100% - ${st.colPct}% - ${GAP}px)`,
      gridTemplateRows: `${st.rowPct}% ${GAP}px calc(100% - ${st.rowPct}% - ${GAP}px)`,
      gridTemplateAreas: `"a1 h1 a2" "v v v" "a3 h2 a4"`,
    };
  }
  if (cols) {
    return {
      display: "grid",
      height: "100%",
      gridTemplateColumns: `${st.colPct}% ${GAP}px calc(100% - ${st.colPct}% - ${GAP}px)`,
      gridTemplateRows: "minmax(0, 1fr)",
      gridTemplateAreas: `"c1 d1 c2"`,
    };
  }
  return {
    display: "grid",
    height: "100%",
    gridTemplateColumns: "1fr",
    gridTemplateRows: "minmax(0, 1fr)",
    gridTemplateAreas: `"c1"`,
  };
}

const toolbarStyle: CSSProperties = {
  display: "flex",
  gap: 6,
  alignItems: "center",
  padding: 0,
  fontSize: 12,
  flexShrink: 0,
};

/** A pane is a bounded flex column, never a block: the header keeps its own
 *  height and the outlet takes the rest, which is the only thing that gives a
 *  content plugin's scroller a definite height (virtualizing 100k rows depends
 *  on it). `display` must be spelled out for the visible case too — React drops
 *  a style property whose value is `undefined`, which would send the section
 *  back to its default `display: block`. */
const paneStyle = (hidden: boolean): CSSProperties => ({
  display: hidden ? "none" : "flex",
  flexDirection: "column",
  minWidth: 0,
  minHeight: 0,
  border: "1px solid var(--mantine-color-default-border)",
  borderRadius: "var(--mantine-radius-md)",
  overflow: "hidden",
});

/** The content plugin owns scrolling; the outlet only clips so a plugin that
 *  forgets to bound its own height cannot inflate the pane. */
const paneOutletStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "hidden",
};

const paneHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  padding: "5px 10px",
  fontSize: 11,
  color: "var(--mantine-color-dimmed)",
  flexShrink: 0,
  borderBottom: "1px solid var(--mantine-color-default-border)",
};

const closeButtonStyle: CSSProperties = {
  marginLeft: "auto",
  fontSize: 11,
  cursor: "pointer",
  border: "none",
  background: "none",
};
