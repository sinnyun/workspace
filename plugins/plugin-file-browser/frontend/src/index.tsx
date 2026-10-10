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
 * file refs navigate) and publishes `focus:changed` for D. `kind` is plugin-side
 * vocabulary, so this plugin declares the set it understands (P7-9): the shipped
 * producers (`plugin-view-file-tree`, `plugin-view-favorites`, `plugin-mock-data`)
 * all emit `"folder"` / `"file"`, so `"folder"` is the directory literal here (the
 * `"directory"` wording in docs/09 §6.3 has no producer). A `"tag"` ref resolves
 * through the shared `db.tags` store (P7-32, SDK `listTags`) into a tag view whose
 * history item is the encoded string `tag://<name>` — the stack stays plain strings,
 * so back/forward and per-pane memory work on a tag view exactly like on a directory.
 * Any other kind is NOT navigated and never guessed (docs/09 §4: an owner resolves a
 * reference it cannot interpret): the pane shows a visible Chinese notice instead of
 * staying silent.
 *
 * Tags (P7-32): a path→tags index (one `db.tags.list` read, refreshed on
 * `tags:updated`) feeds chips on list rows, grid cards and the table's 标签 column;
 * clicking a chip opens the same tag view the sidebar ref does. The view renders tag
 * members as synthetic entries (size/mtime stay blank — filling them would mean one
 * `fs.stat` per member) and re-queries on `tags:updated`, so writes anywhere in the
 * tags UI show up here without polling.
 *
 * Async correctness (docs/09 §3.3, §6.2, §9.1 — P7-7/P7-8):
 * - every `fs.list` carries a locally incremented sequence number plus its
 *   `{path, session, pane}` identity; a response is accepted only when all four
 *   still match, otherwise it is dropped, so rapid directory switching can never
 *   flash back stale rows. Off-screen/unmounted cards drop their thumbnails the same
 *   way, additionally keyed on the file version (size + mtime).
 * - read failures are classified (无权限 / 目录消失 / 路径无效 / 读取失败) with a
 *   distinct Chinese reason and executable actions, never a generic "加载失败";
 *   an empty directory keeps its own Chinese empty state.
 * - the history stack advances only on an explicit navigation that settled into
 *   success or an explicit error state — never per keystroke; refresh replaces the
 *   current entry; re-selecting the current path is an explicit refresh and creates
 *   no duplicate entry.
 *
 * Ordering and file metadata come from the provider: `fs.list` arrives naturally
 * sorted with sizes and mtimes, so a 500k directory costs one pass here instead of
 * a UI-thread sort. Grid thumbnails are pulled per visible card through the gated
 * `shell.thumbnail.read` capability — the Windows Shell's own picture, never a raw
 * file URL and never an image this plugin draws — and cached plugin-side.
 *
 * It also owns its own preferences (default view mode, thumbnail switch) under
 * `fm.file-browser.prefs.v1` and contributes the matching settings page to
 * `plugin-settings`' floating panel — plugin-local state, never base state.
 *
 * Context menu (roadmap P7-12): the browser never draws its own menu. Rows,
 * cards and the blank file area (empty/error states included) open the SHARED
 * panel on the stable surfaces `browser.list.item` / `browser.grid.item` /
 * `browser.empty`, and the plugin contributes only the directory-level
 * navigation/selection items (`browser.refresh`, `browser.selectAll`). Real file
 * operations belong to `plugin-file-ops`. Without the manifest grant (no
 * `host.contextMenu`) every handler stays completely inert — no preventDefault,
 * no swallowed native menu.
 */

import {
  ActionIcon,
  Alert,
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
import {
  Capabilities,
  type ContextMenuContext,
  Events,
  errorMessage,
  formatDate,
  formatSize,
  type ListEntry,
  listTags,
  type PluginHost,
  type Ref,
  type ShellThumbnailOut,
  type SlotProps,
  slotPrefix,
} from "@my-file-manager/plugin-sdk";
import {
  type ColumnVisibilityState,
  columnVisibilityFeature,
  createColumnHelper,
  createSortedRowModel,
  functionalUpdate,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronDown,
  CircleAlert,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Folder,
  FolderX,
  LayoutGrid,
  List,
  RefreshCw,
  Table,
} from "lucide-react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createToolbarStore } from "./toolbar-store";

const PLUGIN_NAME = "plugin-file-browser";
const PANE_PREFIX = "pane-slot";
/** Per-session, per-pane memory. `plugin-layout-panes` rebuilds its panes when the
 *  browsing session changes, so a pane's path and view mode are restored here rather
 *  than leaked through a shared instance (docs/01 §9.1). */
const LS_KEY = "fm.file-browser.v1";
const CARD_MIN_WIDTH = 150;
/** 行高预算：缩略图 82 + 名称 + 标签 chips 一行 + 底部属性行（底部行有 marginTop:auto，
 *  没有标签的卡片把余量留成空白，同一行的卡片高度仍然整齐）。 */
const CARD_ROW_HEIGHT = 168;
/** Longest edge asked of `shell.thumbnail.read`; a card shows ~96px. */
const THUMB_EDGE = 96;
/** Extensions worth asking the Windows Shell about. Formats a machine may have no
 *  handler for (svg / heic / raw / mkv) stay in on purpose: their `unsupported-type`
 *  answer is what puts the icon back, so that path gets exercised too. */
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
  "mp4",
  "mov",
  "mkv",
]);
/** Wait before pulling, so a fast flick never queues a Shell call per scrolled past row. */
const THUMB_SETTLE_MS = 80;
/** Grid cards hold their thumbnail here for the whole session, so scrolling back is
 *  free. Bounded: a lost thumbnail is just an icon, a leaked one is hundreds of MB. */
const THUMB_CACHE_MAX = 3000;

type ViewMode = "list" | "grid" | "table";

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
  /** 表格模式的可选列（大小/修改时间/类型）。缺省=显示，显式 `false` 才隐藏，
   *  与 react-table 的可见性口径一致；名称不可隐藏，所以不在这张表里。 */
  tableColumns: ColumnVisibilityState;
}

const DEFAULT_PREFS: Prefs = { defaultMode: "grid", thumbnails: true, tableColumns: {} };

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

  // chips 的索引是模块级共享状态：加载时建一次，标签存储每次写入（写者成功、
  // 失败都会发）重建一次（P7-32）。订阅随插件卸载一起回收。
  rebuildTagIndex(host);
  const offTagsUpdated = host.on(Events.tagsUpdated, () => rebuildTagIndex(host));

  return () => {
    offRegistered();
    offDisposed();
    offTagsUpdated();
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
            { value: "table", label: "表格" },
          ]}
        />
      </div>
      <div>
        <Text size="sm" fw={600}>
          表格列
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          名称一列始终显示；大小、修改时间、类型可以在表头点一下排序，标签列只做展示。
        </Text>
        <Group gap={10} wrap="nowrap">
          {TABLE_TOGGLE_COLUMNS.map((column) => (
            <Group key={column.id} gap={6} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
              <Text size="xs">{column.label}</Text>
              <Switch
                size="xs"
                checked={current.tableColumns[column.id] !== false}
                aria-label={`显示${column.label}列`}
                onChange={(e) =>
                  patchPrefs({
                    tableColumns: {
                      ...current.tableColumns,
                      [column.id]: e.currentTarget.checked,
                    },
                  })
                }
              />
            </Group>
          ))}
        </Group>
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

// ─────────────────── 侧栏 Ref：本插件认识的 kind（P7-9） ───────────────────

/** 目录引用的字面量。发货端全部用 `"folder"`：`plugin-view-file-tree`
 *  (`kind: n.isDir ? "folder" : "file"`)、`plugin-view-favorites`、`plugin-mock-data`
 *  以及本插件自己发布的 focus Ref，所以认识的集合就是 folder / file。 */
const DIR_KIND = "folder";
const FILE_KIND = "file";
/** `plugin-view-tags` 发布的标签引用（P7-32）：经共享 `db.tags` 存储解析为
 *  tag:// 视图，不再是不认识的 kind。 */
const TAG_KIND = "tag";

// ─────────────────── 右键 surface 稳定 id（P7-12） ───────────────────

/** 共享菜单面板（plugin-context-menu）按这些 id 过滤贡献项；manifest 的
 *  `permissions.contextMenu.open` 逐字列出同样的三个 id。列表行、网格卡片、
 *  文件区空白（含空态与错误态）各自一个 surface，本插件不自绘菜单。 */
const SURFACE_LIST = "browser.list.item";
const SURFACE_GRID = "browser.grid.item";
const SURFACE_EMPTY = "browser.empty";

// ─────────────────── 错误分类（P7-8） ───────────────────

type DirectoryErrorKind = "permission" | "missing" | "invalid" | "read";

interface DirectoryError {
  kind: DirectoryErrorKind;
  /** 面向用户的中文原因：不同类别不同说法，绝不是一句通用"加载失败"。 */
  title: string;
  /** 现在能做什么。 */
  advice: string;
  /** 再试一次是否有意义（决定"重试"按钮是否出现）。 */
  retryable: boolean;
  /** provider 原话，作为次级说明展示，便于判断根因。 */
  detail: string;
}

/** 把能力层的报错文本归到四类之一。判据是 `fs.list` 的 `errorMessage` 语义：
 *  Rust 侧 `CapabilityError::PermissionDenied` / not-found / invalid path 各自带
 *  英文原文与 os error 码，dev mock 的 `/stress/读取失败` 只说"模拟读取失败"。 */
function classifyDirectoryError(detail: string): DirectoryError {
  const text = detail.toLowerCase();
  const has = (...needles: string[]): boolean => needles.some((n) => text.includes(n));
  if (has("permission", "denied", "access denied", "unauthorized", "eacces", "拒绝", "权限", "os error 5")) {
    return {
      kind: "permission",
      title: "没有访问权限",
      advice: "当前账户无法读取这个文件夹。可以稍后重试，或返回上级换一个能打开的位置。",
      retryable: true,
      detail,
    };
  }
  if (
    has(
      "not found",
      "no such file",
      "cannot find",
      "does not exist",
      "missing",
      "enoent",
      "os error 2",
      "找不到",
      "不存在",
      "已删除",
      "已被删除",
      "消失",
    )
  ) {
    return {
      kind: "missing",
      title: "文件夹已不存在或已被移动",
      advice: "这个目录可能已被删除或改名。返回上级，或在地址栏选择其他目录。",
      retryable: false,
      detail,
    };
  }
  if (
    has(
      "invalid",
      "malformed",
      "not a directory",
      "is a directory",
      "name too long",
      "emlink",
      "enosys",
      "os error 123",
      "os error 161",
      "无效",
      "不合法",
      "格式",
      "不是文件夹",
    )
  ) {
    return {
      kind: "invalid",
      title: "路径无效，无法打开",
      advice: "地址栏里的路径不是可用的目录路径。修正地址后可以重新进入。",
      retryable: false,
      detail,
    };
  }
  return {
    kind: "read",
    title: "读取该文件夹时出错",
    advice: "可能是设备未就绪或临时故障。重试一次，或返回上级、选择其他目录。",
    retryable: true,
    detail,
  };
}

/** 标签视图的错误不是目录错误：不说"文件夹"，把"标签没了"和"标签读不出来"分开说。 */
function classifyTagError(name: string, detail: string): DirectoryError {
  if (detail.includes("找不到")) {
    return {
      kind: "missing",
      title: `标签「${name}」已不存在`,
      advice: "它可能已被删除或改名。重试可以重新读取；后退或地址栏也能回到原来的位置。",
      retryable: true,
      detail,
    };
  }
  return {
    kind: "read",
    title: `读取标签「${name}」失败`,
    advice: "标签数据暂时读不出来，这不代表标签被删了。重试一次；后退或地址栏可以换个位置。",
    retryable: true,
    detail,
  };
}

// ─────────────────── 路径与地址栏校验（P7-8） ───────────────────

/** 统一分隔符并去掉尾部斜杠，用于比较与写栈；根路径保持原样。 */
function normalizePath(input: string): string {
  const trimmed = input.trim().replace(/\\/g, "/");
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

/** 标签视图的栈项编码（P7-32）：历史栈是纯字符串，`tag://<encodeURIComponent(name)>`
 *  把"这是标签视图，不是目录"带进栈项本身，后退/前进/每栏记忆因此不需要任何新机制。
 *  encodeURIComponent 不会产出反斜杠或尾部斜杠，normalizePath 对它无害。 */
const TAG_SCHEME = "tag://";

function encodeTagPath(name: string): string {
  return `${TAG_SCHEME}${encodeURIComponent(name)}`;
}

/** 解码视图项；不是标签视图或编码损坏时返回 null（当作普通路径处理）。 */
function decodeTagPath(path: string): string | null {
  if (!path.startsWith(TAG_SCHEME)) return null;
  try {
    return decodeURIComponent(path.slice(TAG_SCHEME.length));
  } catch {
    return null;
  }
}

/** 视图路径 → 用户可读的名字：标签视图是"标签「X」"，内部编码不进界面文案。 */
function viewLabelOf(path: string): string {
  const tag = decodeTagPath(path);
  return tag === null ? path : `标签「${tag}」`;
}

/** 地址栏 Enter 的校验：失败时保留原路径、不写历史，只在输入框下方说明原因。 */
function validateAddress(input: string): { ok: true; path: string } | { ok: false; reason: string } {
  const path = normalizePath(input);
  if (!path) return { ok: false, reason: "请输入目录路径" };
  const absolute = path === "/" || path.startsWith("/") || /^[a-z]:\//i.test(path);
  if (!absolute) return { ok: false, reason: "请输入从根开始的完整路径，例如 /stress 或 D:/资料" };
  return { ok: true, path };
}

/** 引用对象是否就在 `dir` 这一层可见目录里（09 §4：不在就要把焦点作废）。 */
function isInDirectory(target: string, dir: string): boolean {
  if (!target || !dir) return false;
  const a = normalizePath(target);
  const b = normalizePath(dir);
  return a === b || parentOf(a) === b;
}

// ─────────────────── 标签索引与标签视图数据（P7-32 契约消费方） ───────────────────

/** 路径 → 标签名。一次性从 `db.tags.list` 重建，`tags:updated` 时重来一遍；
 *  短命但有界（标签数量级远小于目录条目），所以全量重建比增量维护简单得多。
 *  Map 引用在重建时整体替换，useSyncExternalStore 的快照比较因此成立。 */
let tagIndex = new Map<string, string[]>();
const tagIndexListeners = new Set<() => void>();
let tagIndexSeq = 0;

/** 读不到标签（无授权 / 存储不可用）只是没有 chips，不影响目录浏览：保持旧索引。 */
function rebuildTagIndex(host: PluginHost): void {
  const seq = ++tagIndexSeq;
  listTags(host).then(
    (tags) => {
      if (seq !== tagIndexSeq) return;
      const next = new Map<string, string[]>();
      for (const rec of tags) {
        for (const m of rec.members) {
          const key = normalizePath(m.path);
          const names = next.get(key);
          if (names) names.push(rec.name);
          else next.set(key, [rec.name]);
        }
      }
      tagIndex = next;
      for (const cb of tagIndexListeners) cb();
    },
    () => {},
  );
}

function useTagIndex(): Map<string, string[]> {
  return useSyncExternalStore(
    (cb) => {
      tagIndexListeners.add(cb);
      return () => {
        tagIndexListeners.delete(cb);
      };
    },
    () => tagIndex,
  );
}

/** 表格单元格画在模块级的列表定义里，拿不到组件 props，所以经这个只读入口取
 *  当前索引；订阅由 TableView 的 useTagIndex 负责，索引一变整表重渲。 */
function tagsForEntry(path: string): string[] {
  return tagIndex.get(normalizePath(path)) ?? [];
}

/** 标签视图的数据源：把成员合成为合成条目。大小/修改时间留空不是偷懒 ——
 *  成员记录里本来就没有这些字段，补齐它们要每个成员一次 `fs.stat`，
 *  那正是"列目录不逐项 stat"要避免的成本。 */
async function loadTagMembers(host: PluginHost, name: string): Promise<ListEntry[]> {
  const records = await listTags(host);
  const rec = records.find((r) => r.name === name);
  if (!rec) throw new Error(`标签存储里找不到「${name}」`);
  return rec.members.map((m) => {
    const path = normalizePath(m.path);
    return { name: baseNameOf(path), path, isDir: m.kind === DIR_KIND, size: null, modifiedMs: null };
  });
}

// ─────────────────── 一栏的加载状态机与导航栈（P7-7 / P7-8） ───────────────────

/** 09 §3.3 要求的五态：空目录与错误必须互相区分。 */
type LoadStatus = "idle" | "loading" | "success" | "empty" | "error";

interface HistoryState {
  stack: string[];
  pos: number;
}

/** 栈的推进方式：入栈 / 替换当前项（刷新、重复选择）/ 只移动指针（前进、后退）。 */
type CommitMode = "push" | "replace" | "step";

interface Request {
  path: string;
  mode: CommitMode;
}

/** 一次目录请求的身份：本地自增序号 + path + 会话 + 栏位，四者全中才接纳（P7-7）。 */
interface RequestToken extends Request {
  seq: number;
  session: string;
  pane: string;
}

/** 09 §9.1：栈只在解析成功或进入明确错误态时推进；刷新与重复选择当前路径都不增项。 */
function commitHistory(h: HistoryState, path: string, mode: CommitMode): HistoryState {
  const current = h.stack[h.pos] ?? "";
  if (mode === "step") return h;
  if (mode === "replace") {
    if (current === path) return h;
    const stack = [...h.stack];
    stack[h.pos] = path;
    return { stack, pos: h.pos };
  }
  if (current === path) return h;
  const head = h.stack.slice(0, h.pos + 1);
  return { stack: [...head, path], pos: head.length };
}

/** One pane's browser. `slotId` is which pane this instance lives in. */
function FileBrowserPane({ host, slotId }: SlotProps) {
  /** Fixed for the lifetime of this instance — the pane remounts per session. */
  const [session] = useState(() => host.getState().activeTabId);
  const memKey = `${session}|${slotId}`;
  const [memory] = useState<Partial<PaneMemory>>(() => readMap()[memKey] ?? {});

  /** This pane's own back/forward stack — never shared with another pane. */
  const [hist, setHist] = useState<HistoryState>(() => ({ stack: [memory.cwd ?? ""], pos: 0 }));
  const cwd = hist.stack[hist.pos] ?? "";

  const prefs = usePrefs();
  /** null = 这一栏没单独选过,跟随插件偏好;选过就自己记住。 */
  const [manualMode, setManualMode] = useState<ViewMode | null>(memory.mode ?? null);
  const mode = manualMode ?? prefs.defaultMode;
  /** 正在进行的导航；null 表示当前栈顶就是已落定的目录。 */
  /** 正在进行的导航；null 表示当前栈顶就是已落定的目录。恢复出来的栏位一挂载就
   *  带着目标路径发起读取（`step` 不推进历史栈），否则它会停在空态不动。 */
  const [request, setRequest] = useState<Request | null>(() =>
    memory.cwd ? { path: memory.cwd, mode: "step" } : null,
  );
  const [status, setStatus] = useState<LoadStatus>("idle");
  const [entries, setEntries] = useState<ListEntry[]>([]);
  const [counts, setCounts] = useState<{ dirs: number; files: number }>({ dirs: 0, files: 0 });
  const [fetchMs, setFetchMs] = useState(0);
  const [error, setError] = useState<DirectoryError | null>(null);
  /** 不认识侧栏引用时的可见提示（P7-9），不是错误态。 */
  const [notice, setNotice] = useState<PaneNotice | null>(null);
  /** 本栏的选择集合（路径）。行点击/焦点发布收敛为单选；右键的"已在选择内
   *  则保留整个选择"与"全选"都读这里（P7-12 多选右键规则）。 */
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set());
  /** 递增一次就把地址栏交给用户编辑（错误态的"选择其他目录"）。 */
  const [addressToken, setAddressToken] = useState(0);
  const browserRef = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);

  /** 页面呈现的目录：请求进行中即目标路径，地址栏与列表头部永远说同一件事。 */
  const displayPath = request?.path ?? cwd;
  /** 非 null = 本栏当前是标签视图；值就是标签名。 */
  const viewTag = decodeTagPath(displayPath);
  /** 界面文案里的视图名（标签视图不是路径）。 */
  const displayLabel = viewLabelOf(displayPath);

  // —— 请求序号（P7-7）：能力层没有中断通道，所以靠"最新身份"丢弃迟到结果 ——
  const seqRef = useRef(0);
  const latestRef = useRef<RequestToken | null>(null);
  const aliveRef = useRef(true);
  const histRef = useRef(hist);
  const requestRef = useRef(request);
  /** 菜单项的 execute 在渲染之外跑（全选要读当前清单），必须经 ref 拿最新值。 */
  const entriesRef = useRef(entries);
  useEffect(() => {
    histRef.current = hist;
  }, [hist]);
  useEffect(() => {
    requestRef.current = request;
  }, [request]);
  useEffect(() => {
    entriesRef.current = entries;
  }, [entries]);

  const activePath = useCallback(
    (): string => requestRef.current?.path ?? histRef.current.stack[histRef.current.pos] ?? "",
    [],
  );

  /** 已经落定在栈顶的目录（刷新与"重复选择"的比较基准）。 */
  const committedPath = useCallback((): string => histRef.current.stack[histRef.current.pos] ?? "", []);

  /** 只有"最新一号 + 同一路径 + 同一会话 + 同一栏 + 组件还在"的响应才允许落地。 */
  const accept = useCallback(
    (token: RequestToken): boolean => {
      const cur = latestRef.current;
      return (
        aliveRef.current &&
        cur !== null &&
        cur.seq === token.seq &&
        cur.path === token.path &&
        cur.session === token.session &&
        cur.pane === token.pane &&
        // 会话切换后这一栏已不属于活动会话：旧响应不得覆盖新会话（09 §3.2）
        token.session === host.getState().activeTabId
      );
    },
    [host],
  );

  /** 落定：按请求携带的方式推进栈，并在离开目录视图时作废不再可见的焦点/选择。
   *  标签视图是跨目录的视角，不作废全局焦点与选择 —— "展开标签后把当前选中项
   *  加进来"正是靠焦点跨过这一步存活；成员自身的失效由各详情插件各自处理。 */
  const settle = useCallback(
    (token: RequestToken): void => {
      setHist((h) => commitHistory(h, token.path, token.mode));
      setRequest(null);
      if (decodeTagPath(token.path) !== null) return;
      const focus = host.getState().focusRef;
      if (focus && (focus.kind === DIR_KIND || focus.kind === FILE_KIND) && !isInDirectory(focus.id, token.path)) {
        // 只有"这一栏正握着本会话的选择权"时才作废全局焦点：另一栏在后台换目录，
        // 不该把邻居栏里仍然有效的焦点擦掉（09 §4）。
        if (lastPaneBySession.get(token.session) === token.pane) {
          host.emit(Events.focusChanged, null);
        }
      }
      setSelection((cur) => {
        if (cur.size === 0) return cur;
        const next = new Set([...cur].filter((p) => isInDirectory(p, token.path)));
        return next.size === cur.size ? cur : next;
      });
    },
    [host],
  );

  /** 进入一个目录。比较基准是已落定的栈顶：重复选择当前路径 = 显式刷新当前项，
   *  不建重复栈项；正在途中的同一目标不重复排队。 */
  const navigate = useCallback(
    (dir: string): void => {
      const path = normalizePath(dir);
      if (!path) return;
      setNotice(null);
      const pending = requestRef.current;
      if (pending && pending.path === path) return;
      setRequest(path === committedPath() ? { path, mode: "replace" } : { path, mode: "push" });
    },
    [committedPath],
  );

  /** 刷新：只替换当前历史项，绝不新增；请求在途时沿用其原有的推进方式。 */
  const refresh = useCallback((): void => {
    const pending = requestRef.current;
    if (pending) {
      setRequest({ ...pending });
      return;
    }
    const path = committedPath();
    if (!path) return;
    setNotice(null);
    setRequest({ path, mode: "replace" });
  }, [committedPath]);

  const goBack = useCallback((): void => {
    const h = histRef.current;
    const pos = h.pos - 1;
    const path = pos >= 0 ? (h.stack[pos] ?? "") : "";
    if (!path) return;
    setHist({ ...h, pos });
    setRequest({ path, mode: "step" });
  }, []);

  const goForward = useCallback((): void => {
    const h = histRef.current;
    const pos = h.pos + 1;
    const path = pos < h.stack.length ? (h.stack[pos] ?? "") : "";
    if (!path) return;
    setHist({ ...h, pos });
    setRequest({ path, mode: "step" });
  }, []);

  const goUp = useCallback((): void => {
    const from = activePath();
    const parent = parentOf(from);
    if (!parent || parent === from) return;
    navigate(parent);
  }, [activePath, navigate]);

  const editAddress = useCallback((): void => setAddressToken((t) => t + 1), []);

  // Read one directory, tagged with a fresh sequence number. The provider's order
  // is kept as-is: sorting 500k names on the UI thread is the host's job
  // (`fs.list` returns natural order), and the virtualizer is only stable if the
  // row stream does not shuffle per render.
  useEffect(() => {
    if (!request?.path) return;
    const token: RequestToken = {
      seq: ++seqRef.current,
      path: request.path,
      mode: request.mode,
      session,
      pane: slotId,
    };
    latestRef.current = token;
    // 切目录一律从空白开始：旧条目留在屏上就是"闪回旧数据"。
    setStatus("loading");
    setError(null);
    setEntries([]);
    setCounts({ dirs: 0, files: 0 });
    const started = performance.now();
    // 标签视图与目录共用一条请求/落定管线，只是数据源不同：成员来自 db.tags。
    const tag = decodeTagPath(token.path);
    const listing =
      tag === null ? host.invoke<ListEntry[]>("fs.list", { path: token.path }) : loadTagMembers(host, tag);
    listing.then(
      (list) => {
        if (!accept(token)) return;
        settle(token);
        let dirs = 0;
        for (const ent of list) if (ent.isDir) dirs++;
        setEntries(list);
        setCounts({ dirs, files: list.length - dirs });
        setFetchMs(performance.now() - started);
        setStatus(list.length === 0 ? "empty" : "success");
      },
      (err) => {
        if (!accept(token)) return;
        settle(token);
        setError(tag === null ? classifyDirectoryError(errorMessage(err)) : classifyTagError(tag, errorMessage(err)));
        setStatus("error");
      },
    );
    return () => {
      // 被新请求取代或组件卸载：作废这一号，迟到的响应在 accept 处被丢弃。
      if (latestRef.current?.seq === token.seq) latestRef.current = null;
    };
  }, [accept, host, request, session, settle, slotId]);

  // 卸载 / 插件停用：此后任何响应都不再被接纳（StrictMode 下重新挂载要恢复）。
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      latestRef.current = null;
    };
  }, []);

  /** 事件回调在渲染之外，走 ref 读最新的路径与刷新入口（与 entriesRef 同一规则）。 */
  const listedPathRef = useRef(displayPath);
  const refreshRef = useRef(refresh);
  useEffect(() => {
    listedPathRef.current = displayPath;
    refreshRef.current = refresh;
  }, [displayPath, refresh]);

  // 列表随真实变化收敛（P7-18）。`file:changed` 有两个发布者：文件监听（外部改动）
  // 和刚完成批量操作的 plugin-file-ops（操作一落地就该看得见，不等 notify 的防抖）。
  // 只关心"就在这一栏这一层"的变化，并把短时间内的连续事件并成一次 fs.list：
  // 回收 500 个文件不该发 500 次列目录。
  useEffect(() => {
    let timer: number | null = null;
    const off = host.on<{ path?: unknown }>(Events.fileChanged, (payload) => {
      const changed = typeof payload?.path === "string" ? payload.path : "";
      const dir = listedPathRef.current;
      if (!changed || !dir || !isInDirectory(changed, dir)) return;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        refreshRef.current();
      }, 300);
    });
    return () => {
      off();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [host]);

  // 标签视图开着时，标签数据一写入（成员增删、改名）就重查成员（P7-32）：写者
  // 已经发 tags:updated，读者只重新读取，不在事件里搬数据。目录视图不受影响。
  useEffect(
    () =>
      host.on(Events.tagsUpdated, () => {
        if (decodeTagPath(activePath()) !== null) refreshRef.current();
      }),
    [host, activePath],
  );

  // The address bar mirrors whichever directory this pane now shows.
  useEffect(() => {
    if (cwd) remember(memKey, { cwd });
  }, [cwd, memKey]);

  // First mount with no remembered path: open the home directory.
  useEffect(() => {
    if (cwd || request) return;
    let cancelled = false;
    host
      .invoke<string>("fs.home")
      .then((home) => {
        if (!cancelled) navigate(String(home));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(classifyDirectoryError(errorMessage(err)));
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [cwd, host, navigate, request]);

  // B → C：侧栏选择只驱动本会话最后交互过的那一栏，且只处理认识的 kind（P7-9）。
  useEffect(
    () =>
      host.on<Ref | null>(Events.sidebarSelectionChanged, (ref) => {
        if (!ref) return;
        const last = lastPaneBySession.get(session);
        if (last !== undefined && last !== slotId) return;
        lastPaneBySession.set(session, slotId);
        if (ref.kind === DIR_KIND) {
          navigate(ref.id);
          return;
        }
        if (ref.kind === FILE_KIND) {
          // 既有策略：文件引用导航到它所在目录。
          navigate(parentOf(ref.id));
          return;
        }
        if (ref.kind === TAG_KIND) {
          // 标签引用（P7-32）：视图经共享 db.tags 存储解析，栈项是编码后的视图标识。
          navigate(encodeTagPath(ref.id));
          return;
        }
        // 不认识的 kind：不猜测引用内容，也不跨插件读私有存储 —— 给可见反馈。
        setNotice({
          text: "暂不支持这种侧栏选择：请改用文件夹、文件或标签。",
          hover: `收到来自 ${ref.sourcePlugin} 的未知引用类型（kind: ${ref.kind}），本插件只处理文件夹、文件与标签`,
        });
      }),
    [host, navigate, session, slotId],
  );

  const claimPane = useCallback((): void => {
    lastPaneBySession.set(session, slotId);
    toolbarStore.claim(session, slotId);
  }, [session, slotId]);

  const refForEntry = (ent: ListEntry): Ref => ({
    kind: ent.isDir ? DIR_KIND : FILE_KIND,
    id: ent.path,
    sourcePlugin: PLUGIN_NAME,
  });

  const publishFocus = (ent: ListEntry): void => {
    claimPane();
    setSelection(new Set([ent.path]));
    host.emit(Events.focusChanged, refForEntry(ent));
  };

  /** 全选：把当前目录列出的全部条目收进选择。走 entriesRef 而不是闭包，
   *  菜单项的 execute 拿到的永远是最新清单（P7-12）。 */
  const selectAll = useCallback((): void => {
    const list = entriesRef.current;
    if (list.length === 0) return;
    setSelection(new Set(list.map((ent) => ent.path)));
  }, []);

  // —— 共享右键菜单（P7-12）：只打开面板，绝不自绘菜单 ——
  // host.contextMenu 只在 manifest 授权了 permissions.contextMenu 时存在；
  // 缺席时一律直接 return：不 preventDefault，浏览器默认菜单照常工作。

  /** 组装选择集合为 Ref[]：按清单顺序取仍在选择里的条目。 */
  const refsFromSelection = (): Ref[] => {
    const refs: Ref[] = [];
    for (const ent of entries) if (selection.has(ent.path)) refs.push(refForEntry(ent));
    return refs;
  };

  const openMenu = (
    surfaceId: string,
    ent: ListEntry | null,
    anchor: { x: number; y: number },
    trigger: "pointer" | "keyboard",
    emptyDir?: string | null,
  ): void => {
    const contextMenu = host.contextMenu;
    if (!contextMenu) return;
    let targetRef: Ref | null = null;
    let targetKind: string | null = null;
    let selectedRefs: Ref[];
    if (ent) {
      const ref = refForEntry(ent);
      targetRef = ref;
      targetKind = ref.kind;
      if (selection.has(ent.path)) {
        // 多选规则：右键目标已在选择内 → 保留整个选择。
        selectedRefs = refsFromSelection();
      } else {
        // 不在选择内 → 先经既有选择路径（publishFocus）收敛到这一个再打开。
        publishFocus(ent);
        selectedRefs = [ref];
      }
    } else {
      // 空白区：选择原样带过去（可以为空），没有单目标。
      selectedRefs = refsFromSelection();
      if (emptyDir) {
        targetRef = { kind: DIR_KIND, id: emptyDir, sourcePlugin: PLUGIN_NAME };
        targetKind = DIR_KIND;
      }
    }
    contextMenu.open({
      surfaceId,
      targetKind,
      targetRef,
      selectedRefs,
      sessionId: host.getState().activeTabId,
      paneId: slotId,
      anchor,
      trigger,
    } satisfies ContextMenuContext);
  };

  const itemContextMenu = (surfaceId: string, e: ReactMouseEvent<HTMLElement>, ent: ListEntry): void => {
    if (!host.contextMenu) return;
    e.preventDefault();
    // 行/卡片的菜单不能被外层"空白区"handler 二次接管。
    e.stopPropagation();
    openMenu(surfaceId, ent, { x: e.clientX, y: e.clientY }, "pointer");
  };

  /** 键盘等价：焦点行上 ContextMenu 键或 Shift+F10，锚在行包围盒中心。 */
  const itemContextKey = (surfaceId: string, e: ReactKeyboardEvent<HTMLElement>, ent: ListEntry): void => {
    if (!host.contextMenu) return;
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    openMenu(surfaceId, ent, { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }, "keyboard");
  };

  const emptyContextMenu = (e: ReactMouseEvent<HTMLElement>): void => {
    if (!host.contextMenu) return;
    e.preventDefault();
    // 空白区的 target 是"这个目录本身"（错误态除外：它没被成功打开过，不能假装在）。
    // Windows 的空白区动作（新建文件夹）作用于所在目录，把目录作为 target 交出去，
    // 贡献菜单项的插件就不需要任何"当前目录"的全局状态（P7-18）。
    const dir = status === "error" ? null : displayPath;
    openMenu(SURFACE_EMPTY, null, { x: e.clientX, y: e.clientY }, "pointer", dir);
  };

  const enter = (ent: ListEntry): void => {
    if (ent.isDir) navigate(ent.path);
  };

  /** chips 点击与侧栏标签引用走同一条导航路径（P7-32）。 */
  const openTagView = useCallback((name: string): void => navigate(encodeTagPath(name)), [navigate]);

  // 列表/网格只换样式：路径、历史、数据、选择一律不动。
  const switchMode = useCallback(
    (next: ViewMode): void => {
      setManualMode(next);
      remember(memKey, { mode: next });
    },
    [memKey],
  );

  const controller = useMemo<NavigationController>(
    () => ({
      id: memKey,
      cwd: displayPath,
      viewLabel: displayLabel,
      mode,
      status,
      canBack: hist.pos > 0,
      canForward: hist.pos < hist.stack.length - 1,
      // 标签视图没有上级目录：parentOf 对 tag:// 没有意义，按钮一律禁用。
      canUp: viewTag === null && !!displayPath && displayPath !== parentOf(displayPath),
      back: goBack,
      forward: goForward,
      up: goUp,
      refresh,
      navigate,
      setMode: switchMode,
      claim: claimPane,
      editAddress,
      addressToken,
      selectAll,
    }),
    [
      memKey,
      displayPath,
      displayLabel,
      viewTag,
      mode,
      status,
      hist.pos,
      hist.stack.length,
      goBack,
      goForward,
      goUp,
      refresh,
      navigate,
      switchMode,
      claimPane,
      editAddress,
      addressToken,
      selectAll,
    ],
  );

  useEffect(() => {
    const el = browserRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setVisible(el.clientWidth > 0 && el.clientHeight > 0));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    toolbarStore.set(session, slotId, controller, visible);
  }, [session, slotId, controller, visible]);
  useEffect(
    () => () => {
      toolbarStore.remove(session, slotId);
    },
    [session, slotId],
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 整栏点击/聚焦把键盘焦点交回本栏工具条；命中目标可能是栏内任意子元素
    <div ref={browserRef} className="fm-browser" style={paneStyle} onMouseDown={claimPane} onFocusCapture={claimPane}>
      <NavigationBar controller={controller} />

      {notice && (
        <Alert
          className="fm-pane-notice"
          variant="light"
          color="yellow"
          withCloseButton
          onClose={() => setNotice(null)}
          closeButtonLabel="关闭提示"
          icon={<CircleAlert size={14} />}
          mx="xs"
          mb={4}
        >
          {/* kind / 来源插件属于内部标识：只在悬停说明里出现，不进可见文案。 */}
          <span title={notice.hover}>{notice.text}</span>
        </Alert>
      )}

      <div className="fm-directory" style={dirHeaderStyle}>
        <Text className="fm-directory-name" size="xs" fw={600} truncate title={displayLabel} style={{ minWidth: 0 }}>
          {displayLabel || "—"}
        </Text>
        <Text
          className="fm-directory-count"
          title={`读取耗时 ${fetchMs.toFixed(0)} ms`}
          size="xs"
          c="dimmed"
          style={{ marginLeft: "auto", flexShrink: 0 }}
        >
          {status === "loading"
            ? "载入中…"
            : status === "error"
              ? "—"
              : status === "empty"
                ? viewTag !== null
                  ? "无成员"
                  : "空文件夹"
                : `${counts.dirs} 个文件夹 · ${counts.files} 个文件`}
        </Text>
      </div>

      {status === "error" && error ? (
        <DirectoryErrorPanel error={error} controller={controller} emptyContextMenu={emptyContextMenu} />
      ) : (
        <EntryArea
          status={status}
          host={host}
          mode={mode}
          entries={entries}
          cwd={displayPath}
          selected={selection}
          onFocus={publishFocus}
          onEnter={enter}
          onTag={openTagView}
          itemContextMenu={itemContextMenu}
          itemContextKey={itemContextKey}
          emptyContextMenu={emptyContextMenu}
        />
      )}
    </div>
  );
}

interface PaneNotice {
  text: string;
  /** 内部标识（kind、来源插件）只放在悬停说明里，不进可见文案。 */
  hover: string;
}

/** 错误态：分类原因 + 可执行动作（重试 / 返回上级 / 选择其他目录）。 */
function DirectoryErrorPanel({
  error,
  controller,
  emptyContextMenu,
}: {
  error: DirectoryError;
  controller: NavigationController;
  /** 错误态区域也属于 browser.empty surface（P7-12）。 */
  emptyContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
}) {
  const Icon = error.kind === "missing" || error.kind === "invalid" ? FolderX : CircleAlert;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 错误态整块属于 browser.empty 右键面，与列表空白区同一入口
    <div
      className="fm-empty fm-directory-error"
      style={{ flex: 1 }}
      data-surface={SURFACE_EMPTY}
      onContextMenu={emptyContextMenu}
    >
      <span className="fm-empty-icon">
        <Icon size={28} color="var(--mantine-color-red-6)" />
      </span>
      <Text size="sm" fw={600}>
        {error.title}
      </Text>
      <Text size="xs" c="dimmed">
        {error.advice}
      </Text>
      <Text size="xs" c="red" style={{ overflowWrap: "anywhere" }} title={error.detail}>
        {error.detail}
      </Text>
      <Group gap={6} wrap="wrap" justify="center">
        {error.retryable && (
          <Button size="compact-xs" variant="light" leftSection={<RefreshCw size={13} />} onClick={controller.refresh}>
            重试
          </Button>
        )}
        <Button
          size="compact-xs"
          variant="light"
          color="gray"
          leftSection={<ArrowUp size={13} />}
          disabled={!controller.canUp}
          onClick={controller.up}
        >
          返回上级
        </Button>
        <Button
          size="compact-xs"
          variant="light"
          color="gray"
          leftSection={<Folder size={13} />}
          onClick={controller.editAddress}
        >
          选择其他目录
        </Button>
      </Group>
    </div>
  );
}

interface NavigationController {
  id: string;
  /** 当前显示的目录；请求进行中就是目标路径，所以地址栏与头部永远一致。 */
  cwd: string;
  /** 地址栏显示的文本（= cwd 的用户可读形式；标签视图显示"标签「X」"）。 */
  viewLabel: string;
  mode: ViewMode;
  /** 本栏的加载状态，用于刷新按钮的进行中反馈。 */
  status: LoadStatus;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  back: () => void;
  forward: () => void;
  up: () => void;
  /** 刷新：只替换当前历史项，不新增栈项。 */
  refresh: () => void;
  navigate: (path: string) => void;
  setMode: (mode: ViewMode) => void;
  claim: () => void;
  /** 把地址栏交给用户（错误态的"选择其他目录"）。 */
  editAddress: () => void;
  addressToken: number;
  /** 全选当前目录列出的条目（右键菜单项 browser.selectAll 复用此路径）。 */
  selectAll: () => void;
}

const toolbarStore = createToolbarStore<NavigationController>();

/** The existing topbar slot carries the active pane's navigation, owned by this plugin. */
export function FileBrowserToolbar({ host }: SlotProps) {
  const [session, setSession] = useState(host.getState().activeTabId);
  useEffect(() => host.onStateChange((state) => setSession(state.activeTabId)), [host]);
  const controller = useSyncExternalStore(toolbarStore.subscribe, () => toolbarStore.get(session));
  useEffect(() => {
    controller?.claim();
  }, [controller?.claim]);

  /** 右键菜单项的 execute 在渲染之外触发，永远经 ref 读"当前活动栏"的控制器，
   *  不依赖任何闭包里的旧状态（P7-12）。顶栏只挂载一份，所以菜单项 id 在这里
   *  注册一次就够 —— 放在栏位组件里会因多栏重复注册而被基座拒绝。 */
  const ctrlRef = useRef<NavigationController | null>(controller);
  ctrlRef.current = controller;
  useEffect(() => {
    const contextMenu = host.contextMenu;
    if (!contextMenu) return;
    const offRefresh = contextMenu.registerItem({
      id: "browser.refresh",
      label: "刷新目录",
      order: 10,
      // 目录级导航/选择动作：只在空白区 surface 出现（P7-12）。
      when: (context) => context.surfaceId === SURFACE_EMPTY,
      // 复用栏位既有的刷新路径：只替换当前历史项，不新增栈项。
      execute: () => ctrlRef.current?.refresh(),
    });
    const offSelectAll = contextMenu.registerItem({
      id: "browser.selectAll",
      label: "全选",
      order: 11,
      when: (context) => context.surfaceId === SURFACE_EMPTY,
      // 清单为空或仍在载入时不可用；错误态同样没有可选条目。
      enabled: () => ctrlRef.current?.status === "success",
      execute: () => ctrlRef.current?.selectAll(),
    });
    return () => {
      offRefresh();
      offSelectAll();
    };
  }, [host]);

  return controller ? (
    <NavigationBar key={controller.id} controller={controller} global />
  ) : (
    <Text size="xs" c="dimmed">
      文件导航
    </Text>
  );
}

function NavigationBar({ controller, global = false }: { controller: NavigationController; global?: boolean }) {
  /** 输入框是草稿；只有 Enter 校验通过才交给 `controller.navigate` 写栈（09 §9.1）。
   *  标签视图里显示的是"标签「X」"而不是内部编码；用户可以直接改写成一真实路径离开。 */
  const [address, setAddress] = useState(controller.viewLabel);
  const [invalid, setInvalid] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // 目录一变（导航、后退、刷新、侧栏驱动）就回到真实路径，丢弃未提交的草稿。
  useEffect(() => {
    setAddress(controller.viewLabel);
    setInvalid(null);
  }, [controller.viewLabel]);

  // 错误面板的"选择其他目录"：把光标交回地址栏。
  useEffect(() => {
    if (controller.addressToken === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [controller.addressToken]);

  const submit = (): void => {
    const checked = validateAddress(address);
    if (!checked.ok) {
      // 校验失败：保留原路径，不写历史，只说明原因。
      setInvalid(checked.reason);
      return;
    }
    setInvalid(null);
    controller.navigate(checked.path);
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 地址栏是复合控件（按钮＋输入框），点击任意处即认领当前栏
    <div
      className={global ? "fm-address fm-global-address" : "fm-address"}
      onMouseDown={controller.claim}
      onFocusCapture={controller.claim}
      style={{ ...addressBarStyle, ...(global ? { padding: 0, flex: 1 } : {}) }}
    >
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
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          title="刷新"
          aria-label="刷新"
          loading={controller.status === "loading"}
          onClick={controller.refresh}
        >
          <RefreshCw size={14} />
        </ActionIcon>
      </Group>

      <TextInput
        className="fm-address-input"
        ref={inputRef}
        leftSection={<Folder size={14} />}
        size="xs"
        variant="default"
        value={address}
        error={invalid ?? undefined}
        onChange={(e) => {
          setAddress(e.currentTarget.value);
          if (invalid) setInvalid(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            // 放弃草稿，恢复当前路径（不触发导航，也不写历史）。
            e.stopPropagation();
            setAddress(controller.viewLabel);
            setInvalid(null);
            e.currentTarget.blur();
          }
        }}
        placeholder="输入目录路径后回车"
        aria-label="当前目录地址"
        style={{ flex: 1, minWidth: 0 }}
      />

      <div className="fm-view-mode" style={{ flexShrink: 0 }}>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <Button
              className="fm-dropdown-button"
              variant="default"
              size="xs"
              aria-label="视图模式"
              rightSection={<ChevronDown size={14} />}
            >
              <ModeLabel mode={controller.mode} />
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Label>视图模式</Menu.Label>
            {VIEW_MODES.map((item) => {
              const Icon = item.Icon;
              return (
                <Menu.Item
                  key={item.value}
                  onClick={() => controller.setMode(item.value)}
                  leftSection={<Icon size={14} />}
                  rightSection={
                    controller.mode === item.value ? (
                      <span title="当前视图">
                        <Check size={14} />
                      </span>
                    ) : undefined
                  }
                >
                  {item.label}
                </Menu.Item>
              );
            })}
          </Menu.Dropdown>
        </Menu>
      </div>
    </div>
  );
}

/** 三种显示方式只有一个来源表：菜单、当前标签和默认值设置页都从这里生成，
 *  加一列模式不会再出现"菜单里有、标签还写死两种"的漂移。 */
const VIEW_MODES: ReadonlyArray<{ value: ViewMode; label: string; Icon: typeof List }> = [
  { value: "list", label: "列表", Icon: List },
  { value: "grid", label: "网格", Icon: LayoutGrid },
  { value: "table", label: "表格", Icon: Table },
];

function ModeLabel({ mode }: { mode: ViewMode }) {
  const found = VIEW_MODES.find((item) => item.value === mode) ?? VIEW_MODES[0];
  const Icon = found.Icon;
  return (
    <Group gap={4} wrap="nowrap">
      <Icon size={12} />
      <span className="fm-view-label-text">{found.label}</span>
    </Group>
  );
}

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
    rows.push({ kind: "header", title, path: viewLabelOf(cwd) });
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

interface EntryAreaProps {
  status: LoadStatus;
  host: PluginHost;
  mode: ViewMode;
  entries: ListEntry[];
  cwd: string;
  selected: ReadonlySet<string>;
  onFocus: (ent: ListEntry) => void;
  onEnter: (ent: ListEntry) => void;
  /** 标签 chip 点击：打开该标签的视图（P7-32）。 */
  onTag: (name: string) => void;
  /** 共享右键菜单入口（P7-12）：行/卡片各自 surface，空白区统一 browser.empty。 */
  itemContextMenu: (surfaceId: string, e: ReactMouseEvent<HTMLElement>, ent: ListEntry) => void;
  itemContextKey: (surfaceId: string, e: ReactKeyboardEvent<HTMLElement>, ent: ListEntry) => void;
  emptyContextMenu: (e: ReactMouseEvent<HTMLElement>) => void;
}

/** 空态与载入态三种模式共用，所以判断放在分发处；每个渲染组件自己的 hook
 *  序列因此始终固定（条件调用 useVirtualizer 会让 React 直接报错）。 */
function EntryArea(props: EntryAreaProps) {
  const { status, entries, emptyContextMenu, cwd } = props;
  if (entries.length === 0) {
    // 空目录与"正在载入"是两种状态；错误态由外层的分类面板负责，不进这里。
    const busy = status === "loading" || status === "idle";
    const tag = decodeTagPath(cwd) !== null;
    return (
      // biome-ignore lint/a11y/noStaticElementInteractions: 空目录/载入态整块是 browser.empty 右键面
      <div className="fm-empty" style={{ flex: 1 }} data-surface={SURFACE_EMPTY} onContextMenu={emptyContextMenu}>
        <span className="fm-empty-icon">
          <Folder size={28} />
        </span>
        <Text size="sm" fw={600}>
          {busy ? (tag ? "正在读取标签成员…" : "正在加载目录…") : tag ? "这个标签还没有成员" : "此文件夹为空"}
        </Text>
        <Text size="xs" c="dimmed">
          {busy
            ? "稍候即可查看文件内容"
            : tag
              ? "在标签面板里把文件或文件夹加进来后，会显示在这里"
              : "这里还没有文件或子文件夹"}
        </Text>
      </div>
    );
  }
  return props.mode === "table" ? <TableView {...props} /> : <StreamArea {...props} />;
}

/** 条目关联标签 chips（P7-32）：点击打开该标签的视图，与侧栏标签引用同一路径。
 *  超过上限的收进 +N 的悬停说明；点击不冒泡到行，避免顺带改变文件焦点/选择。 */
function TagChips({ names, onOpen, limit }: { names: string[]; onOpen: (name: string) => void; limit: number }) {
  if (names.length === 0) return null;
  const shown = names.slice(0, limit);
  const rest = names.slice(limit);
  return (
    <Group gap={4} wrap="nowrap" className="fm-tag-chips" style={{ minWidth: 0 }}>
      {shown.map((name) => (
        <Badge
          key={name}
          component="button"
          type="button"
          className="fm-tag-chip"
          size="xs"
          radius="sm"
          variant="light"
          color="blue"
          tt="none"
          title={`打开标签「${name}」`}
          style={{ cursor: "pointer", flexShrink: 1, maxWidth: 110 }}
          onClick={(e: ReactMouseEvent<HTMLButtonElement>) => {
            e.stopPropagation();
            onOpen(name);
          }}
          onDoubleClick={(e: ReactMouseEvent<HTMLButtonElement>) => e.stopPropagation()}
          onKeyDown={(e: ReactKeyboardEvent<HTMLButtonElement>) => {
            // 行也是 role=button：chip 上的 Enter/Space 只属于 chip 自己。
            if (e.key === "Enter" || e.key === " ") e.stopPropagation();
          }}
        >
          {name}
        </Badge>
      ))}
      {rest.length > 0 && (
        <Badge size="xs" radius="sm" variant="default" tt="none" title={`其余标签：${rest.join("、")}`}>
          +{rest.length}
        </Badge>
      )}
    </Group>
  );
}

/** List and grid share ONE virtualized row stream, so a 50k-entry directory costs the
 *  same in either mode. Grid rows carry real height because a card shows a thumbnail. */
function StreamArea({
  host,
  mode,
  entries,
  cwd,
  selected,
  onFocus,
  onEnter,
  onTag,
  itemContextMenu,
  itemContextKey,
  emptyContextMenu,
}: EntryAreaProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  // 订阅标签索引：tags:updated 重建后，屏上的 chips 立刻跟随（查找走 tagsForEntry）。
  useTagIndex();

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cols = mode === "grid" ? Math.max(1, Math.floor((width + 8) / (CARD_MIN_WIDTH + 8)) || 1) : 1;
  const rows = useMemo(() => buildRows(entries, cwd, mode, cols), [entries, cwd, mode, cols]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (rows[i].kind === "header" ? 32 : rows[i].kind === "cards" ? CARD_ROW_HEIGHT : 36),
    overscan: 10,
  });

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: 滚动区空白处属于 browser.empty 右键面；条目行各自拦截右键
    <div ref={scrollRef} style={scrollStyle} data-surface={SURFACE_EMPTY} onContextMenu={emptyContextMenu}>
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
              // biome-ignore lint/a11y/useSemanticElements: 虚拟化行是绝对定位的 CSS Grid 行，<button> 的默认盒模型会破坏几何；键盘语义已按 button 补全
              <div
                key={item.key}
                className="fm-entry"
                data-selected={selected.has(row.ent.path)}
                data-surface={SURFACE_LIST}
                role="button"
                tabIndex={0}
                aria-pressed={selected.has(row.ent.path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onFocus(row.ent);
                    onEnter(row.ent);
                  }
                  if (e.key === " ") {
                    e.preventDefault();
                    onFocus(row.ent);
                  }
                  itemContextKey(SURFACE_LIST, e, row.ent);
                }}
                style={{ ...listRowStyle, ...abs }}
                onClick={() => onFocus(row.ent)}
                onDoubleClick={() => onEnter(row.ent)}
                onContextMenu={(e) => itemContextMenu(SURFACE_LIST, e, row.ent)}
                title={row.ent.isDir ? "双击进入" : undefined}
              >
                <IconFor entry={row.ent} />
                <Text size="xs" truncate style={{ flex: 1, minWidth: 0 }}>
                  {row.ent.name}
                </Text>
                <TagChips names={tagsForEntry(row.ent.path)} onOpen={onTag} limit={2} />
                <Text className="fm-size-cell" size="xs" c="dimmed" style={cellStyle}>
                  {row.ent.isDir ? "" : formatSize(row.ent.size)}
                </Text>
                <Text className="fm-date-cell" size="xs" c="dimmed" style={cellStyle}>
                  {formatDate(row.ent.modifiedMs)}
                </Text>
              </div>
            );
          }
          return (
            <div
              key={item.key}
              style={{ ...cardsRowStyle, ...abs, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {row.items.map((ent) => (
                // biome-ignore lint/a11y/useSemanticElements: 虚拟化卡片是 CSS Grid 单元，<button> 默认盒模型会破坏卡片几何；键盘语义已按 button 补全
                <div
                  key={ent.path}
                  className="fm-card"
                  data-selected={selected.has(ent.path)}
                  data-surface={SURFACE_GRID}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected.has(ent.path)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      onFocus(ent);
                      onEnter(ent);
                    }
                    if (e.key === " ") {
                      e.preventDefault();
                      onFocus(ent);
                    }
                    itemContextKey(SURFACE_GRID, e, ent);
                  }}
                  style={cardStyle}
                  onClick={() => onFocus(ent)}
                  onDoubleClick={() => onEnter(ent)}
                  onContextMenu={(e) => itemContextMenu(SURFACE_GRID, e, ent)}
                  title={ent.isDir ? "双击进入" : undefined}
                >
                  <Thumb host={host} entry={ent} />
                  <Text size="xs" truncate style={{ width: "100%" }}>
                    {ent.name}
                  </Text>
                  <TagChips names={tagsForEntry(ent.path)} onOpen={onTag} limit={2} />
                  <Group gap={4} wrap="nowrap" style={{ marginTop: "auto" }}>
                    <Badge size="xs" variant="light" color={ent.isDir ? "blue" : "gray"} tt="uppercase">
                      {ent.isDir ? "文件夹" : extensionOf(ent.name) || "文件"}
                    </Badge>
                    <Text size="xs" c="dimmed">
                      {ent.isDir ? "" : formatSize(ent.size)}
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

// ───────────────────────── 表格模式（P7-31 / P6-16） ─────────────────────────

const TABLE_ROW_HEIGHT = 36;

/** 可选列与中文标签。设置页的开关、表头、列宽模板都从这张表读，所以加一列
 *  不会出现"设置里有、表头没有"。名称列不可隐藏，因此不在这里。 */
const TABLE_TOGGLE_COLUMNS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "size", label: "大小" },
  { id: "modified", label: "修改时间" },
  { id: "kind", label: "类型" },
  { id: "tags", label: "标签" },
];

const TABLE_WIDTHS: Record<string, string> = {
  name: "minmax(0, 1fr)",
  size: "92px",
  modified: "104px",
  kind: "84px",
  tags: "150px",
  dir: "0px",
};

const kindLabel = (ent: ListEntry): string => (ent.isDir ? "文件夹" : extensionOf(ent.name) || "文件");

/** 模块级列表定义拿不到组件 props，动态入口经 react-table 的 meta 槽位传递：
 *  tags 单元格据此调用当前栏的标签视图导航。 */
interface TableBrowserMeta {
  onTag: (name: string) => void;
}

/** `features` 与 `columns` 必须是模块级稳定引用：每次渲染新建会让 react-table
 *  的行模型全量重算（50 万行时就是每帧重排一次）。 */
const TABLE_FEATURES = tableFeatures({
  rowSortingFeature,
  columnVisibilityFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
  tableMeta: {} as TableBrowserMeta,
});

const tableColumnHelper = createColumnHelper<typeof TABLE_FEATURES, ListEntry>();

const TABLE_COLUMNS = tableColumnHelper.columns([
  // 隐藏的排序主键：文件夹在两种方向下都排在文件之前，与列表/网格同一口径。
  tableColumnHelper.accessor((ent) => (ent.isDir ? 0 : 1), {
    id: "dir",
    header: "",
    enableHiding: false,
    sortFn: (rowA, rowB, id) => rowA.getValue<number>(id) - rowB.getValue<number>(id),
  }),
  tableColumnHelper.accessor("name", {
    header: "名称",
    enableHiding: false,
    sortFn: "alphanumeric",
    cell: (context) => {
      const ent = context.row.original;
      return (
        <>
          <IconFor entry={ent} />
          <Text size="xs" truncate style={{ minWidth: 0 }}>
            {ent.name}
          </Text>
        </>
      );
    },
  }),
  tableColumnHelper.accessor((ent) => ent.size ?? 0, {
    id: "size",
    header: "大小",
    cell: (context) => {
      const ent = context.row.original;
      return (
        <Text size="xs" c="dimmed" style={sizeCellStyle}>
          {ent.isDir ? "" : formatSize(ent.size)}
        </Text>
      );
    },
  }),
  tableColumnHelper.accessor((ent) => ent.modifiedMs ?? 0, {
    id: "modified",
    header: "修改时间",
    cell: (context) => (
      <Text size="xs" c="dimmed">
        {formatDate(context.row.original.modifiedMs)}
      </Text>
    ),
  }),
  tableColumnHelper.accessor(kindLabel, {
    id: "kind",
    header: "类型",
    cell: (context) => (
      <Text size="xs" c="dimmed">
        {context.getValue<string>()}
      </Text>
    ),
  }),
  // 标签列只做展示：chips 是导航入口，不是排序键（P7-32）。
  tableColumnHelper.display({
    id: "tags",
    header: "标签",
    enableSorting: false,
    cell: (context) => (
      <TagChips
        names={tagsForEntry(context.row.original.path)}
        onOpen={(name) => context.table.options.meta?.onTag(name)}
        limit={2}
      />
    ),
  }),
]);

/** 表格 = 一条独立的虚拟流 + 一条固定在滚动区之上的表头，所以纵向滚动不会
 *  把列名滚掉，横向也不滚动（列宽由 grid 模板分配，表头与行共用同一个模板串）。 */
function TableView({
  entries,
  selected,
  onFocus,
  onEnter,
  onTag,
  itemContextMenu,
  itemContextKey,
  emptyContextMenu,
}: EntryAreaProps) {
  const prefs = usePrefs();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [userSorting, setUserSorting] = useState<SortingState>([]);
  // 订阅标签索引：tags:updated 重建后，屏上的 chips 立刻跟随（查找走 tagsForEntry）。
  useTagIndex();
  /** 模块级列定义经 meta 取得当前栏的标签导航入口；对象按 onTag 记忆。 */
  const meta = useMemo<TableBrowserMeta>(() => ({ onTag }), [onTag]);

  // 没人点表头时就是 provider 送来的顺序（D9：浏览器不重排），只补上列表模式
  // 同款的"文件夹成组在前"，两种视图因此不会给出两套默认顺序。
  const data = useMemo<ListEntry[]>(
    () => [...entries.filter((ent) => ent.isDir), ...entries.filter((ent) => !ent.isDir)],
    [entries],
  );
  const sorting = useMemo<SortingState>(
    () => (userSorting.length === 0 ? [] : [{ id: "dir", desc: false }, ...userSorting]),
    [userSorting],
  );
  const columnVisibility = useMemo<ColumnVisibilityState>(
    () => ({ ...prefs.tableColumns, dir: false }),
    [prefs.tableColumns],
  );

  const table = useTable({
    features: TABLE_FEATURES,
    columns: TABLE_COLUMNS,
    data,
    meta,
    getRowId: (row) => row.path,
    state: { sorting, columnVisibility },
    /** 数值列默认"第一次点=降序"，这里统一压成升序优先，四种列的行为才一致，
     *  和资源管理器"点一下先小到大"同一口径。 */
    sortDescFirst: false,
    // 主键由界面派生，不进用户排序状态，否则每点一次都会多挂一个 dir 项。
    onSortingChange: (updater) =>
      setUserSorting(functionalUpdate(updater, sorting).filter((item) => item.id !== "dir")),
  });

  const rows = table.getRowModel().rows;
  const visibleColumns = table.getVisibleLeafColumns();
  const gridTemplate = visibleColumns.map((column) => TABLE_WIDTHS[column.id] ?? "minmax(0, 1fr)").join(" ");

  /** 表头画在滚动区之外，所以竖直滚动条一出现，表头就比行宽出那么几像素，后面的
   *  固定列会跟着错位。量出滚动条宽度并从表头右侧扣掉，两侧内容框严格等宽。 */
  const [scrollbarInset, setScrollbarInset] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 行数变化可能让滚动条出现/消失，重测一次保证表头与行同宽
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const inset = el.offsetWidth - el.clientWidth;
      setScrollbarInset((prev) => (prev === inset ? prev : inset));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    const spacer = el.firstElementChild;
    if (spacer) observer.observe(spacer);
    return () => observer.disconnect();
  }, [rows.length]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TABLE_ROW_HEIGHT,
    overscan: 10,
  });

  return (
    <div style={tableAreaStyle}>
      {/* biome-ignore lint/a11y/useFocusableInteractive: 表头行由 CSS Grid 自绘，表头本身不进 Tab 序列（焦点归虚拟化行） */}
      {/* biome-ignore lint/a11y/useSemanticElements: role=row/columnheader 只为 ARIA 表格语义；真实 table 元素无法承载虚拟化网格布局 */}
      <div
        className="fm-table-head"
        role="row"
        style={{ ...tableHeadStyle, paddingRight: 10 + scrollbarInset, gridTemplateColumns: gridTemplate }}
      >
        {visibleColumns.map((column) => {
          const sorted = column.getIsSorted();
          // v9 的 getToggleSortingHandler 恒返回函数（不可排序时是空操作），
          // 可排序与否要问 getCanSort——否则展示列的表头看起来能点、还挂着排序箭头。
          const canSort = column.getCanSort();
          const toggle = column.getToggleSortingHandler();
          return (
            // biome-ignore lint/a11y/useFocusableInteractive: 表头列不进 Tab 序列（焦点归虚拟化行），columnheader 只为 ARIA 语义
            // biome-ignore lint/a11y/useSemanticElements: 表头列是 CSS Grid 单元，真实 <th> 无法承载虚拟化网格布局
            <div
              key={column.id}
              role="columnheader"
              aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
              style={{ minWidth: 0 }}
            >
              <button
                type="button"
                className="fm-table-sort"
                data-testid={`table-sort-${column.id}`}
                disabled={!canSort}
                onClick={toggle}
                style={sortButtonStyle}
              >
                {String(column.columnDef.header)}
                {sorted === "asc" ? (
                  <ArrowUp size={12} />
                ) : sorted === "desc" ? (
                  <ArrowDown size={12} />
                ) : (
                  canSort && <ArrowUpDown size={12} />
                )}
              </button>
            </div>
          );
        })}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 滚动区空白处属于 browser.empty 右键面；虚拟化行各自拦截右键 */}
      <div ref={scrollRef} style={scrollStyle} data-surface={SURFACE_EMPTY} onContextMenu={emptyContextMenu}>
        <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const ent = rows[item.index].original;
            return (
              // biome-ignore lint/a11y/useSemanticElements: 虚拟化表格行是绝对定位的 CSS Grid 行，<button> 默认盒模型会破坏几何；键盘语义已按 button 补全
              <div
                key={item.key}
                className="fm-entry fm-table-row"
                data-selected={selected.has(ent.path)}
                data-surface={SURFACE_LIST}
                role="button"
                tabIndex={0}
                aria-pressed={selected.has(ent.path)}
                style={{
                  ...tableRowStyle,
                  transform: `translateY(${item.start}px)`,
                  gridTemplateColumns: gridTemplate,
                }}
                onClick={() => onFocus(ent)}
                onDoubleClick={() => onEnter(ent)}
                onContextMenu={(e) => itemContextMenu(SURFACE_LIST, e, ent)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onFocus(ent);
                    onEnter(ent);
                  }
                  if (e.key === " ") {
                    e.preventDefault();
                    onFocus(ent);
                  }
                  itemContextKey(SURFACE_LIST, e, ent);
                }}
                title={ent.isDir ? "双击进入" : undefined}
              >
                {rows[item.index].getVisibleCells().map((cell) => (
                  <div key={cell.id} className="fm-table-cell" style={tableCellStyle}>
                    <table.FlexRender cell={cell} />
                  </div>
                ))}
              </div>
            );
          })}
        </div>
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
 *  A `null` dataUrl is a remembered refusal, so an unsupported format is never
 *  re-decoded on every scroll pass. Each value carries the file version it was
 *  produced from (P7-7): when the entry's size/mtime change, the cached image and
 *  any in-flight response are both stale and must not be shown. */
interface ThumbValue {
  dataUrl: string | null;
  version: string;
}

const thumbCache = new Map<string, ThumbValue>();

/** 条目上可当版本号的字段：清单已经带来，无需再 `fs.stat`。 */
function entryVersion(ent: ListEntry): string {
  return `${ent.size ?? ""}@${ent.modifiedMs ?? ""}`;
}

function rememberThumb(path: string, value: ThumbValue): void {
  if (thumbCache.size >= THUMB_CACHE_MAX) {
    for (const oldest of [...thumbCache.keys()].slice(0, THUMB_CACHE_MAX / 2)) {
      thumbCache.delete(oldest);
    }
  }
  thumbCache.set(path, value);
}

/** A card's picture slot. Asks the gated `shell.thumbnail.read` capability for the
 *  **Windows Shell's own** thumbnail once the row has settled, and shows the type
 *  icon until (or unless) it answers — so scrolling a huge directory pulls ~a
 *  screen of images, not all of them, and a miss / unsupported type / denial is
 *  just an icon. The plugin never decodes or draws anything itself. */
function Thumb({ host, entry }: { host: PluginHost; entry: ListEntry }) {
  const enabled = usePrefs().thumbnails;
  const candidate = enabled && !entry.isDir && THUMB_CANDIDATES.has(extensionOf(entry.name));
  const version = entryVersion(entry);
  const [dataUrl, setDataUrl] = useState<string | null>(() => {
    const known = thumbCache.get(entry.path);
    return known && known.version === version ? known.dataUrl : null;
  });
  /** 渲染期同步的最新版本：响应落地前再核对一次，文件换了就不认这张图。 */
  const versionRef = useRef(version);
  versionRef.current = version;

  useEffect(() => {
    if (!candidate) return;
    const known = thumbCache.get(entry.path);
    if (known && known.version === version) {
      setDataUrl(known.dataUrl);
      return;
    }
    // 卡片滚出窗口 / 换目录 / 版本变化都会先跑 cleanup：迟到的响应一律丢弃。
    // 走到这里说明缓存与当前版本不符：先收起旧图，旧图不能冒充新内容。
    setDataUrl(null);
    let stillVisible = true;
    const timer = setTimeout(() => {
      host
        .invoke<ShellThumbnailOut>(Capabilities.shellThumbnailRead, {
          path: entry.path,
          edge: THUMB_EDGE,
        })
        .then(
          (out) => {
            if (!stillVisible || versionRef.current !== version) return;
            // 只有 ready 带图；cache-miss / unsupported-type / denied… 都回落到图标，
            // 并按同一身份缓存，避免每次滚回来都重问一次系统。
            const url = out?.state === "ready" ? out.dataUrl : null;
            rememberThumb(entry.path, { dataUrl: url, version });
            setDataUrl(url);
          },
          () => {
            if (!stillVisible || versionRef.current !== version) return;
            rememberThumb(entry.path, { dataUrl: null, version });
            setDataUrl(null);
          },
        );
    }, THUMB_SETTLE_MS);
    return () => {
      stillVisible = false;
      clearTimeout(timer);
    };
  }, [candidate, entry.path, host, version]);

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

/** 路径最后一段（`C:/` 这类根路径返回原样），给标签成员合成显示名用。 */
function baseNameOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const tail = idx >= 0 ? path.slice(idx + 1) : path;
  return tail || path;
}

const extensionOf = (name: string): string => {
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
};

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

const tableAreaStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0,
};

const tableHeadStyle: CSSProperties = {
  display: "grid",
  alignItems: "center",
  gap: 8,
  padding: "0 10px",
  height: 30,
  flexShrink: 0,
  // 行是 .fm-entry，基座给它 1px 透明边框（border-box 下吃掉 2px 内容宽）。表头
  // 画上同样的左右边框，两侧的内容框才等宽，固定列不会整体错开 2px。
  borderLeft: "1px solid transparent",
  borderRight: "1px solid transparent",
  borderBottom: "1px solid var(--mantine-color-default-border)",
  background: "var(--mantine-color-default-hover)",
};

const tableRowStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  width: "100%",
  display: "grid",
  alignItems: "center",
  gap: 8,
  padding: "0 10px",
  height: TABLE_ROW_HEIGHT,
  cursor: "pointer",
};

const sortButtonStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  width: "100%",
  padding: 0,
  border: 0,
  background: "transparent",
  color: "inherit",
  font: "inherit",
  fontSize: 12,
  fontWeight: 600,
  textAlign: "left",
  cursor: "pointer",
};

const tableCellStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
};

const sizeCellStyle: CSSProperties = {
  width: "100%",
  textAlign: "right",
  fontVariantNumeric: "tabular-nums",
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
