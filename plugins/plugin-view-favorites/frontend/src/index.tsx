/**
 * `plugin-view-favorites` — sidebar view (roadmap P6-48, P7-1), and the merged home of
 * what `plugin-file-nav` used to demo: 主页 + 常用位置 + 手动收藏 (docs/08 §5.3).
 *
 * Contributes an A icon and a `nav-panel:favorites` panel; the exclusive rendering is
 * `plugin-layout-views`' job. Favorites are this plugin's own data, kept in
 * localStorage — the base holds none (red line 2, docs/01 §6).
 *
 * Cascade role: publishes `sidebar:selection:changed` (B → C); reads the opaque
 * `focusRef` only to offer "＋ 焦点".
 *
 * P7-1 hardening (docs/plugin-functional/plugin-view-favorites.md):
 * - every stored `{path,kind,name}` is re-checked once with `fs.stat`, in the
 *   background so the first paint never waits for it; a dead path keeps its row,
 *   is labelled 路径已失效, and clicking it explains itself instead of failing
 *   silently;
 * - the same path can only appear once — re-adding updates name/kind in place;
 * - storage is schema-validated on read and try/catch'd on write, so a corrupt
 *   value degrades to a Chinese empty state with a recovery action instead of
 *   throwing, and a failed write says 「本次会话可用但不会记住」;
 * - results that arrive after the list changed, after unmount, or after the
 *   plugin was switched off are dropped (docs/09 §3.3, §6.2);
 * - P7-12: rows and the blank area request the shared context-menu panel
 *   (surfaces `favorites.item` / `favorites.empty`) and register the 打开 /
 *   在文件列表中定位 / 移除收藏 / 收藏当前焦点 actions; no menu is drawn here.
 */
import { Star } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { Badge, Button, Group, Loader, Stack, Text, UnstyledButton } from "@mantine/core";
import {
  Capabilities,
  Events,
  errorMessage,
  type ContextMenuContext,
  type HostMetaState,
  type PluginHost,
  type Ref,
  type SlotProps,
  type StatOut,
} from "@my-file-manager/plugin-sdk";

const VIEW_ID = "favorites";
const LS_KEY = "fm.view-favorites.v1";
/** Concurrent `fs.stat` calls per batch: a long list must not stampede the host. */
const STAT_BATCH = 3;
/** A removed row fades for this long before it leaves the list (docs/09 §3.2). */
const FADE_MS = 150;

interface Favorite {
  path: string;
  kind: string;
  name: string;
}

/** One stored path's existence, as decided by the background `fs.stat` pass. */
type PathStatus = "checking" | "valid" | "missing";

/** Why the panel cannot show what local storage holds. */
interface StorageIssue {
  type: "corrupt" | "unavailable";
  detail: string;
}

interface HomeState {
  state: "loading" | "ready" | "error";
  path?: string;
  detail?: string;
}

/** Anchor + trigger pair a row passes up when it wants the shared menu panel. */
type RowMenu = (anchor: { x: number; y: number }, trigger: "pointer" | "keyboard") => void;

/** A line the user must read. `detail` is prose for the hover title only. */
interface Notice {
  text: string;
  detail?: string;
  /** info = 只是回执；warn = 这一步没有按预期生效。 */
  tone?: "info" | "warn";
}

/** Bumped when the plugin is switched off: a component mounted by a previous
 *  activation must never call setState again, even if its promise lands now. */
let pluginGeneration = 0;

/** Teardown the loader runs on disable/unload (docs/02 §4.3). */
export function activate(): () => void {
  return () => {
    pluginGeneration += 1;
  };
}

const basename = (p: string): string => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 && idx < p.length - 1 ? p.slice(idx + 1) : p;
};

/** Structural check of one stored element; null when it is not a usable
 *  `{path,kind,name}` record. */
function parseFavorite(raw: unknown): Favorite | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.path !== "string" || !o.path.trim()) return null;
  if (typeof o.kind !== "string" || !o.kind.trim()) return null;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  return { path: o.path, kind: o.kind, name: name || basename(o.path) };
}

/** Local-storage read plus schema validation. Never throws: anything wrong comes
 *  back as an issue the panel renders as a Chinese empty state. */
function readStore(): { favorites: Favorite[] } | { issue: StorageIssue } {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LS_KEY);
  } catch (err) {
    return { issue: { type: "unavailable", detail: `无法读取本地存储：${errorMessage(err)}` } };
  }
  if (raw === null || raw === "") return { favorites: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { issue: { type: "corrupt", detail: `收藏数据无法解析：${errorMessage(err)}` } };
  }
  if (!Array.isArray(parsed)) {
    return { issue: { type: "corrupt", detail: "收藏数据的结构不是列表" } };
  }
  const favorites: Favorite[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const fav = parseFavorite(item);
    if (!fav) {
      return { issue: { type: "corrupt", detail: "收藏列表里有一条记录字段不完整" } };
    }
    // Dedup on read as well: an older build could store the same path twice.
    if (seen.has(fav.path)) continue;
    seen.add(fav.path);
    favorites.push(fav);
  }
  return { favorites };
}

/** Null on success, otherwise why the write failed. */
function writeStore(list: Favorite[]): string | null {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    return null;
  } catch (err) {
    return `写入本地存储失败：${errorMessage(err)}`;
  }
}

function clearStore(): string | null {
  try {
    localStorage.removeItem(LS_KEY);
    return null;
  } catch (err) {
    return `清除本地存储失败：${errorMessage(err)}`;
  }
}

/** One `fs.stat` round trip -> the entry's status. A rejection means the path is
 *  gone; a type contradiction means the record no longer matches what is there. */
async function checkPath(
  host: PluginHost,
  fav: Favorite,
): Promise<{ path: string; status: PathStatus }> {
  try {
    const out = await host.invoke<StatOut>(Capabilities.fsStat, { path: fav.path });
    const expectDir = fav.kind === "folder" ? true : fav.kind === "file" ? false : null;
    const mismatch = expectDir !== null && out.isDir !== expectDir;
    return { path: fav.path, status: mismatch ? "missing" : "valid" };
  } catch {
    return { path: fav.path, status: "missing" };
  }
}

export function RailIcon({ host }: SlotProps) {
  const [active, setActive] = useState(host.getState().activeSidebarView === VIEW_ID);
  useEffect(
    () => host.onStateChange((s) => setActive(s.activeSidebarView === VIEW_ID)),
    [host],
  );
  return (
    <button
      type="button"
      className="fm-rail-button"
      aria-label="收藏"
      aria-pressed={active}
      title="收藏"
      onClick={() => host.emit(Events.sidebarViewChanged, { viewId: VIEW_ID })}
      style={railButtonStyle(active)}
    >
      <Star size={19} />
    </button>
  );
}

export function FavoritesPanel({ host }: SlotProps) {
  // —— 生命周期闸门：卸载或插件停用之后，任何异步结果都不再写状态 ——
  // Declared first so its effect runs before the ones below.
  const alive = useRef(false);
  const generation = useRef(pluginGeneration);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const [meta, setMeta] = useState<HostMetaState>(() => host.getState());
  /** 首屏：列表在第一次渲染时就同步读自本地存储并通过结构校验，
   *  路径是否存在交给下面的后台效应，任何能力调用都不阻塞这一屏。 */
  const [stored] = useState(readStore);
  const [favorites, setFavorites] = useState<Favorite[]>(
    "favorites" in stored ? stored.favorites : [],
  );
  const [issue, setIssue] = useState<StorageIssue | null>("issue" in stored ? stored.issue : null);
  const [writeHint, setWriteHint] = useState<string | null>(null);
  const [status, setStatus] = useState<Record<string, PathStatus>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [home, setHome] = useState<HomeState>({ state: "loading" });
  const [homeAttempt, setHomeAttempt] = useState(0);
  const [ghosts, setGhosts] = useState<Favorite[]>([]);
  const [recheck, setRecheck] = useState(0);

  /** Refs the async callbacks read, so they see the latest list instead of the
   *  one captured when the callback was created. */
  const listRef = useRef<Favorite[]>(favorites);
  listRef.current = favorites;
  const statusRef = useRef<Record<string, PathStatus>>(status);
  const nonceRef = useRef(0);
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
    },
    [],
  );

  const live = (): boolean => alive.current && generation.current === pluginGeneration;

  /** Replace the status map, pruning paths that are no longer listed: an expired
   *  validation result can never overwrite what the list already says. */
  const writeStatus = (patch: Record<string, PathStatus>): void => {
    const listed = new Set(listRef.current.map((f) => f.path));
    const next: Record<string, PathStatus> = {};
    for (const [path, s] of Object.entries(statusRef.current)) {
      if (listed.has(path)) next[path] = s;
    }
    for (const [path, s] of Object.entries(patch)) {
      if (listed.has(path)) next[path] = s;
    }
    statusRef.current = next;
    if (live()) setStatus(next);
  };

  useEffect(
    () =>
      host.onStateChange((s) => {
        if (live()) setMeta(s);
      }),
    [host],
  );

  // —— 主页路径：fs.home 的加载中/成功/失败各自有独立状态与重试 ——
  useEffect(() => {
    let cancelled = false;
    if (live()) setHome({ state: "loading" });
    host
      .invoke<string>(Capabilities.fsHome)
      .then((h) => {
        if (!cancelled && live()) setHome({ state: "ready", path: String(h) });
      })
      .catch((err) => {
        if (!cancelled && live()) setHome({ state: "error", detail: errorMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [host, homeAttempt]);

  // —— 后台一次性校验：只补没查过的路径；「重新校验」清空重跑 ——
  const pathsKey = useMemo(() => favorites.map((f) => f.path).join("\u0000"), [favorites]);
  useEffect(() => {
    const fresh = nonceRef.current !== recheck;
    nonceRef.current = recheck;
    const base = fresh ? {} : statusRef.current;
    // "checking" is not a result: an in-flight pass cancelled by a re-mount or a
    // list change must be re-issued, otherwise those rows stay 载入中 forever.
    const pending = listRef.current.filter(
      (f) => base[f.path] !== "valid" && base[f.path] !== "missing",
    );
    if (fresh && !pending.length) {
      writeStatus({});
      return;
    }
    if (!pending.length) {
      // 路径集合变短时只需剔除失效条目已有状态。
      writeStatus(base);
      return;
    }
    const checking: Record<string, PathStatus> = { ...base };
    for (const f of pending) checking[f.path] = "checking";
    writeStatus(checking);

    let cancelled = false;
    void (async () => {
      for (let i = 0; i < pending.length; i += STAT_BATCH) {
        const batch = pending.slice(i, i + STAT_BATCH);
        const results = await Promise.all(batch.map((f) => checkPath(host, f)));
        if (cancelled || !live()) return;
        writeStatus(Object.fromEntries(results.map((r) => [r.path, r.status])));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, pathsKey, recheck]);

  /** 正在淡出的行：仍留在界面上，但已经不在列表与存储里，因此不可再点。 */
  const ghostSet = useMemo(() => new Set(ghosts.map((g) => g.path)), [ghosts]);

  /** The single mutation path: state first, storage second, so a write failure
   *  never blocks the session (docs/09 §7). */
  const commit = (next: Favorite[]): void => {
    listRef.current = next;
    setFavorites(next);
    const failed = writeStore(next);
    if (failed) setWriteHint(failed);
    else {
      setWriteHint(null);
      setIssue(null);
    }
  };

  const addFocus = (): void => {
    const ref = host.getState().focusRef;
    const path = ref?.id;
    if (!path) return;
    const kind = ref.kind || "file";
    const name = basename(path);
    const list = listRef.current;
    // 同一路径只保留一条：存在就地更新 name/kind，不存在才追加。
    const exists = list.some((f) => f.path === path);
    const next = exists
      ? list.map((f) => (f.path === path ? { ...f, kind, name } : f))
      : [...list, { path, kind, name }];
    commit(next);
    setNotice(
      exists
        ? { text: "该路径已在收藏中，已更新它的名称与类型。", detail: path, tone: "info" }
        : { text: "已加入收藏。", detail: path, tone: "info" },
    );
  };

  /** 移除是无副作用操作：先立刻落盘并更新列表，再让那一行淡出 150ms。
   *  切走视图导致组件卸载时，数据已经保存，淡出只是残留的视觉效果。 */
  const remove = (fav: Favorite): void => {
    if (ghostSet.has(fav.path)) return;
    const next = listRef.current.filter((f) => f.path !== fav.path);
    if (next.length === listRef.current.length) return;
    commit(next);
    setNotice((prev) => (prev?.detail === fav.path ? null : prev));
    setGhosts((prev) => [...prev, fav]);
    const timer = window.setTimeout(() => {
      timers.current = timers.current.filter((t) => t !== timer);
      if (live()) setGhosts((prev) => prev.filter((g) => g.path !== fav.path));
    }, FADE_MS);
    timers.current.push(timer);
  };

  const open = (fav: Favorite): void => {
    if (ghostSet.has(fav.path)) return;
    if (status[fav.path] === "missing") {
      setNotice({
        text: "该收藏指向的路径已经失效，无法打开。可以点击「移除」清理，或到文件列表里重新收藏新位置。",
        detail: fav.path,
        tone: "warn",
      });
      return;
    }
    setNotice(null);
    host.emit(Events.sidebarSelectionChanged, {
      kind: fav.kind,
      id: fav.path,
      sourcePlugin: host.name,
    } satisfies Ref);
  };

  // —— 右键菜单（P7-12）：项只随挂载注册一次，动作永远读最新状态 ——
  /** The freshest handler bundle for the menu's `execute` callbacks: a menu
   *  action must never act on the snapshot captured when it was registered. */
  const actionsRef = useRef({ open, remove, addFocus });
  actionsRef.current = { open, remove, addFocus };

  const refOf = (kind: string, id: string): Ref => ({
    kind,
    id,
    sourcePlugin: host.name,
  });

  const menuContext = (
    surfaceId: string,
    targetKind: string | null,
    targetRef: Ref | null,
    anchor: { x: number; y: number },
    trigger: "pointer" | "keyboard",
  ): ContextMenuContext => ({
    surfaceId,
    targetKind,
    targetRef,
    selectedRefs: targetRef ? [targetRef] : [],
    sessionId: host.getState().activeTabId,
    anchor,
    trigger,
  });

  /** 右键/键盘菜单键：目标不是当前活动行时，先走左键那套收敛，再请共享面板打开。 */
  const openRowMenu =
    (fav: Favorite | null, path: string, kind: string): RowMenu =>
    (anchor, trigger) => {
      const cm = host.contextMenu;
      if (!cm) return;
      if (selection?.id !== path) {
        if (fav) open(fav);
        else host.emit(Events.sidebarSelectionChanged, refOf(kind, path));
      }
      cm.open(menuContext("favorites.item", kind, refOf(kind, path), anchor, trigger));
    };

  const openEmptyMenu = (anchor: { x: number; y: number }, trigger: "pointer" | "keyboard"): void => {
    host.contextMenu?.open(menuContext("favorites.empty", null, null, anchor, trigger));
  };

  useEffect(() => {
    const cm = host.contextMenu;
    if (!cm) return;
    const isItem = (ctx: ContextMenuContext): boolean => ctx.surfaceId === "favorites.item";
    const unregisters = [
      cm.registerItem({
        id: "favorites.open",
        label: "打开",
        order: 10,
        when: isItem,
        execute: (ctx) => {
          const ref = ctx.targetRef;
          if (!ref) return;
          const fav = listRef.current.find((f) => f.path === ref.id);
          // 与左键完全一致：收藏行走 open（含失效守卫与中文提示），主页行走其自身的选中事件。
          if (fav) actionsRef.current.open(fav);
          else host.emit(Events.sidebarSelectionChanged, ref);
        },
      }),
      cm.registerItem({
        id: "favorites.reveal",
        label: "在文件列表中定位",
        order: 20,
        when: isItem,
        execute: (ctx) => {
          const ref = ctx.targetRef;
          if (!ref) return;
          // 行点击今天就是发这条协调事件；不引入新的能力调用。
          host.emit(Events.sidebarSelectionChanged, {
            kind: ref.kind,
            id: ref.id,
            sourcePlugin: host.name,
          } satisfies Ref);
        },
      }),
      cm.registerItem({
        id: "favorites.remove",
        label: "移除收藏",
        order: 30,
        when: (ctx) => {
          const id = ctx.targetRef?.id ?? "";
          return isItem(ctx) && listRef.current.some((f) => f.path === id);
        },
        execute: (ctx) => {
          const id = ctx.targetRef?.id ?? "";
          const fav = listRef.current.find((f) => f.path === id);
          if (fav) actionsRef.current.remove(fav);
        },
      }),
      cm.registerItem({
        id: "favorites.addFocus",
        label: "收藏当前焦点",
        order: 10,
        when: (ctx) => ctx.surfaceId === "favorites.empty",
        // 无焦点时置灰而非隐藏，与工具栏「＋ 焦点」按钮的行为一致。
        enabled: () => Boolean(host.getState().focusRef?.id),
        execute: () => {
          actionsRef.current.addFocus();
        },
      }),
    ];
    return () => {
      for (const off of unregisters) off();
    };
  }, [host]);

  const resetCorrupt = (): void => {
    const failed = clearStore();
    if (failed) {
      // 存储写不回去：保持原样，只说明本次会话的改动不会被记住。
      setWriteHint(`${failed}：收藏本次会话可用但不会记住。`);
      return;
    }
    statusRef.current = {};
    listRef.current = [];
    setStatus({});
    setFavorites([]);
    setIssue(null);
    setWriteHint(null);
    setNotice({ text: "已清除无法解析的收藏数据，可以重新收藏。" });
  };

  const focusPath = meta.focusRef?.id ?? "";
  const selection = meta.sidebarSelection;
  /** Narrowed once so the row's callbacks see a definite path (never undefined). */
  const homeRow = home.state === "ready" ? (home.path ?? "") : "";

  return (
    <div
      className="fm-nav-panel"
      style={panelStyle}
      onContextMenu={(event) => {
        // 空白区/空列表：浏览器默认菜单永不出现，只请共享面板。
        if (!host.contextMenu) return;
        event.preventDefault();
        openEmptyMenu({ x: event.clientX, y: event.clientY }, "pointer");
      }}
    >
      <Group className="fm-nav-heading" gap={6} wrap="nowrap" justify="space-between">
        <Text component="span" size="xs" fw={650}>
          收藏 / 常用位置
        </Text>
        <Group gap={4} wrap="nowrap">
          <Button
            size="compact-xs"
            variant="default"
            onClick={addFocus}
            disabled={!focusPath}
            title={focusPath ? `收藏当前焦点：${focusPath}` : "先在右侧选中一个文件或文件夹"}
            aria-label="将当前焦点加入收藏"
          >
            ＋ 焦点
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => setRecheck((n) => n + 1)}
            title="重新检查所有收藏路径是否还在"
            aria-label="重新校验收藏路径"
          >
            重新校验
          </Button>
        </Group>
      </Group>

      {notice && (
        <Group gap={6} wrap="nowrap" align="flex-start">
          <Text
            size="xs"
            style={{ flex: 1, minWidth: 0 }}
            title={notice.detail}
            c={notice.tone === "warn" ? "yellow" : "dimmed"}
          >
            {notice.text}
          </Text>
          <UnstyledButton
            type="button"
            aria-label="关闭提示"
            title="关闭提示"
            style={closeStyle}
            onClick={() => setNotice(null)}
          >
            ✕
          </UnstyledButton>
        </Group>
      )}

      {issue && (
        <Stack gap={2}>
          <Text size="xs" c="red">
            {issue.type === "corrupt"
              ? "收藏数据无法解析，本地保存的内容已损坏，当前没有可显示的收藏。"
              : "本地存储不可用：收藏本次会话可用但不会记住。"}
          </Text>
          {issue.type === "corrupt" && (
            <>
              <Text size="xs" c="dimmed" title={issue.detail}>
                可以清除这批数据后重新开始收藏，此前的收藏将无法恢复。
              </Text>
              <Group gap={6}>
                <Button size="compact-xs" variant="light" color="red" onClick={resetCorrupt}>
                  清除损坏数据
                </Button>
              </Group>
            </>
          )}
          {issue.type === "unavailable" && (
            <Text size="xs" c="dimmed" title={issue.detail}>
              列表仍可用，只是关掉本页后不会保留。
            </Text>
          )}
        </Stack>
      )}

      {writeHint && (
        <Text size="xs" c="orange" title={writeHint}>
          存储写入失败：收藏改动本次会话可用但不会记住。
        </Text>
      )}

      {home.state === "loading" && (
        <Group gap={6}>
          <Loader size={12} />
          <Text size="xs" c="dimmed">
            正在读取主页位置…
          </Text>
        </Group>
      )}
      {home.state === "error" && (
        <Group gap={6} wrap="nowrap">
          <Text size="xs" c="red" style={{ flex: 1, minWidth: 0 }} title={home.detail}>
            主页位置读取失败。
          </Text>
          <Button size="compact-xs" variant="subtle" onClick={() => setHomeAttempt((n) => n + 1)}>
            重试
          </Button>
        </Group>
      )}
      {homeRow && (
        <Row
          icon="⌂"
          name={basename(homeRow) || homeRow}
          path={homeRow}
          status="valid"
          faded={false}
          active={selection?.id === homeRow}
          onOpen={() =>
            host.emit(Events.sidebarSelectionChanged, {
              kind: "folder",
              id: homeRow,
              sourcePlugin: host.name,
            } satisfies Ref)
          }
          onMenu={
            host.contextMenu ? openRowMenu(null, homeRow, "folder") : undefined
          }
        />
      )}

      {[...favorites, ...ghosts.filter((g) => !favorites.some((f) => f.path === g.path))].map(
        (f) => {
          const ghost = ghostSet.has(f.path);
          return (
            <Row
              key={f.path}
              icon={f.kind === "folder" ? "📁" : "📄"}
              name={f.name}
              path={f.path}
              status={ghost ? "valid" : (status[f.path] ?? "checking")}
              faded={ghost}
              active={selection?.id === f.path && selection?.kind === f.kind}
              onOpen={() => open(f)}
              onRemove={() => remove(f)}
              onMenu={host.contextMenu ? openRowMenu(f, f.path, f.kind) : undefined}
            />
          );
        },
      )}

      {!favorites.length && !ghosts.length && !issue && (
        <Text size="xs" c="dimmed">
          还没有收藏。在右侧选中文件或文件夹后，点击上方「＋ 焦点」即可加入常用位置。
        </Text>
      )}
    </div>
  );
}

/** One list row: the open affordance and the remove affordance are separate
 *  buttons, and removal stops propagation so it can never look like navigation.
 *  `onMenu` (when the shared panel is granted) turns right-click and the
 *  keyboard menu key into a panel request on this row; without it the row
 *  behaves exactly as before. */
function Row({
  icon,
  name,
  path,
  status,
  faded,
  active,
  onOpen,
  onRemove,
  onMenu,
}: {
  icon: ReactNode;
  name: string;
  path: string;
  status: PathStatus;
  faded: boolean;
  active: boolean;
  onOpen: () => void;
  onRemove?: () => void;
  onMenu?: RowMenu;
}) {
  const invalid = status === "missing";
  return (
    <Group
      className="fm-nav-row"
      gap={4}
      wrap="nowrap"
      style={{ opacity: faded ? 0 : 1, transition: `opacity ${FADE_MS}ms ease` }}
      onContextMenu={
        onMenu
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!faded) onMenu({ x: event.clientX, y: event.clientY }, "pointer");
            }
          : undefined
      }
    >
      <UnstyledButton
        type="button"
        onClick={onOpen}
        disabled={faded}
        title={path}
        aria-label={invalid ? `${name}（路径已失效）` : name}
        style={rowButtonStyle(active, invalid)}
        onKeyDown={
          onMenu
            ? (event) => {
                if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                  event.preventDefault();
                  if (faded) return;
                  const rect = event.currentTarget.getBoundingClientRect();
                  onMenu({ x: rect.left + 12, y: rect.bottom }, "keyboard");
                }
              }
            : undefined
        }
      >
        <Text component="span" size="xs" style={{ marginRight: 6, flexShrink: 0 }}>
          {icon}
        </Text>
        <Text component="span" size="xs" truncate style={{ minWidth: 0, flex: 1 }}>
          {name}
        </Text>
      </UnstyledButton>
      {status === "checking" && <Loader size={12} aria-label="正在检查路径" />}
      {invalid && (
        <Badge size="xs" variant="light" color="red" title={`路径已失效：${path}`}>
          路径已失效
        </Badge>
      )}
      {onRemove && (
        <Button
          size="compact-xs"
          variant="subtle"
          className="fm-nav-action"
          disabled={faded}
          title={`从收藏中移除：${path}`}
          aria-label="移除该收藏"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          移除
        </Button>
      )}
    </Group>
  );
}

const railButtonStyle = (active: boolean): CSSProperties => ({
  display: "block",
  width: 40,
  height: 40,
  margin: "2px auto",
  fontSize: 16,
  cursor: "pointer",
  borderRadius: "var(--mantine-radius-md)",
  border: "none",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
});

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
};

const rowButtonStyle = (active: boolean, invalid: boolean): CSSProperties => ({
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  textAlign: "left",
  padding: "7px 6px",
  cursor: "pointer",
  border: "none",
  borderRadius: "var(--mantine-radius-sm)",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
  color: invalid
    ? "var(--mantine-color-dimmed)"
    : "var(--mantine-color-text)",
  overflow: "hidden",
});

const closeStyle: CSSProperties = {
  cursor: "pointer",
  fontSize: 11,
  lineHeight: "18px",
  padding: "0 4px",
  borderRadius: "var(--mantine-radius-sm)",
  color: "var(--mantine-color-dimmed)",
  flexShrink: 0,
};
