/**
 * `plugin-search` — 名称检索（roadmap P6-9 / P7-28 / P7-29 / P7-30，docs/05 D24）。
 *
 * 落点是「顶栏入口 + 自有浮层面板」，与 `plugin-settings`、`plugin-storage-analysis`
 * 同一做法：`pane-slot:*` 的出口是 `overflow: hidden` 的单列容器，栏位高度已被文件
 * 浏览占满，第二个贡献者进去只会被裁掉。检索要的是一块能稳定列结果的面积，所以做成
 * 固定尺寸浮层——输入中、索引中、有结果、无结果、索引不完整这几种状态下面板的宽高与
 * 位置都不变，正文超出只在面板内部滚动。
 *
 * 数据通道全部走冻结契约（能力名 / 事件名 / DTO 取自 `@my-file-manager/plugin-sdk`，
 * Rust 侧是唯一事实源，`contract:check` 守住两边一致）：
 * - `search.status` 读索引状态，不遍历任何目录；
 * - `search.query` 是**分页的请求/响应**（`offset` + `hasMore`），结果不再另发事件——
 *   路线图里的 `search:results` 已折进这里（docs/05 D24），"取更多"把下一页接在后面；
 * - `search.index.start` **只回确认**（`{ jobId, roots, state }`），进度经节流的
 *   `search:index-progress` 送达、终态经 `search:index-done` 送达，与 `sys.scan.start`
 *   同一套「排队 + 事件」分工；`search.index.cancel` 返回布尔。
 *
 * 数字纪律：进度只有真实条目数与真实耗时，没有自造的百分比——条目上限让总数事先未知。
 * `state` 是 `partial` / `failed` 时必须显示 provider 给的中文 `detail`，并且界面要说
 * 结果**可能不完整**：把"还没索引到"说成"没有匹配"是契约禁止的谎话。
 *
 * 打开命中：双击交给系统默认程序（`shell.openPath`）；「打开所在目录」发
 * `sidebar:selection:changed` 引用，由文件浏览栏位自己去导航——界面不持有第二份
 * "当前目录"，也不跨插件伸手私有状态。
 */

import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Popover,
  ScrollArea,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  Capabilities,
  Events,
  errorMessage,
  formatDate,
  formatSize,
  type PickOut,
  type PluginHost,
  type Ref,
  SEARCH_MAX_PAGE,
  SEARCH_MAX_TEXT_CHARS,
  SEARCH_TRIGRAM_MIN_CHARS,
  type SearchHit,
  type SearchIndexAck,
  type SearchIndexDonePayload,
  type SearchIndexProgressPayload,
  type SearchQueryOut,
  type SearchScope,
  type SearchStatusOut,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";
import { FolderOpen, X } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

// ───────────────────────────── 常量与偏好 ─────────────────────────────

const PANEL_WIDTH = 620;
const PANEL_HEIGHT = 640;
/** 一页要多少条：在 `SEARCH_MAX_PAGE` 之内，由界面决定，不让 provider 猜。 */
const PAGE_SIZE = Math.min(50, SEARCH_MAX_PAGE);
/** 停手才查：每敲一个字就查一次，答案会跟着手不停改口。 */
const QUERY_DEBOUNCE_MS = 300;

const PREFS_KEY = "fm.search.prefs.v1";

interface SearchPrefs {
  /** 默认的筛选范围。 */
  scope: SearchScope;
  /** 打开面板时把检索限定在当前浏览的目录里。 */
  withinCurrent: boolean;
}

const DEFAULT_PREFS: SearchPrefs = { scope: "all", withinCurrent: false };

/** 浮层每次打开都是一次新挂载。检索词记在模块里（不是偏好，也不落盘）：为了看一眼
 *  别处而关掉面板的人，重开时不该从空白重新开始。 */
let lastQuery = "";

function readPrefs(): SearchPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const parsed = JSON.parse(raw) as Partial<SearchPrefs>;
    return {
      scope: parsed.scope === "file" || parsed.scope === "dir" ? parsed.scope : "all",
      withinCurrent: parsed.withinCurrent === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

let prefs: SearchPrefs = readPrefs();
const prefsListeners = new Set<() => void>();

function patchPrefs(patch: Partial<SearchPrefs>): void {
  prefs = { ...prefs, ...patch };
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // 存不下（隐私模式等）：偏好本次会话内照样生效
  }
  for (const listener of prefsListeners) listener();
}

// 整套偏好订阅样板就这一处：与 `plugin-file-browser` 同一写法（模块级对象 + 监听集），
// React 侧只有 useSyncExternalStore 一个名字可用。
function usePrefs(): SearchPrefs {
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

// ───────────────────────────── 文案小工具 ─────────────────────────────

const count = (n: number): string => n.toLocaleString("zh-CN");

function duration(ms: number): string {
  if (ms < 1_000) return `${ms} 毫秒`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`;
}

/** 索引那一行的事实：来自 `search.status`，界面只组织语序，不补数字。 */
function statusLine(status: SearchStatusOut | null): string {
  if (!status) return "正在询问索引状态…";
  const entries = count(status.entries);
  if (status.state === "empty") return "还没有索引：先选一个目录开始索引。";
  if (status.state === "indexing") return `索引进行中，已收录 ${entries} 项。`;
  const job = status.lastJobMs > 0 ? `，用时 ${duration(status.lastJobMs)}` : "";
  const roots = status.roots.length > 0 ? ` · 根目录 ${count(status.roots.length)} 个` : "";
  if (status.state === "ready") return `已收录 ${entries} 项${job}${roots}。`;
  if (status.state === "partial") {
    return `已收录 ${entries} 项${job}${roots}。索引不完整：${status.detail ?? "上次任务未走完"}`;
  }
  return `索引失败：${status.detail ?? "未知原因"}`;
}

/** 宿主给的是稳定错误前缀，界面换成人话；与 `plugin-storage-analysis` 同一分工。 */
function userError(err: unknown): string {
  const text = errorMessage(err);
  if (/permission denied/i.test(text)) return "没有权限访问该路径。";
  if (/not found/i.test(text)) return "找不到该路径，可能已被移动或删除。";
  if (/invalid argument/i.test(text)) return text.replace(/^invalid argument:\s*/, "");
  return text || "操作未能完成。";
}

/** 当前浏览的目录只从元状态的引用推：界面不自己记一份"当前目录"。 */
function currentDirOf(host: PluginHost): string {
  const state = host.getState();
  for (const ref of [state.focusRef, state.sidebarSelection]) {
    if (!ref) continue;
    if (ref.kind === "folder") return ref.id;
    if (ref.kind === "file") return parentOf(ref.id);
  }
  return "";
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index > 0 ? trimmed.slice(0, index) : "";
}

// ───────────────────────────── 入口 ─────────────────────────────

/** 命令面板要能隔着一层模块状态把面板打开；工具栏挂载时登记这个把手。 */
let openSearchPanel: (() => void) | null = null;

export function activate(host: PluginHost): void {
  // 组件由基座按 manifest 的具名导出挂载，这里只登记命令（roadmap P7-30）：
  // 快捷键由基座统一调度，插件不自己挂 window 监听。
  host.commands?.register({
    id: "search.open",
    title: "打开搜索面板",
    group: "搜索",
    subtitle: "按名称检索已索引的文件",
    shortcut: "Ctrl+Shift+F",
    run: () => {
      if (!openSearchPanel) throw new Error("搜索界面尚未就绪。");
      openSearchPanel();
    },
  });
  host.commands?.register({
    id: "search.index-current",
    title: "为当前目录建立索引",
    group: "搜索",
    subtitle: "索引完自动打开搜索面板，可看实时进度",
    run: async () => {
      const dir = currentDirOf(host);
      if (!dir) throw new Error("先选中一个目录，再为它建立索引。");
      await host.invoke(Capabilities.searchIndexStart, { roots: [dir], rebuild: false });
      // 任务已受理：打开面板，进度事件会自己找上它（面板订阅的是总线，不是这次调用）。
      openSearchPanel?.();
    },
  });
}

/** 顶栏入口：点开才是一块固定尺寸的检索面板。 */
export function SearchToolbar({ host }: SlotProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    openSearchPanel = () => setOpen(true);
    return () => {
      openSearchPanel = null;
    };
  }, []);
  return (
    <Popover
      opened={open}
      onChange={setOpen}
      position="bottom-end"
      offset={10}
      width={PANEL_WIDTH}
      shadow="md"
      middlewares={{ flip: false, shift: { padding: 8 } }}
      styles={{ dropdown: dropdownStyle }}
    >
      <Popover.Target>
        <Button
          size="xs"
          variant="default"
          aria-label="搜索"
          aria-pressed={open}
          title="搜索已索引的文件名"
          data-testid="search-open"
          onClick={() => setOpen(!open)}
        >
          搜索
        </Button>
      </Popover.Target>

      <Popover.Dropdown>
        <SearchPanel host={host} onClose={() => setOpen(false)} />
      </Popover.Dropdown>
    </Popover>
  );
}

// ───────────────────────────── 面板 ─────────────────────────────

/** 一条正在跑的索引任务：数字全部来自 `search:index-progress`。 */
interface LiveJob {
  jobId: string;
  entries: number;
  currentPath: string;
  elapsedMs: number;
}

function SearchPanel({ host, onClose }: { host: PluginHost; onClose: () => void }) {
  const initial = usePrefs();
  const [draft, setDraft] = useState(lastQuery);
  const [submitted, setSubmitted] = useState(lastQuery);
  const [scope, setScope] = useState<SearchScope>(initial.scope);
  const [withinCurrent, setWithinCurrent] = useState(initial.withinCurrent);
  // 索引目录草稿默认跟着正在浏览的目录：到这里点索引的人，多半就要索引眼前这堆文件。
  const [rootDraft, setRootDraft] = useState(() => currentDirOf(host));
  const [status, setStatus] = useState<SearchStatusOut | null>(null);
  const [job, setJob] = useState<LiveJob | null>(null);
  const [page, setPage] = useState<SearchQueryOut | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 分页响应会迟到：只有最后一次请求的结果可以写进界面。 */
  const seqRef = useRef(0);
  const hostRef = useRef(host);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  hostRef.current = host;

  // 面板跟着浮层一起挂载：光标落在检索框，用户不必再点一次才开始输入。
  useEffect(() => {
    searchInputRef.current?.focus();
  }, []);

  const within = withinCurrent ? currentDirOf(host) : "";
  const indexing = job !== null || status?.state === "indexing";

  const refreshStatus = useCallback((): void => {
    hostRef.current
      .invoke<SearchStatusOut>(Capabilities.searchStatus)
      .then(setStatus)
      .catch((err) => setError(userError(err)));
  }, []);

  useEffect(refreshStatus, [refreshStatus]);

  const query = useCallback(
    (needle: string, offset: number, reset: boolean, whichScope: SearchScope, withinDir: string) => {
      const trimmed = needle.trim().slice(0, SEARCH_MAX_TEXT_CHARS);
      if (!trimmed) {
        seqRef.current++;
        setHits([]);
        setPage(null);
        return;
      }
      const seq = ++seqRef.current;
      if (reset) setError(null);
      else setLoadingMore(true);
      hostRef.current
        .invoke<SearchQueryOut>(Capabilities.searchQuery, {
          text: trimmed,
          scope: whichScope,
          within: withinDir.length > 0 ? withinDir : null,
          limit: PAGE_SIZE,
          offset,
        })
        .then((out) => {
          if (seq !== seqRef.current) return;
          // 分页是"接着上面往下长"，不是"换一页"：增量加载时用户不该看到已读过的行消失。
          setHits((prev) => (reset ? out.hits : [...prev, ...out.hits]));
          setPage(out);
        })
        .catch((err) => {
          if (seq !== seqRef.current) return;
          setError(userError(err));
        })
        .finally(() => {
          if (seq === seqRef.current) setLoadingMore(false);
        });
    },
    [],
  );

  // 索引变了就重跑当前这条查询：否则界面留着"没有匹配"，而它其实已经是"有匹配、
  // 但当时还没索引到"。
  const rerunRef = useRef<() => void>(() => {});
  useEffect(() => {
    rerunRef.current = () => query(submitted, 0, true, scope, within);
  });

  useEffect(() => {
    const offProgress = hostRef.current.on<SearchIndexProgressPayload>(Events.searchIndexProgress, (payload) => {
      setJob({
        jobId: payload.jobId,
        entries: payload.entries,
        currentPath: payload.currentPath,
        elapsedMs: payload.elapsedMs,
      });
      setStatus((prev) => (prev ? { ...prev, state: "indexing", entries: payload.entries } : prev));
    });
    const offDone = hostRef.current.on<SearchIndexDonePayload>(Events.searchIndexDone, (payload) => {
      setJob(null);
      // 任务一结束，上一条"已经有一个任务在跑"的抱怨就不再描述现实：留着它，界面会
      // 指着空按钮说这里还被占着。
      setError(null);
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              state: payload.state,
              entries: payload.entries,
              roots: payload.roots,
              lastJobMs: payload.elapsedMs,
              detail: payload.detail ?? null,
            }
          : {
              state: payload.state,
              entries: payload.entries,
              roots: payload.roots,
              lastJobMs: payload.elapsedMs,
              detail: payload.detail ?? null,
            },
      );
      rerunRef.current();
    });
    return () => {
      offProgress();
      offDone();
    };
  }, []);

  // 输入停顿后查；范围或限定目录一换也重查（它们改变的是"同一句话的答案集合"）。
  useEffect(() => {
    if (!submitted.trim()) {
      seqRef.current++;
      setHits([]);
      setPage(null);
      return;
    }
    const timer = setTimeout(() => query(submitted, 0, true, scope, within), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [submitted, scope, within, query]);

  const submit = (): void => {
    const next = draft.trim().slice(0, SEARCH_MAX_TEXT_CHARS);
    setDraft(next);
    lastQuery = next;
    if (next === submitted) {
      query(next, 0, true, scope, within);
      return;
    }
    setSubmitted(next);
  };

  const loadMore = (): void => {
    if (!page?.hasMore) return;
    query(submitted, hits.length, false, scope, within);
  };

  const pickRoot = (): void => {
    hostRef.current
      .invoke<PickOut>(Capabilities.shellPickDirectory, { multiple: false })
      .then((out) => {
        if (out.cancelled || out.paths.length === 0) return;
        setRootDraft(out.paths[0]);
        setError(null);
      })
      .catch((err) => setError(userError(err)));
  };

  /** 留空 = 全部已索引的根目录；重建会丢掉不在本次根目录里的行。 */
  const startIndex = (rebuild: boolean): void => {
    const roots = rootDraft.trim() ? [rootDraft.trim()] : [];
    hostRef.current
      .invoke<SearchIndexAck>(Capabilities.searchIndexStart, { roots, rebuild })
      .then((ack) => {
        setError(null);
        setJob({ jobId: ack.jobId, entries: 0, currentPath: roots[0] ?? "", elapsedMs: 0 });
        setStatus((prev) =>
          prev ? { ...prev, state: "indexing", roots: ack.roots.length > 0 ? ack.roots : prev.roots } : prev,
        );
      })
      .catch((err) => setError(userError(err)));
  };

  const cancelIndex = (): void => {
    if (!job) return;
    hostRef.current
      .invoke<boolean>(Capabilities.searchIndexCancel, { jobId: job.jobId })
      .then((stopped) => {
        if (!stopped) setError("该索引任务已经结束。");
      })
      .catch((err) => setError(userError(err)));
  };

  const openHit = (hit: SearchHit): void => {
    hostRef.current
      .invoke<boolean>(Capabilities.shellOpenPath, { path: hit.path })
      .catch((err) => setError(userError(err)));
  };

  const revealDir = (hit: SearchHit): void => {
    const ref: Ref = {
      kind: hit.isDir ? "folder" : "file",
      id: hit.path,
      sourcePlugin: hostRef.current.name,
    };
    hostRef.current.emit(Events.sidebarSelectionChanged, ref);
  };

  const partial = page !== null && (page.state === "partial" || page.state === "failed");
  const summary = summarize(submitted, page, hits.length, scope, within);

  return (
    <div className="fm-search-panel" data-testid="search-panel" style={panelStyle}>
      <Group gap={8} wrap="nowrap" style={headerStyle}>
        <Title order={6} tt="none">
          搜索
        </Title>
        <Text size="xs" c="dimmed" tt="none" truncate style={{ minWidth: 0 }} data-testid="search-status">
          {statusLine(status)}
        </Text>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          title="关闭搜索"
          aria-label="关闭搜索"
          data-testid="search-close"
          style={{ marginLeft: "auto" }}
          onClick={onClose}
        >
          <X size={14} />
        </ActionIcon>
      </Group>

      <Group gap={6} wrap="nowrap" style={lineStyle(34)}>
        <TextInput
          ref={searchInputRef}
          aria-label="检索名称"
          placeholder="输入名称的一部分"
          data-testid="search-text"
          size="xs"
          value={draft}
          onChange={(e) => setDraft(e.target.value.slice(0, SEARCH_MAX_TEXT_CHARS))}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          styles={{ input: inputStyle }}
          style={{ flex: 1, minWidth: 0 }}
        />
        <SegmentedControl
          size="xs"
          data-testid="search-scope"
          value={scope}
          onChange={(value) => setScope(value as SearchScope)}
          data={[
            { value: "all", label: "全部" },
            { value: "file", label: "文件" },
            { value: "dir", label: "文件夹" },
          ]}
        />
        <Button
          size="xs"
          variant={withinCurrent ? "filled" : "default"}
          data-testid="search-within"
          title={
            withinCurrent
              ? within
                ? `只在 ${within} 及其子目录里搜`
                : "当前没有可限定的目录，先在文件浏览里选一个"
              : "搜全部已索引的根目录"
          }
          onClick={() => setWithinCurrent(!withinCurrent)}
        >
          {withinCurrent ? "当前目录" : "全部索引"}
        </Button>
      </Group>

      <Group gap={6} wrap="nowrap" style={lineStyle(34)}>
        <TextInput
          aria-label="要索引的目录"
          placeholder="要索引的目录（留空 = 全部已索引目录）"
          data-testid="search-index-dir"
          size="xs"
          value={rootDraft}
          onChange={(e) => setRootDraft(e.target.value)}
          styles={{ input: inputStyle }}
          style={{ flex: 1, minWidth: 0 }}
          disabled={indexing}
        />
        <Button
          size="xs"
          variant="default"
          title="选择要索引的目录"
          aria-label="选择要索引的目录"
          data-testid="search-index-pick"
          disabled={indexing}
          onClick={pickRoot}
        >
          选择…
        </Button>
        {indexing ? (
          <Button
            size="xs"
            variant="filled"
            color="red"
            title="停止索引任务"
            aria-label="停止索引任务"
            data-testid="search-index-cancel"
            onClick={cancelIndex}
          >
            取消索引
          </Button>
        ) : (
          <>
            <Button
              size="xs"
              variant="filled"
              title="把选中的目录补进索引（不影响其他根目录）"
              aria-label="刷新索引"
              data-testid="search-index-start"
              onClick={() => startIndex(false)}
            >
              索引
            </Button>
            <Button
              size="xs"
              variant="outline"
              title="丢弃现有索引，只索引上面这个目录"
              aria-label="重建索引"
              data-testid="search-index-rebuild"
              onClick={() => startIndex(true)}
            >
              重建
            </Button>
          </>
        )}
      </Group>

      {job ? (
        <Text size="xs" c="dimmed" truncate data-testid="search-progress" style={lineStyle(18)}>
          已收录 {count(job.entries)} 项 · 用时 {duration(job.elapsedMs)}
          {job.currentPath ? ` · 正在读取 ${job.currentPath}` : ""}
        </Text>
      ) : null}

      <ScrollArea type="always" style={resultStyle} data-testid="search-results">
        {resultBody({ submitted, page, hits, partial, onOpen: openHit, onReveal: revealDir })}
      </ScrollArea>

      <Group gap={8} wrap="nowrap" style={footerStyle}>
        <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }} data-testid="search-summary">
          {summary}
        </Text>
        {page?.hasMore ? (
          <Button
            size="xs"
            variant="default"
            loading={loadingMore}
            data-testid="search-more"
            style={{ marginLeft: "auto" }}
            onClick={loadMore}
          >
            取更多
          </Button>
        ) : null}
        {partial ? (
          <Badge size="xs" color="yellow" data-testid="search-partial">
            索引不完整
          </Badge>
        ) : null}
      </Group>

      {error ? (
        <Text size="xs" c="red" truncate data-testid="search-error">
          {error}
        </Text>
      ) : null}
    </div>
  );
}

/** 结果区说什么，取决于索引状态而不是命中数——"没有索引"与"没有匹配"是两件事。 */
function resultBody(opts: {
  submitted: string;
  page: SearchQueryOut | null;
  hits: SearchHit[];
  partial: boolean;
  onOpen: (hit: SearchHit) => void;
  onReveal: (hit: SearchHit) => void;
}): ReactNode {
  if (!opts.submitted.trim()) {
    return <Hint>输入名称的一部分即可检索。少于 {SEARCH_TRIGRAM_MIN_CHARS} 个字符时走逐字扫描，会慢一些。</Hint>;
  }
  if (opts.page?.state === "empty") {
    return <Hint>还没有索引，先索引一个目录才搜得到东西。</Hint>;
  }
  if (opts.hits.length === 0) {
    return (
      <Hint>{opts.partial ? "索引里目前没有匹配的名称；索引不完整，结果可能不止这些。" : "没有匹配的名称。"}</Hint>
    );
  }
  return (
    <Stack gap={2}>
      {opts.hits.map((hit) => (
        <HitRow key={hit.path} hit={hit} onOpen={opts.onOpen} onReveal={opts.onReveal} />
      ))}
    </Stack>
  );
}

function summarize(
  text: string,
  page: SearchQueryOut | null,
  shown: number,
  scope: SearchScope,
  within: string,
): string {
  if (!text.trim()) return "等待输入";
  if (!page) return "正在检索…";
  const where = scope === "all" ? "" : scope === "dir" ? "（只算文件夹）" : "（只算文件）";
  const scope2 = within ? `（限 ${within}）` : "";
  return `“${text}”${where}${scope2}：共 ${count(page.total)} 项，已显示 ${count(shown)} 项 · ${duration(page.tookMs)}`;
}

function HitRow({
  hit,
  onOpen,
  onReveal,
}: {
  hit: SearchHit;
  onOpen: (hit: SearchHit) => void;
  onReveal: (hit: SearchHit) => void;
}) {
  return (
    <Group gap={6} wrap="nowrap" data-testid="search-row" style={rowStyle}>
      <UnstyledButton
        style={{ minWidth: 0, flex: 1, textAlign: "left" }}
        onDoubleClick={() => onOpen(hit)}
        title="双击用系统默认程序打开"
      >
        <Text size="xs" truncate style={nameStyle(hit.isDir)}>
          {hit.name}
        </Text>
        <Text size="xs" c="dimmed" truncate title={hit.parent}>
          {hit.parent}
        </Text>
      </UnstyledButton>
      <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
        {hit.isDir ? "文件夹" : `${formatSize(hit.size)} · ${formatDate(hit.modifiedMs, "")}`}
      </Text>
      <Tooltip label="在文件浏览里打开它所在目录" withArrow>
        <ActionIcon
          variant="subtle"
          color="gray"
          size="sm"
          aria-label="打开所在目录"
          data-testid="search-reveal"
          onClick={() => onReveal(hit)}
        >
          <FolderOpen size={14} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" c="dimmed" data-testid="search-hint" style={{ paddingTop: 8 }}>
      {children}
    </Text>
  );
}

/** 设置页：内容只有本插件认得，写的也是自己的偏好存储。 */
export function SettingsPage() {
  const current = usePrefs();
  return (
    <Stack gap="md" data-testid="search-settings">
      <div>
        <Text size="sm" fw={600}>
          默认筛选范围
        </Text>
        <Text size="xs" c="dimmed" mb={6}>
          打开搜索面板时先按这个范围查；面板里随时能改，改的只是下一次查询。
        </Text>
        <SegmentedControl
          size="xs"
          data-testid="search-settings-scope"
          value={current.scope}
          onChange={(value) => patchPrefs({ scope: value as SearchScope })}
          data={[
            { value: "all", label: "全部" },
            { value: "file", label: "文件" },
            { value: "dir", label: "文件夹" },
          ]}
        />
      </div>
      <div>
        <Switch
          size="xs"
          label="默认只在当前浏览的目录里搜"
          checked={current.withinCurrent}
          onChange={(e) => patchPrefs({ withinCurrent: e.currentTarget.checked })}
        />
        <Text size="xs" c="dimmed" mt={4}>
          关掉则默认搜全部已索引的根目录；面板顶部随时能切换。
        </Text>
      </div>
      <Text size="xs" c="dimmed" title={`偏好存储键：${PREFS_KEY}`}>
        这些设置只属于搜索功能，不影响其他插件。
      </Text>
    </Stack>
  );
}

// ───────────────────────────── 样式 ─────────────────────────────

/** 面板固定尺寸：换状态只换内容，绝不让浮层自适应内容后重算定位。 */
const dropdownStyle: CSSProperties = {
  width: PANEL_WIDTH,
  height: PANEL_HEIGHT,
  padding: 0,
  overflow: "hidden",
};

const panelStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  height: "100%",
  padding: 10,
  minHeight: 0,
};

const headerStyle: CSSProperties = { paddingBottom: 6, flexShrink: 0 };

const lineStyle = (height: number): CSSProperties => ({ height, flexShrink: 0, overflow: "hidden" });

const inputStyle: CSSProperties = { fontSize: 12, height: 30 };

const resultStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  borderTop: "1px solid var(--mantine-color-default-border)",
  paddingTop: 6,
};

const rowStyle: CSSProperties = { padding: "2px 4px", minHeight: 34 };

/** 底部摘要那一行钉死高度：结果多少都只动上方滚动区，按钮与徽标不跟着上下跳。 */
const footerStyle: CSSProperties = {
  height: 30,
  flexShrink: 0,
  overflow: "hidden",
  borderTop: "1px solid var(--mantine-color-default-border)",
  paddingTop: 4,
};

const nameStyle = (isDir: boolean): CSSProperties => ({
  color: isDir ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-text)",
  fontWeight: isDir ? 600 : 400,
});
