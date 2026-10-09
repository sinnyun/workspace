/**
 * `plugin-file-browser` — content plugin for `pane-slot:<n>` (roadmap P6-46 落地验证,
 * docs/08 §7 step 1).
 *
 * This is the piece that lets the base drop its transitional file browser: region C
 * holds **zero business state** in the shell, and directory browsing lives here.
 *
 * It owns no outer slot. On `activate` it discovers the panes that already exist
 * (`host.providedSlots("pane-slot")`) and follows `slot:registered` / `slot:disposed`
 * for the rest, injecting one independent browser per pane — so each pane keeps its
 * own path, history, view mode and selection, and 左右双栏 really means two directories.
 *
 * Cascade role (docs/01 §9.2): consumes `sidebar:selection:changed` from B (folder /
 * file refs navigate), publishes `focus:changed` for D. `kind` is plugin-side
 * vocabulary — unknown kinds are ignored, because only plugins interpret references.
 *
 * Ordering and file metadata come from the provider: `fs.list` arrives naturally
 * sorted with sizes and mtimes, so a 500k directory costs one pass here instead of
 * a UI-thread sort. Grid thumbnails are pulled per visible card through the gated
 * `thumb.image` capability — never as raw file URLs — and cached plugin-side.
 *
 * It also owns its own preferences (default view mode, thumbnail switch) under
 * `fm.file-browser.prefs.v1` and contributes the matching settings page to
 * `plugin-settings`' floating panel — plugin-local state, never base state.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Menu,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
} from "@mantine/core";
import { createToolbarStore } from "./toolbar-store";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  LayoutGrid,
  List,
  RefreshCw,
} from "lucide-react";
import {
  Events,
  errorMessage,
  slotPrefix,
  type ListEntry,
  type PluginHost,
  type Ref,
  type SlotProps,
  type ThumbOut,
} from "@my-file-manager/plugin-sdk";

const PLUGIN_NAME = "plugin-file-browser";
const PANE_PREFIX = "pane-slot";
/** Per-session, per-pane memory. `plugin-layout-panes` rebuilds its panes when the
 *  browsing session changes, so a pane's path and view mode are restored here rather
 *  than leaked through a shared instance (docs/01 §9.1). */
const LS_KEY = "fm.file-browser.v1";
const CARD_MIN_WIDTH = 150;
const CARD_ROW_HEIGHT = 156;
/** Longest edge requested from `thumb.image`; a card shows ~96px. */
const THUMB_EDGE = 96;
/** Extensions worth asking the image capability about. Formats the provider cannot
 *  decode (svg / heic / raw) are included on purpose: their rejection is what puts
 *  the icon back, so that path gets exercised too. */
const THUMB_CANDIDATES = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "webp",
  "tiff",
  "tif",
  "svg",
  "heic",
  "cr2",
  "nef",
]);
/** Wait before pulling, so a fast flick never queues a decode per scrolled past row. */
const THUMB_SETTLE_MS = 80;
/** Grid cards hold their thumbnail here for the whole session, so scrolling back is
 *  free. Bounded: a lost thumbnail is just an icon, a leaked one is hundreds of MB. */
const THUMB_CACHE_MAX = 3000;

type ViewMode = "list" | "grid";

interface PaneMemory {
  cwd: string;
  mode: ViewMode;
}

function readMap(): Record<string, Partial<PaneMemory>> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Values written before view mode existed were plain path strings.
    return Object.fromEntries(
      Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? { cwd: v } : v]),
    ) as Record<string, Partial<PaneMemory>>;
  } catch {
    return {};
  }
}

function remember(key: string, patch: Partial<PaneMemory>): void {
  try {
    const map = readMap();
    map[key] = { ...map[key], ...patch };
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    // storage unavailable: the pane simply starts at home next time
  }
}

/** The pane each session interacted with last: B's selection drives THAT pane, not
 *  all of them (plugin-local, never base state). Keyed per session so a pane touched
 *  in one tab cannot swallow another tab's selections. */
const lastPaneBySession = new Map<string, string>();

// ───────────────────────────── 插件自己的偏好 ─────────────────────────────

/** 插件偏好放在模块作用域 + 自己的存储键里（不是基座状态）：设置页改一次，
 *  已经在渲染的每一栏都立刻跟随。 */
const PREFS_KEY = "fm.file-browser.prefs.v1";

interface Prefs {
  /** 栏位自己没选过显示方式时用的那一种。 */
  defaultMode: ViewMode;
  /** 网格卡片是否去取缩略图。 */
  thumbnails: boolean;
}

const DEFAULT_PREFS: Prefs = { defaultMode: "grid", thumbnails: true };

function readPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_PREFS, ...(JSON.parse(raw) as Partial<Prefs>) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

let prefs: Prefs = readPrefs();
const prefsListeners = new Set<() => void>();

function patchPrefs(patch: Partial<Prefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 存不下（隐私模式等）：偏好本次会话内照样生效
  }
  for (const listener of prefsListeners) listener();
}

function usePrefs(): Prefs {
  return useSyncExternalStore(
    (cb) => {
      prefsListeners.add(cb);
      return () => {
        prefsListeners.delete(cb);
      };
    },
    () => prefs,
  );
}

export function activate(host: PluginHost): () => void {
  const attached = new Map<string, () => void>();

  const attach = (slotId: string): void => {
    if (attached.has(slotId)) return;
    attached.set(slotId, host.contributeToSlot(slotId, FileBrowserPane));
  };
  const detach = (slotId: string): void => {
    attached.get(slotId)?.();
    attached.delete(slotId);
  };

  for (const slotId of host.providedSlots(PANE_PREFIX)) attach(slotId);

  const offRegistered = host.on<{ slotId: string }>(Events.slotRegistered, ({ slotId }) => {
    if (slotPrefix(slotId) === PANE_PREFIX) attach(slotId);
  });
  const offDisposed = host.on<{ slotId: string }>(Events.slotDisposed, ({ slotId }) => {
    if (slotPrefix(slotId) === PANE_PREFIX) detach(slotId);
  });

  return () => {
    offRegistered();
    offDisposed();
    for (const slotId of [...attached.keys()]) detach(slotId);
  };
}

/** 本插件贡献给设置面板的一页：内容只有本插件认得，写的也是自己的偏好存储。 */
export function SettingsPage() {
  const current = usePrefs();
  return (
    <Stack gap="md">
      <div>
        <Text size="sm" fw={600}>
          新建栏位的显示方式
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          没有单独选过的栏位跟随这个值；已经手动切换过的栏位保留自己的选择。
        </Text>
        <SegmentedControl
          fullWidth
          size="xs"
          value={current.defaultMode}
          onChange={(v) => patchPrefs({ defaultMode: v as ViewMode })}
          data={[
            { value: "list", label: "列表" },
            { value: "grid", label: "网格" },
          ]}
        />
      </div>
      <Group gap={10} wrap="nowrap">
        <div style={{ flex: 1, minWidth: 0 }}>
          <Text size="sm" fw={600}>
            网格缩略图
          </Text>
          <Text size="xs" c="dimmed">
            关闭后网格卡片只显示类型图标，滚动大目录时不再请求缩略图。
          </Text>
        </div>
        <Switch
          size="xs"
          checked={current.thumbnails}
          aria-label="显示网格缩略图"
          onChange={(e) => patchPrefs({ thumbnails: e.currentTarget.checked })}
        />
      </Group>
    </Stack>
  );
}

/** One pane's browser. `slotId` is which pane this instance lives in. */
function FileBrowserPane({ host, slotId }: SlotProps) {
  /** Fixed for the lifetime of this instance — the pane remounts per session. */
  const [session] = useState(() => host.getState().activeTabId);
  const memKey = `${session}|${slotId}`;
  const [memory] = useState<Partial<PaneMemory>>(() => readMap()[memKey] ?? {});

  /** This pane's own back/forward stack — never shared with another pane. */
  const [hist, setHist] = useState<{ stack: string[]; pos: number }>(() => ({
    stack: [memory.cwd ?? ""],
    pos: 0,
  }));
  const cwd = hist.stack[hist.pos] ?? "";

  const prefs = usePrefs();
  /** null = 这一栏没单独选过,跟随插件偏好;选过就自己记住。 */
  const [manualMode, setManualMode] = useState<ViewMode | null>(memory.mode ?? null);
  const mode = manualMode ?? prefs.defaultMode;
  const [entries, setEntries] = useState<ListEntry[]>([]);
  const [counts, setCounts] = useState<{ dirs: number; files: number }>({ dirs: 0, files: 0 });
  const [fetchMs, setFetchMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const browserRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  /** A new location truncates the forward branch; stepping back/forward does not push. */
  const navigate = useCallback((dir: string): void => {
    if (!dir) return;
    setHist((h) => {
      if (h.stack[h.pos] === dir) return h;
      const head = h.stack.slice(0, h.pos + 1);
      return { stack: [...head, dir], pos: head.length };
    });
    setError(null);
  }, []);

  const goBack = useCallback((): void => setHist((h) => ({ ...h, pos: Math.max(0, h.pos - 1) })), []);
  const goForward = useCallback((): void =>
    setHist((h) => ({ ...h, pos: Math.min(h.stack.length - 1, h.pos + 1) })), []);

  /** Read one directory. The provider's order is kept as-is: sorting 500k names on
   *  the UI thread is the host's job (`fs.list` returns natural order), and the
   *  virtualizer is only stable if the row stream does not shuffle per render. */
  const reload = useCallback((): void => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    const started = performance.now();
    host
      .invoke<ListEntry[]>("fs.list", { path: cwd })
      .then((list) => {
        let dirs = 0;
        for (const ent of list) if (ent.isDir) dirs++;
        setEntries(list);
        setCounts({ dirs, files: list.length - dirs });
        setFetchMs(performance.now() - started);
        setLoading(false);
      })
      .catch((err) => {
        setEntries([]);
        setCounts({ dirs: 0, files: 0 });
        setError(errorMessage(err));
        setLoading(false);
      });
  }, [cwd, host]);

  // The address bar mirrors whichever directory this pane now shows.
  useEffect(() => {
    if (cwd) remember(memKey, { cwd });
  }, [cwd, memKey]);

  useEffect(() => {
    reload();
  }, [reload]);

  // First mount with no remembered path: open the home directory.
  useEffect(() => {
    if (cwd) return;
    host
      .invoke<string>("fs.home")
      .then((home) => navigate(String(home)))
      .catch((err) => {
        setError(errorMessage(err));
        setLoading(false);
      });
  }, [cwd, host, navigate]);

  // B → C: the sidebar's selection navigates the pane this session last used.
  useEffect(
    () =>
      host.on<Ref | null>(Events.sidebarSelectionChanged, (ref) => {
        if (!ref) return;
        const last = lastPaneBySession.get(session);
        if (last !== undefined && last !== slotId) return;
        lastPaneBySession.set(session, slotId);
        navigate(ref.kind === "folder" ? ref.id : parentOf(ref.id));
      }),
    [host, navigate, slotId, session],
  );

  const claimPane = useCallback((): void => {
    lastPaneBySession.set(session, slotId);
    toolbarStore.claim(session, slotId);
  }, [session, slotId]);

  const publishFocus = (ent: ListEntry): void => {
    claimPane();
    setSelected(ent.path);
    host.emit(Events.focusChanged, {
      kind: ent.isDir ? "folder" : "file",
      id: ent.path,
      sourcePlugin: PLUGIN_NAME,
    } satisfies Ref);
  };

  const enter = (ent: ListEntry): void => {
    if (ent.isDir) navigate(ent.path);
  };

  const switchMode = useCallback((next: ViewMode): void => {
    setManualMode(next);
    remember(memKey, { mode: next });
  }, [memKey]);

  const controller = useMemo<NavigationController>(() => ({
    id: memKey, cwd, mode,
    canBack: hist.pos > 0, canForward: hist.pos < hist.stack.length - 1,
    canUp: !!cwd && cwd !== parentOf(cwd),
    back: goBack, forward: goForward, up: () => navigate(parentOf(cwd)),
    reload, navigate, setMode: switchMode, claim: claimPane,
  }), [memKey, cwd, mode, hist.pos, hist.stack.length, goBack, goForward, navigate, reload, switchMode, claimPane]);

  useEffect(() => {
    const el = browserRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setVisible(el.clientWidth > 0 && el.clientHeight > 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { toolbarStore.set(session, slotId, controller, visible); }, [session, slotId, controller, visible]);
  useEffect(() => () => { toolbarStore.remove(session, slotId); }, [session, slotId]);

  return (
    <div ref={browserRef} className="fm-browser" style={paneStyle} onMouseDown={claimPane} onFocusCapture={claimPane}>
      <NavigationBar controller={controller} />

      <div className="fm-directory" style={dirHeaderStyle}>
        <Text className="fm-directory-name" size="xs" fw={600} truncate title={cwd} style={{ minWidth: 0 }}>
          {cwd || "—"}
        </Text>
        <Text className="fm-directory-count" title={`读取耗时 ${fetchMs.toFixed(0)} ms`} size="xs" c="dimmed" style={{ marginLeft: "auto", flexShrink: 0 }}>
          {loading
            ? "载入中…"
            : error
              ? "—"
              : `${counts.dirs} 个文件夹 · ${counts.files} 个文件`}
        </Text>
      </div>

      {error && (
        <div className="fm-empty" style={{ flex: 1 }}>
          <span className="fm-empty-icon"><Folder size={28} /></span>
          <Text size="sm" fw={600}>无法打开此文件夹</Text>
          <Text size="xs" c="red" style={{ overflowWrap: "anywhere" }}>{error}</Text>
          <Text size="xs" c="dimmed">检查目录路径，或点击刷新重试。</Text>
        </div>
      )}

      {!error && (
        <EntryArea
          loading={loading}
          host={host}
          mode={mode}
          entries={entries}
          cwd={cwd}
          selected={selected}
          onFocus={publishFocus}
          onEnter={enter}
        />
      )}
    </div>
  );
}

interface NavigationController {
  id: string;
  cwd: string;
  mode: ViewMode;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  back: () => void;
  forward: () => void;
  up: () => void;
  reload: () => void;
  navigate: (path: string) => void;
  setMode: (mode: ViewMode) => void;
  claim: () => void;
}

const toolbarStore = createToolbarStore<NavigationController>();

/** The existing topbar slot carries the active pane's navigation, owned by this plugin. */
export function FileBrowserToolbar({ host }: SlotProps) {
  const [session, setSession] = useState(host.getState().activeTabId);
  useEffect(() => host.onStateChange((state) => setSession(state.activeTabId)), [host]);
  const controller = useSyncExternalStore(toolbarStore.subscribe, () => toolbarStore.get(session));
  useEffect(() => { controller?.claim(); }, [controller?.id]);
  return controller ? <NavigationBar key={controller.id} controller={controller} global />
    : <Text size="xs" c="dimmed">文件导航</Text>;
}

function NavigationBar({ controller, global = false }: { controller: NavigationController; global?: boolean }) {
  const [address, setAddress] = useState(controller.cwd);
  useEffect(() => setAddress(controller.cwd), [controller.cwd]);
  return (
    <div className={global ? "fm-address fm-global-address" : "fm-address"}
      onMouseDown={controller.claim} onFocusCapture={controller.claim}
      style={{ ...addressBarStyle, ...(global ? { padding: 0, flex: 1 } : {}) }}>
        <Group gap={2} wrap="nowrap" style={{ flexShrink: 0 }}>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            title="后退"
            aria-label="后退"
            disabled={!controller.canBack}
            onClick={controller.back}
          >
            <ArrowLeft size={15} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            title="前进"
            aria-label="前进"
            disabled={!controller.canForward}
            onClick={controller.forward}
          >
            <ArrowRight size={15} />
          </ActionIcon>
          <ActionIcon
            variant="subtle"
            color="gray"
            size="sm"
            title="上级目录"
            aria-label="上级目录"
            disabled={!controller.canUp}
            onClick={controller.up}
          >
            <ArrowUp size={15} />
          </ActionIcon>
          <ActionIcon variant="subtle" color="gray" size="sm" title="刷新" aria-label="刷新" onClick={controller.reload}>
            <RefreshCw size={14} />
          </ActionIcon>
        </Group>

        <TextInput
          className="fm-address-input"
          leftSection={<Folder size={14} />}
          size="xs"
          variant="default"
          value={address}
          onChange={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && address.trim()) controller.navigate(address.trim());
          }}
          placeholder="输入目录路径后回车"
          aria-label="当前目录地址"
          style={{ flex: 1, minWidth: 0 }}
        />

        <div className="fm-view-mode" style={{ flexShrink: 0 }}>
          <Menu position="bottom-end" withinPortal>
            <Menu.Target>
              <Button className="fm-dropdown-button" variant="default" size="xs" aria-label="视图模式"
                rightSection={<span aria-hidden="true">⌄</span>}>
                {controller.mode === "list" ? <ListLabel /> : <GridLabel />}
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Menu.Label>视图模式</Menu.Label>
              {(["list", "grid"] as const).map((mode) => (
                <Menu.Item key={mode} onClick={() => controller.setMode(mode)}
                  leftSection={mode === "list" ? <List size={14} /> : <LayoutGrid size={14} />}
                  rightSection={controller.mode === mode ? <span aria-label="当前视图">✓</span> : undefined}>
                  {mode === "list" ? "列表" : "网格"}
                </Menu.Item>
              ))}
            </Menu.Dropdown>
          </Menu>
        </div>
      </div>
  );
}

const ListLabel = () => (
  <Group gap={4} wrap="nowrap">
    <List size={12} />
    <span className="fm-view-label-text">列表</span>
  </Group>
);
const GridLabel = () => (
  <Group gap={4} wrap="nowrap">
    <LayoutGrid size={12} />
    <span className="fm-view-label-text">网格</span>
  </Group>
);

/** One virtual row: a group header or a run of entries (list = 1, grid = N cards). */
type Row =
  | { kind: "header"; title: string; path: string }
  | { kind: "list"; ent: ListEntry }
  | { kind: "cards"; items: ListEntry[] };

function buildRows(entries: ListEntry[], cwd: string, mode: ViewMode, cols: number): Row[] {
  const dirs = entries.filter((e) => e.isDir);
  const files = entries.filter((e) => !e.isDir);
  const rows: Row[] = [];
  const push = (title: string, items: ListEntry[]): void => {
    if (items.length === 0) return;
    rows.push({ kind: "header", title, path: cwd });
    if (mode === "list") {
      for (const ent of items) rows.push({ kind: "list", ent });
      return;
    }
    for (let i = 0; i < items.length; i += cols) {
      rows.push({ kind: "cards", items: items.slice(i, i + cols) });
    }
  };
  push("文件夹", dirs);
  push("文件", files);
  return rows;
}

/** List and grid share ONE virtualized row stream, so a 50k-entry directory costs the
 *  same in either mode. Grid rows carry real height because a card shows a thumbnail. */
function EntryArea({
  loading,
  host,
  mode,
  entries,
  cwd,
  selected,
  onFocus,
  onEnter,
}: {
  loading: boolean;
  host: PluginHost;
  mode: ViewMode;
  entries: ListEntry[];
  cwd: string;
  selected: string | null;
  onFocus: (ent: ListEntry) => void;
  onEnter: (ent: ListEntry) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const empty = entries.length === 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [empty]);

  const cols = mode === "grid" ? Math.max(1, Math.floor((width + 8) / (CARD_MIN_WIDTH + 8)) || 1) : 1;
  const rows = useMemo(() => buildRows(entries, cwd, mode, cols), [entries, cwd, mode, cols]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) =>
      rows[i].kind === "header" ? 32 : rows[i].kind === "cards" ? CARD_ROW_HEIGHT : 36,
    overscan: 10,
  });

  if (entries.length === 0) {
    return (
      <div className="fm-empty" style={{ flex: 1 }}>
        <span className="fm-empty-icon"><Folder size={28} /></span>
        <Text size="sm" fw={600}>{loading ? "正在加载目录…" : "此文件夹为空"}</Text>
        <Text size="xs" c="dimmed">{loading ? "稍候即可查看文件内容" : "这里还没有文件或子文件夹"}</Text>
      </div>
    );
  }

  return (
    <div ref={scrollRef} style={scrollStyle}>
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          const abs: CSSProperties = {
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${item.start}px)`,
          };
          if (row.kind === "header") {
            return (
              <div className="fm-entry-group" key={item.key} style={{ ...rowHeaderStyle, ...abs }}>
                <Text size="xs" fw={600}>
                  {row.title}
                </Text>
                <Text className="fm-entry-group-path" size="xs" c="dimmed" truncate ml="auto">
                  {row.path}
                </Text>
              </div>
            );
          }
          if (row.kind === "list") {
            return (
              <div
                key={item.key}
                className="fm-entry"
                data-selected={selected === row.ent.path}
                role="button"
                tabIndex={0}
                aria-pressed={selected === row.ent.path}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { onFocus(row.ent); onEnter(row.ent); }
                  if (e.key === " ") { e.preventDefault(); onFocus(row.ent); }
                }}
                style={{ ...listRowStyle, ...abs }}
                onClick={() => onFocus(row.ent)}
                onDoubleClick={() => onEnter(row.ent)}
                title={row.ent.isDir ? "双击进入" : undefined}
              >
                <IconFor entry={row.ent} />
                <Text size="xs" truncate style={{ flex: 1, minWidth: 0 }}>
                  {row.ent.name}
                </Text>
                <Text className="fm-size-cell" size="xs" c="dimmed" style={cellStyle}>
                  {row.ent.isDir ? "" : formatSize(row.ent.size ?? 0)}
                </Text>
                <Text className="fm-date-cell" size="xs" c="dimmed" style={cellStyle}>
                  {formatModified(row.ent.modifiedMs)}
                </Text>
              </div>
            );
          }
          return (
            <div key={item.key} style={{ ...cardsRowStyle, ...abs, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
              {row.items.map((ent) => (
                <div
                  key={ent.path}
                  className="fm-card"
                  data-selected={selected === ent.path}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected === ent.path}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { onFocus(ent); onEnter(ent); }
                    if (e.key === " ") { e.preventDefault(); onFocus(ent); }
                  }}
                  style={cardStyle}
                  onClick={() => onFocus(ent)}
                  onDoubleClick={() => onEnter(ent)}
                  title={ent.isDir ? "双击进入" : undefined}
                >
                  <Thumb host={host} entry={ent} />
                  <Text size="xs" truncate style={{ width: "100%" }}>
                    {ent.name}
                  </Text>
                  <Group gap={4} wrap="nowrap" style={{ marginTop: "auto" }}>
                    <Badge size="xs" variant="light" color={ent.isDir ? "blue" : "gray"} tt="uppercase">
                      {ent.isDir ? "文件夹" : extensionOf(ent.name) || "文件"}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      {ent.isDir ? "" : formatSize(ent.size ?? 0)}
                    </Text>
                  </Group>
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Extension → icon, so a pane reads without any content inspection. */
function IconFor({ entry, size = 14 }: { entry: ListEntry; size?: number }) {
  if (entry.isDir) return <Folder size={size} color="var(--mantine-color-yellow-6)" />;
  const ext = extensionOf(entry.name);
  if (["ts", "tsx", "js", "jsx", "rs", "py", "go", "java"].includes(ext)) {
    return <FileCode size={size} color="var(--mantine-color-blue-6)" />;
  }
  if (["md", "txt", "json", "yaml", "yml", "toml"].includes(ext)) {
    return <FileText size={size} color="var(--mantine-color-gray-6)" />;
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) {
    return <FileImage size={size} color="var(--mantine-color-violet-6)" />;
  }
  if (["zip", "7z", "gz", "tar", "rar"].includes(ext)) {
    return <FileArchive size={size} color="var(--mantine-color-orange-6)" />;
  }
  if (["csv", "xls", "xlsx"].includes(ext)) {
    return <FileSpreadsheet size={size} color="var(--mantine-color-teal-6)" />;
  }
  return <File size={size} color="var(--mantine-color-dimmed)" />;
}

/** Insertion-ordered thumbnail memory, shared by every pane in this session.
 *  A `null` value is a remembered refusal, so an unsupported format is never
 *  re-decoded on every scroll pass. */
const thumbCache = new Map<string, string | null>();

function rememberThumb(path: string, dataUrl: string | null): void {
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    for (const oldest of [...thumbCache.keys()].slice(0, THUMB_CACHE_MAX / 2)) {
      thumbCache.delete(oldest);
    }
  }
  thumbCache.set(path, dataUrl);
}

/** A card's picture slot. Asks the gated `thumb.image` capability for the
 *  thumbnail once the row has settled, and shows the type icon until (or unless)
 *  it answers — so scrolling a huge directory pulls ~a screen of images, not all
 *  of them, and a decode failure is just an icon. */
function Thumb({ host, entry }: { host: PluginHost; entry: ListEntry }) {
  const enabled = usePrefs().thumbnails;
  const candidate = enabled && !entry.isDir && THUMB_CANDIDATES.has(extensionOf(entry.name));
  const [dataUrl, setDataUrl] = useState<string | null>(
    () => thumbCache.get(entry.path) ?? null,
  );

  useEffect(() => {
    if (!candidate) return;
    const known = thumbCache.get(entry.path);
    if (known !== undefined) {
      setDataUrl(known);
      return;
    }
    let mounted = true;
    const timer = setTimeout(() => {
      host
        .invoke<ThumbOut>("thumb.image", { path: entry.path, edge: THUMB_EDGE })
        .then((out) => {
          const url = out?.dataUrl ?? null;
          rememberThumb(entry.path, url);
          if (mounted) setDataUrl(url);
        })
        .catch(() => {
          rememberThumb(entry.path, null);
        });
    }, THUMB_SETTLE_MS);
    return () => {
      mounted = false;
      clearTimeout(timer);
    };
  }, [candidate, entry.path, host]);

  // 关掉的瞬间：effect 只是不再取图，缓存里的 dataUrl 还在 —— 渲染也必须看开关，
  // 否则已加载的缩略图会一直留在卡片上。
  return candidate && dataUrl ? (
    <img src={dataUrl} alt="" loading="lazy" style={thumbStyle} />
  ) : (
    <div style={thumbFallbackStyle}>
      <IconFor entry={entry} size={candidate ? 36 : entry.isDir ? 36 : 28} />
    </div>
  );
}

/** Parent directory of a path, accepting both separators. */
function parentOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx > 0 ? path.slice(0, idx) : path;
}

const extensionOf = (name: string): string => {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
};

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

/** `fs.list` already carries the mtime, so a column of dates costs no extra
 *  round-trips. Directories and providers without mtimes show nothing. */
function formatModified(ms: number | null): string {
  if (ms == null) return "";
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}



const paneStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  height: "100%",
  fontSize: 13,
};

const addressBarStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "10px 8px",
  flexShrink: 0,
};

const dirHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "7px 10px",
  flexShrink: 0,
  borderBottom: "1px solid var(--mantine-color-default-border)",
  background: "var(--mantine-color-default-hover)",
};

const scrollStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  position: "relative",
};

const rowHeaderStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 10px",
  height: 32,
};

const listRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 10px",
  height: 36,
  cursor: "pointer",
};

const cardsRowStyle: CSSProperties = {
  display: "grid",
  gap: 8,
  padding: "6px 0",
  height: CARD_ROW_HEIGHT,
};

const cardStyle: CSSProperties = {
  flex: `1 1 ${CARD_MIN_WIDTH}px`,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 4,
  padding: 9,
  minWidth: 0,
  borderRadius: "var(--mantine-radius-md)",
  border: "1px solid var(--mantine-color-default-border)",
  cursor: "pointer",
  overflow: "hidden",
};

/** Fixed-height picture slot: every card in a row lines up whether or not the
 *  thumbnail has arrived, so the virtualizer's estimate stays true. */
const thumbStyle: CSSProperties = {
  width: "100%",
  height: 82,
  objectFit: "cover",
  borderRadius: "var(--mantine-radius-sm)",
  flexShrink: 0,
  background: "var(--mantine-color-default-hover)",
};

const thumbFallbackStyle: CSSProperties = {
  width: "100%",
  height: 82,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: "var(--mantine-radius-sm)",
  flexShrink: 0,
  background: "var(--mantine-color-default-hover)",
};

const cellStyle: CSSProperties = {
  flexShrink: 0,
  width: 74,
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
};
