/**
 * `plugin-storage-analysis` — 空间分析（roadmap P7-24，docs/plugin-functional/
 * plugin-storage-analysis.md）。
 *
 * 界面走「顶栏入口 + 自有浮层面板」。功能书写的是把可视化注入 `pane-slot:*`，但栏位
 * 出口是 `overflow: hidden` 的单列容器、`plugin-file-browser` 的栏位已占满 100% 高度，
 * 第二个贡献者进去只会被裁掉而看不见；空间分析要的是一块能稳定画矩形图的面积，所以
 * 落点换成与 `plugin-settings` 同一做法的固定尺寸浮层：顶栏一个入口按钮，点击后在界面
 * 之上开面板。选根目录 / 扫描中 / 结果 / 下钻 四种状态下面板宽高与位置都不变，正文
 * 超出只在面板内部滚动（几何稳定是红线，不能让浮层自适应内容后重算定位）。
 *
 * 数据通道是 P7-23 的 wire 形状，能力名/事件名/DTO 类型一律直接取自
 * `@my-file-manager/plugin-sdk`（Rust 侧是唯一事实源，`contract:check` 守住两边一致）：
 * - `sys.disk.list` 给根目录所在卷的可用/总字节与文件系统类型；
 * - `sys.scan.start` **只回确认**（`{ scanId, state: "queued", rootPath }`），进度经
 *   节流的 `scan:progress` 送达，聚合树与跳过清单经 `scan:done` 送达 —— 与
 *   `shell.fileOperation` 的「排队 + 事件」同一套分工；
 * - `sys.scan.cancel` 返回布尔；取消后的终态带 `cancelled: true`，界面只显示「已取消」
 *   和不完整说明，既不画半截矩形图也不写缓存。
 *
 * 数字纪律：进度只有真实条目数与真实字节数，没有自造的百分比；被跳过的目录（没有权限 /
 * 找不到路径 / 路径不合法 / 读取失败 / 超出扫描预算）单独成列、给出中文原因，并且
 * **不计入**总量；大小沿用「文件详情」那套 `formatSize` 写法。
 *
 * 缓存按路径 + 时间：内存里的聚合结果以根目录路径为 key、带 TTL，命中时面板明说结果
 * 来自缓存并给出扫描时刻；`file:changed` 落在缓存的根目录下就立刻作废该条并说明原因。
 *
 * 矩形图用 echarts 自己的 treemap（`echarts/core` + `TreemapChart` + `CanvasRenderer`
 * 按需引入），块面积等于体积；下钻是本插件自己的状态（面包屑 + 返回），只画当前层体积
 * 最大的前若干块，其余合并成「其他」并保留能逐项查看的明细入口。块画在 canvas 上、
 * 不进 DOM，所以几十万条目也不会压垮页面。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Popover,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  Title,
  UnstyledButton,
} from "@mantine/core";
import {
  Capabilities,
  Events,
  errorMessage,
  type DiskListOut,
  type DiskVolume,
  type PickOut,
  type ScanAck,
  type ScanDonePayload,
  type ScanNode,
  type ScanProgressPayload,
  type ScanSkipped,
  type ScanSkipReason,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";
import * as echarts from "echarts/core";
import { TreemapChart } from "echarts/charts";
import { TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([TreemapChart, TooltipComponent, CanvasRenderer]);

// ───────────────────────── wire 原因码 → 中文 ─────────────────────────
// 线上只走稳定原因码（`ScanSkipReason`），中文句子由界面写：与 `FileFailureReason`
// 同一分工，provider 不越界生成用户可见文案。

const SKIP_REASON_TEXT: Record<ScanSkipReason, string> = {
  "not-found": "找不到该路径，可能已被移动或删除",
  denied: "没有权限访问该目录",
  "invalid-argument": "路径不合法，无法读取",
  "read-failed": "读取该目录失败",
  "budget-exceeded": "已达单次扫描的条目上限，该目录未继续统计",
  "too-deep": "层级过深，未继续统计",
  "symlink-skipped": "目录链接未跟随，未统计",
  "not-a-directory": "该路径不是目录，未统计",
};

const skipReasonText = (reason: ScanSkipReason): string => SKIP_REASON_TEXT[reason];

// ───────────────────────────── 常量 ─────────────────────────────

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 640;
/** 矩形图容器高度写死：状态切换不得改变面板尺寸。 */
const CHART_HEIGHT = 300;
const BREADCRUMB_HEIGHT = 34;
const LINE_HEIGHT = 18;
/** 一次只画前若干块，其余合并进「其他」——几万块同屏既读不出也画不下。 */
const MAX_TILES = 24;
/** 缓存有效期：同一根目录在期内复用聚合结果，面板会写明结果是缓存。 */
const CACHE_TTL_MS = 5 * 60_000;

interface CacheEntry {
  at: number;
  tree: ScanNode;
  skipped: ScanSkipped[];
  truncatedAtDepth: number | null;
  elapsedMs: number;
  entries: number;
  bytes: number;
}

/** 内存缓存，key 是根目录路径：跨面板开关留着，按路径与 TTL 作废。 */
const treeCache = new Map<string, CacheEntry>();

type Phase = "idle" | "scanning" | "cancelling" | "result" | "cancelled" | "failed";

interface View {
  root: string;
  tree: ScanNode;
  skipped: ScanSkipped[];
  truncatedAtDepth: number | null;
  elapsedMs: number;
  entries: number;
  bytes: number;
  fromCacheAt: number | null;
}

/** 与「文件详情」面板同一个大小写法：界面里不能出现第二套单位格式。 */
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

const count = (n: number): string => n.toLocaleString("zh-CN");

const clock = (ms: number): string => new Date(ms).toLocaleTimeString("zh-CN", { hour12: false });

/** 能力错误 → 中文原因；provider 的前缀（`permission denied:` 等）不进界面。 */
function userError(err: unknown): string {
  const text = errorMessage(err);
  if (/permission denied/i.test(text)) return "没有权限读取该目录。";
  if (/not found/i.test(text)) return "找不到该路径，可能已被移动或删除。";
  if (/invalid argument/i.test(text)) return "路径无效，无法开始扫描。";
  return text || "扫描未能开始。";
}

const baseName = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) || "/" : trimmed;
};

const underRoot = (child: string, root: string): boolean =>
  child === root || child.startsWith(`${root.replace(/\/+$/, "")}/`);

/** 缓存 key：去掉尾斜杠，`/demo/` 与 `/demo` 是同一次扫描。 */
const cacheKey = (path: string): string => path.replace(/\/+$/, "") || path;

export function activate(): void {
  // 入口按钮挂载时才建立订阅；activate 没有需要预先准备的东西。
}

export function StorageAnalysisToolbar({ host }: SlotProps) {
  const [open, setOpen] = useState(false);
  const [rootDraft, setRootDraft] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [view, setView] = useState<View | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [progress, setProgress] = useState<ScanProgressPayload | null>(null);
  const [volume, setVolume] = useState<DiskVolume | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 「其他」块的明细：合并了就必须在界面上留一条能看到具体项目的路。 */
  const [mergedOpen, setMergedOpen] = useState(false);

  /** 在途扫描的 id：事件带 scanId，只有这一条能改界面，迟到的答案一律丢弃。 */
  const scanIdRef = useRef<string | null>(null);
  /** 排队确认还没回来就被关掉了：界面没有在途扫描可取消，所以留个标记，等 ack 一到就取消。 */
  const abandonRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;
  const aliveRef = useRef(true);
  const hostRef = useRef(host);
  hostRef.current = host;
  /** 渲染中同步读取当前视图，事件回调里不必等 state 落地。 */
  const viewRef = useRef<View | null>(null);
  viewRef.current = view;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      scanIdRef.current = null;
    };
  }, []);

  // —— 缓存失效：`file:changed` 落在缓存根目录下就作废那一条 ——
  useEffect(
    () =>
      host.on<{ path: string }>(Events.fileChanged, (payload) => {
        for (const [root, entry] of [...treeCache]) {
          if (!underRoot(payload.path, root)) continue;
          treeCache.delete(root);
          const shown = viewRef.current;
          if (shown?.root === root && shown.fromCacheAt !== null) {
            setNotice(`目录内容已变化，${clock(entry.at)} 的缓存结果作废，请重新扫描。`);
          }
        }
      }),
    [host],
  );

  // —— 进度与终态：只认在途 scanId ——
  useEffect(() => {
    const offProgress = host.on<ScanProgressPayload>(Events.scanProgress, (payload) => {
      if (!aliveRef.current || payload.scanId !== scanIdRef.current) return;
      setPhase((prev) => (prev === "cancelling" ? prev : "scanning"));
      setProgress(payload);
    });
    const offDone = host.on<ScanDonePayload>(Events.scanDone, (payload) => {
      if (!aliveRef.current || payload.scanId !== scanIdRef.current) return;
      scanIdRef.current = null;
      setProgress(null);
      if (payload.cancelled) {
        // 半截聚合不当作结果：不画矩形图、不写缓存，只说明已取消。
        setPhase("cancelled");
        setView(null);
        return;
      }
      const at = Date.now();
      treeCache.set(cacheKey(payload.tree.path), {
        at,
        tree: payload.tree,
        skipped: payload.skipped,
        truncatedAtDepth: payload.truncatedAtDepth ?? null,
        elapsedMs: payload.elapsedMs,
        entries: payload.entries,
        bytes: payload.tree.bytes,
      });
      setView({
        root: payload.tree.path,
        tree: payload.tree,
        skipped: payload.skipped,
        truncatedAtDepth: payload.truncatedAtDepth ?? null,
        elapsedMs: payload.elapsedMs,
        entries: payload.entries,
        bytes: payload.tree.bytes,
        fromCacheAt: null,
      });
      setTrail([]);
      setMergedOpen(false);
      setPhase("result");
      setError(null);
      setNotice(null);
    });
    return () => {
      offProgress();
      offDone();
    };
  }, [host]);

  const loadVolume = useCallback((path: string): void => {
    hostRef.current
      .invoke<DiskListOut>(Capabilities.sysDiskList, { path })
      .then((out) => {
        if (aliveRef.current) setVolume(out.volumes[0] ?? null);
      })
      .catch(() => {
        if (aliveRef.current) setVolume(null);
      });
  }, []);

  const startScan = useCallback(
    (rawRoot: string, force: boolean): void => {
      const root = rawRoot.trim();
      setError(null);
      setNotice(null);
      setMergedOpen(false);
      if (!root) {
        setError("请先输入或选择一个根目录。");
        setPhase("failed");
        return;
      }
      const cached = force ? undefined : treeCache.get(cacheKey(root));
      if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
        setView({
          root,
          tree: cached.tree,
          skipped: cached.skipped,
          truncatedAtDepth: cached.truncatedAtDepth,
          elapsedMs: cached.elapsedMs,
          entries: cached.entries,
          bytes: cached.bytes,
          fromCacheAt: cached.at,
        });
        setTrail([]);
        setPhase("result");
        loadVolume(root);
        return;
      }
      setView(null);
      setProgress(null);
      setPhase("scanning");
      abandonRef.current = false;
      loadVolume(root);
      hostRef.current
        .invoke<ScanAck>(Capabilities.sysScanStart, { rootPath: root })
        .then((ack) => {
          if (!aliveRef.current || !openRef.current || abandonRef.current) {
            // 排队到确认这段时间界面可能已经关了：ack 一回来就取消，不留后台任务。
            void hostRef.current.invoke(Capabilities.sysScanCancel, { scanId: ack.scanId });
            return;
          }
          scanIdRef.current = ack.scanId;
          setRootDraft(ack.rootPath);
        })
        .catch((err) => {
          scanIdRef.current = null;
          setPhase("failed");
          setError(userError(err));
          setProgress(null);
        });
    },
    [loadVolume],
  );

  const cancelScan = useCallback((): void => {
    const id = scanIdRef.current;
    if (!id) return;
    setPhase("cancelling");
    void hostRef.current
      .invoke<boolean>(Capabilities.sysScanCancel, { scanId: id })
      .then((accepted) => {
        if (!aliveRef.current || accepted) return;
        // 扫描已经结束：取消没生效，终态事件会照常把结果送来。
        setNotice("扫描已经结束，取消没有生效。");
      })
      .catch(() => {
        if (aliveRef.current) setNotice("取消请求未能送达，扫描仍在进行。");
      });
  }, []);

  const changeOpen = useCallback(
    (next: boolean): void => {
      if (next) {
        setOpen(true);
        return;
      }
      if (phase === "scanning" || phase === "cancelling") {
        // 关闭就是放弃这次扫描：任务必须真取消，界面也不留半截结果。ack 还没回来时
        // 手上没有 scanId，所以留个作废标记，等确认一到就取消。
        abandonRef.current = true;
        cancelScan();
        scanIdRef.current = null;
        setPhase("idle");
        setView(null);
        setTrail([]);
        setProgress(null);
        setNotice(null);
      }
      // 已经拿到的结果在下次打开时还在，不必重扫；正在跑的被上面清掉了。
      setOpen(false);
    },
    [phase, cancelScan],
  );

  const pickRoot = useCallback((): void => {
    hostRef.current
      .invoke<PickOut>(Capabilities.shellPickDirectory, { multiple: false })
      .then((out) => {
        if (!aliveRef.current || out.cancelled || out.paths.length === 0) return;
        setRootDraft(out.paths[0]);
        setError(null);
      })
      .catch((err) => setError(userError(err)));
  }, []);

  const node = useMemo(() => resolveNode(view?.tree ?? null, trail), [view, trail]);
  const tiles = useMemo(() => splitTiles(node), [node]);
  const scanning = phase === "scanning" || phase === "cancelling";
  const busy = scanning;

  return (
    <Popover
      opened={open}
      onChange={changeOpen}
      position="bottom-start"
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
          className="fm-storage-entry"
          aria-label="空间分析"
          aria-pressed={open}
          title="空间分析"
          data-testid="storage-open"
          onClick={() => changeOpen(!open)}
        >
          空间分析
        </Button>
      </Popover.Target>

      <Popover.Dropdown>
        <div className="fm-storage-panel" data-testid="storage-panel" style={panelStyle}>
          <Group gap={8} wrap="nowrap" style={headerStyle}>
            <Title order={6} tt="none">
              空间分析
            </Title>
            <Text size="xs" c="dimmed" tt="none" truncate style={{ minWidth: 0 }}>
              块面积等于体积
            </Text>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              title="关闭空间分析"
              aria-label="关闭空间分析"
              data-testid="storage-close"
              style={{ marginLeft: "auto" }}
              onClick={() => changeOpen(false)}
            >
              ✕
            </ActionIcon>
          </Group>

          <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
            <TextInput
              aria-label="根目录路径"
              placeholder="/stress/数据集-1万"
              data-testid="storage-root"
              value={rootDraft}
              onChange={(e) => setRootDraft(e.target.value)}
              styles={{ input: rootInputStyle }}
              style={{ flex: 1, minWidth: 0 }}
              size="xs"
              disabled={busy}
            />
            <Button
              size="xs"
              variant="default"
              title="选择根目录"
              aria-label="选择根目录"
              data-testid="storage-pick"
              disabled={busy}
              onClick={pickRoot}
            >
              选择…
            </Button>
            {scanning ? (
              <Button
                size="xs"
                variant="filled"
                color="red"
                title="取消扫描"
                aria-label="取消扫描"
                data-testid="storage-cancel"
                onClick={cancelScan}
              >
                {phase === "cancelling" ? "正在取消…" : "取消"}
              </Button>
            ) : (
              <Button
                size="xs"
                variant="filled"
                title="扫描所选根目录"
                aria-label="扫描所选根目录"
                data-testid="storage-scan"
                disabled={!rootDraft.trim()}
                onClick={() => startScan(rootDraft, false)}
              >
                扫描
              </Button>
            )}
            {view && !scanning ? (
              <Button
                size="xs"
                variant="outline"
                title="忽略缓存重新扫描"
                aria-label="忽略缓存重新扫描"
                data-testid="storage-rescan"
                disabled={!rootDraft.trim()}
                onClick={() => startScan(rootDraft, true)}
              >
                重新扫描
              </Button>
            ) : null}
          </Group>

          {/* 状态行 / 卷信息行 / 说明行都预留固定高度：换状态只换文字，不挪动矩形图。 */}
          <div style={lineStyle(LINE_HEIGHT)} data-testid="storage-status">
            {scanning ? (
              <Text size="xs" truncate>
                {phase === "cancelling" ? "正在取消…" : "扫描中…"} 已统计 {count(progress?.entries ?? 0)} 项 ·{" "}
                {formatSize(progress?.bytes ?? 0)}
                {progress?.path ? <span title={progress.path}>（正在读取 {baseName(progress.path)}）</span> : null}
              </Text>
            ) : phase === "idle" ? (
              <Text size="xs" c="dimmed" truncate>
                选择一个根目录后开始扫描，期间可以随时取消。
              </Text>
            ) : phase === "failed" ? (
              <Text size="xs" c="red" truncate data-testid="storage-error">
                {error ?? "扫描未能开始。"}
              </Text>
            ) : phase === "cancelled" ? (
              <Text size="xs" c="orange" truncate data-testid="storage-cancelled">
                扫描已取消，统计不完整，因此没有结果可展示。
              </Text>
            ) : (
              <Text size="xs" truncate>
                {view?.fromCacheAt
                  ? `结果来自 ${clock(view.fromCacheAt)} 的缓存 · ${formatSize(view.bytes)} · ${count(view.entries)} 项`
                  : `扫描完成 · ${formatSize(view?.bytes ?? 0)} · ${count(view?.entries ?? 0)} 项 · 用时 ${((view?.elapsedMs ?? 0) / 1000).toFixed(1)} 秒`}
              </Text>
            )}
          </div>

          <div style={lineStyle(LINE_HEIGHT)}>
            {volume ? (
              <Text size="xs" c="dimmed" truncate data-testid="storage-volume">
                所在卷 {volume.rootPath}（{volume.filesystem}）· 可用 {formatSize(volume.freeBytes)} / 共{" "}
                {formatSize(volume.totalBytes)}
              </Text>
            ) : null}
          </div>

          <div style={lineStyle(LINE_HEIGHT)}>
            {notice ? (
              <Text size="xs" c="orange" truncate data-testid="storage-notice">
                {notice}
              </Text>
            ) : null}
          </div>

          <div style={{ ...breadcrumbRowStyle, height: BREADCRUMB_HEIGHT }} data-testid="storage-breadcrumb">
            <ActionIcon
              size="xs"
              variant="subtle"
              title="返回上级"
              aria-label="返回上级"
              data-testid="storage-back"
              disabled={!view || trail.length === 0}
              onClick={() => {
                setTrail((t) => t.slice(0, -1));
                setMergedOpen(false);
              }}
            >
              ↩
            </ActionIcon>
            {view ? (
              <Group gap={2} wrap="nowrap" style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
                <Crumb label={baseName(view.root)} active={trail.length === 0} onClick={() => setTrail([])} />
                {trail.map((p, i) => (
                  <Crumb
                    key={p}
                    label={baseName(p)}
                    active={i === trail.length - 1}
                    onClick={() => {
                      setTrail((t) => t.slice(0, i + 1));
                      setMergedOpen(false);
                    }}
                  />
                ))}
              </Group>
            ) : (
              <Text size="xs" c="dimmed">
                未开始扫描
              </Text>
            )}
          </div>

          <div style={chartBlockStyle}>
            {view && node ? (
              <Treemap
                tiles={tiles.main}
                mergedBytes={tiles.mergedBytes}
                mergedCount={tiles.merged.length}
                total={node.bytes}
                onPick={(path) => {
                  if (path === MERGED_PICK) {
                    setMergedOpen((v) => !v);
                    return;
                  }
                  const target = (node.children ?? []).find((c) => c.path === path);
                  if (!target?.isDir) return;
                  if (!target.children || target.children.length === 0) {
                    setNotice(`${target.name} 的更深层明细没随本次扫描返回，只统计了聚合大小。`);
                    return;
                  }
                  setNotice(null);
                  setMergedOpen(false);
                  setTrail((t) => [...t, target.path]);
                }}
              />
            ) : (
              <EmptyChart phase={phase} error={error} />
            )}
          </div>

          <div style={summaryStyle}>
            <ScrollArea style={{ height: "100%" }} type="auto">
              {view && node ? (
                <Stack gap={4}>
                  <Group gap={8} wrap="wrap">
                    <Text size="xs" fw={600}>
                      当前目录 {node.name} · {formatSize(node.bytes)}
                    </Text>
                    <Badge
                      size="xs"
                      variant="light"
                      color={view.skipped.length > 0 ? "orange" : "gray"}
                      data-testid="storage-skipped-count"
                    >
                      跳过 {count(view.skipped.length)} 项
                    </Badge>
                    <Text size="xs" c="dimmed">
                      跳过的目录没有体积，不计入总量
                    </Text>
                    {view.truncatedAtDepth !== null ? (
                      <Text size="xs" c="dimmed">
                        只展开到第 {view.truncatedAtDepth} 层
                      </Text>
                    ) : null}
                    <Text size="xs" c="dimmed">
                      {topKinds(node.kinds)}
                    </Text>
                  </Group>
                  <SkippedList skipped={view.skipped} />
                  <DetailList
                    node={node}
                    merged={tiles.merged}
                    mergedOpen={mergedOpen}
                    onToggleMerged={() => setMergedOpen((v) => !v)}
                    onPick={(path) => {
                      setMergedOpen(false);
                      setTrail((t) => [...t, path]);
                    }}
                  />
                </Stack>
              ) : (
                <Text size="xs" c="dimmed">
                  {phase === "cancelled"
                    ? "已取消的扫描不会留下可用结果；重新扫描才能得到完整占用。"
                    : "扫描完成后这里显示每一项的大小与被跳过的目录。"}
                </Text>
              )}
            </ScrollArea>
          </div>
        </div>
      </Popover.Dropdown>
    </Popover>
  );
}

// ───────────────────────────── 矩形图 ─────────────────────────────

const MERGED_PICK = "__merged__";

/** 从聚合树里按面包屑取当前节点；路径消失时停在能找到的最深处，不画不存在的图。 */
function resolveNode(tree: ScanNode | null, trail: string[]): ScanNode | null {
  if (!tree) return null;
  let cur = tree;
  for (const path of trail) {
    const next = (cur.children ?? []).find((c) => c.path === path);
    if (!next) return cur;
    cur = next;
  }
  return cur;
}

/** 当前层的块：体积最大的前 `MAX_TILES` 名画出来，其余合并成「其他」（明细仍可查）。 */
function splitTiles(node: ScanNode | null): { main: ScanNode[]; merged: ScanNode[]; mergedBytes: number } {
  if (!node) return { main: [], merged: [], mergedBytes: 0 };
  const sorted = [...(node.children ?? [])].sort((a, b) => b.bytes - a.bytes);
  if (sorted.length <= MAX_TILES) return { main: sorted, merged: [], mergedBytes: 0 };
  const merged = sorted.slice(MAX_TILES);
  return { main: sorted.slice(0, MAX_TILES), merged, mergedBytes: merged.reduce((sum, m) => sum + m.bytes, 0) };
}

/** 类型占比：`kinds` 是聚合出来的扩展名总量，取前两类写进概览行。 */
function topKinds(kinds: Record<string, number> | null | undefined): string {
  const entries = Object.entries(kinds ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 2);
  if (entries.length === 0) return "没有可统计的文件类型";
  return `主要类型 ${entries.map(([ext, bytes]) => `${ext} ${formatSize(bytes)}`).join("、")}`;
}

function Treemap({
  tiles,
  mergedBytes,
  mergedCount,
  total,
  onPick,
}: {
  tiles: ScanNode[];
  mergedBytes: number;
  mergedCount: number;
  total: number;
  onPick: (path: string) => void;
}) {
  const box = useRef<HTMLDivElement | null>(null);
  /** 回调经 ref 交给 echarts 的 click 处理器：重设 option 时不必重建实例。 */
  const pickRef = useRef(onPick);
  pickRef.current = onPick;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const instance = echarts.init(el, null, { renderer: "canvas" });
    instance.on("click", (params) => {
      const item = params.data as { fmPath?: string } | undefined;
      if (item?.fmPath) pickRef.current(item.fmPath);
    });
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      instance.dispose();
    };
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const instance = echarts.getInstanceByDom(el);
    if (!instance) return;
    instance.setOption(optionFor(tiles, mergedBytes, mergedCount, total), true);
  }, [tiles, mergedBytes, mergedCount, total]);

  return <div ref={box} style={chartStyle} data-testid="storage-treemap" title="矩形图：块面积等于体积" />;
}

/** 颜色取自 Mantine token；token 取不到时退回十六进制，画布不认 `var(...)`。 */
function palette(): string[] {
  const tokens = [
    ["--mantine-color-blue-5", "#4dabf7"],
    ["--mantine-color-teal-5", "#22b8cf"],
    ["--mantine-color-grape-5", "#9775fa"],
    ["--mantine-color-cyan-5", "#3bc9db"],
    ["--mantine-color-indigo-5", "#748ffc"],
    ["--mantine-color-violet-5", "#845ef7"],
  ] as const;
  const style = getComputedStyle(document.documentElement);
  return tokens.map(([token, fallback]) => style.getPropertyValue(token).trim() || fallback);
}

function optionFor(tiles: ScanNode[], mergedBytes: number, mergedCount: number, total: number): echarts.EChartsCoreOption {
  const data: Record<string, unknown>[] = tiles.map((t) => ({
    name: t.name,
    value: t.bytes,
    fmPath: t.path,
  }));
  if (mergedCount > 0) {
    data.push({ name: `其他（${count(mergedCount)} 项）`, value: mergedBytes, fmPath: MERGED_PICK });
  }
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  return {
    // 下钻是本插件的面包屑状态，所以关掉 echarts 自带的点击缩放与面包屑。
    animation: !reduced,
    animationDuration: 0,
    animationDurationUpdate: reduced ? 0 : 200,
    tooltip: {
      formatter: (p: unknown) => {
        const item = p as { name?: string; value?: number };
        const value = Number(item.value ?? 0);
        const share = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
        return `${item.name ?? ""}<br />大小 ${formatSize(value)}<br />占本层 ${share}%`;
      },
    },
    color: palette(),
    series: [
      {
        type: "treemap",
        nodeClick: false,
        breadcrumb: { show: false },
        roam: false,
        // 不写 left/top 时 echarts 默认 'center'，和 100% 宽高一起会把整棵矩形图整体
        // 右移并裁掉最后一块——块面积因此不等于体积（画布取证：裁掉的正是最小块）。
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        data,
        label: {
          show: true,
          // 色彩之外仍写着名称与大小（功能书：颜色不是唯一通道）。
          formatter: (p: unknown) => {
            const item = p as { name?: string; value?: number };
            return `${item.name ?? ""}\n${formatSize(Number(item.value ?? 0))}`;
          },
          fontSize: 11,
          overflow: "truncate",
        },
        itemStyle: { borderWidth: 1, gapWidth: 1 },
      },
    ],
  };
}

function EmptyChart({ phase, error }: { phase: Phase; error: string | null }) {
  return (
    <div style={chartStyle} data-testid="storage-empty-chart">
      <Stack gap={4} justify="center" align="center" style={{ height: "100%" }}>
        <Text size="sm" c="dimmed" style={{ textAlign: "center" }}>
          {phase === "failed"
            ? (error ?? "扫描未能开始。")
            : phase === "cancelled"
              ? "扫描已取消，这里没有可展示的结果。"
              : phase === "scanning" || phase === "cancelling"
                ? "正在统计体积，完成后这里按体积画出每个目录。"
                : "选好根目录后点「扫描」，这里会按体积画出每个目录占的面积。"}
        </Text>
      </Stack>
    </div>
  );
}

// ───────────────────────────── 明细、跳过项、面包屑 ─────────────────────────────

/** 跳过项与中文原因必须看得见：它们是"没被统计"的唯一说明，绝不当作已扫过。
 *  清单本身也可能上千条，所以只画前若干行，其余用一行中文交代数量。 */
const SKIPPED_ROWS = 20;

function SkippedList({ skipped }: { skipped: ScanSkipped[] }) {
  if (skipped.length === 0) {
    return (
      <Text size="xs" c="dimmed">
        没有跳过的目录。
      </Text>
    );
  }
  return (
    <Stack gap={2} data-testid="storage-skipped">
      {skipped.slice(0, SKIPPED_ROWS).map((s) => (
        <Group key={s.path} gap={8} wrap="nowrap">
          <Text size="xs" c="orange" style={{ whiteSpace: "nowrap" }}>
            {skipReasonText(s.reason)}
          </Text>
          <Text size="xs" c="dimmed" truncate style={{ minWidth: 0 }} title={s.path}>
            {s.path}
          </Text>
        </Group>
      ))}
      {skipped.length > SKIPPED_ROWS ? (
        <Text size="xs" c="dimmed" data-testid="storage-skipped-more">
          另有 {count(skipped.length - SKIPPED_ROWS)} 项同样未计入总量
        </Text>
      ) : null}
    </Stack>
  );
}

function Crumb({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <>
      <UnstyledButton
        onClick={onClick}
        disabled={active}
        style={crumbStyle(active)}
        data-testid={active ? "storage-crumb-active" : "storage-crumb"}
      >
        <Text size="xs" truncate style={{ maxWidth: 160 }}>
          {label}
        </Text>
      </UnstyledButton>
      {!active ? <Text size="xs">/</Text> : null}
    </>
  );
}

/** 当前层明细：合并块必须能就地展开，否则「其他」就是一口闷的黑箱。
 *  展开后的明细本身也可能上千条，所以只画前若干行，其余用一行中文交代数量。 */
const DETAIL_ROWS = 100;

function DetailList({
  node,
  merged,
  mergedOpen,
  onToggleMerged,
  onPick,
}: {
  node: ScanNode;
  merged: ScanNode[];
  mergedOpen: boolean;
  onToggleMerged: () => void;
  onPick: (path: string) => void;
}) {
  const kids = [...(node.children ?? [])].sort((a, b) => b.bytes - a.bytes);
  // 有合并块时明细只需要列前 12 项（其余走「其他」入口）；没有合并块就必须把这一层
  // 列全，否则界面少画几行又什么都不说，等于把数据藏起来。
  const rows = mergedOpen ? merged.slice(0, DETAIL_ROWS) : merged.length > 0 ? kids.slice(0, 12) : kids.slice(0, DETAIL_ROWS);
  // 列不完就要说：「其他」展开后只剩 100 行时，剩下那几百项在界面上是看不见的，
  // 不写出来就等于悄悄藏了数据。
  const unlisted =
    rows.length === 0
      ? 0
      : mergedOpen
        ? Math.max(0, merged.length - rows.length)
        : merged.length > 0
          ? 0
          : Math.max(0, kids.length - rows.length);
  const total = node.bytes;
  const share = (n: number): string => (total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "—");
  return (
    <Stack gap={2}>
      {merged.length > 0 ? (
        <UnstyledButton onClick={onToggleMerged} style={linkStyle} data-testid="storage-merged-toggle">
          <Text size="xs">
            {mergedOpen ? `收起其余 ${count(merged.length)} 项` : `查看其余 ${count(merged.length)} 项`}
          </Text>
        </UnstyledButton>
      ) : null}
      {rows.length === 0 ? (
        <Text size="xs" c="dimmed">
          {node.isDir ? "这是个空目录，没有子项。" : ""}
        </Text>
      ) : (
        rows.map((r) => (
          <Group key={r.path} gap={8} wrap="nowrap">
            <UnstyledButton
              onClick={() => (r.isDir && (r.children ?? []).length > 0 ? onPick(r.path) : undefined)}
              style={rowNameStyle(r.isDir)}
              data-testid={`storage-row`}
            >
              <Text size="xs" truncate style={{ maxWidth: 240 }}>
                {r.name}
              </Text>
            </UnstyledButton>
            <Text size="xs" c="dimmed" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>
              {formatSize(r.bytes)} · {share(r.bytes)}
            </Text>
          </Group>
        ))
      )}
      {unlisted > 0 ? (
        <Text size="xs" c="dimmed" data-testid="storage-detail-more">
          其余 {count(unlisted)} 项因界面只列前 {DETAIL_ROWS} 项未逐项列出
        </Text>
      ) : null}
      <Text size="xs" c="dimmed">
        本层 {count(kids.length)} 项
      </Text>
    </Stack>
  );
}

// ───────────────────────────── 样式 ─────────────────────────────

/** 面板固定尺寸：变状态只换内容，绝不让浮层自适应内容后重算定位。 */
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

const rootInputStyle: CSSProperties = { fontSize: 12, height: 30 };

const chartBlockStyle: CSSProperties = { flexShrink: 0 };

const chartStyle: CSSProperties = { width: "100%", height: CHART_HEIGHT };

const breadcrumbRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
  overflow: "hidden",
};

const summaryStyle: CSSProperties = {
  flex: 1,
  // 概览区是面板里唯一随内容变化的块，给它一个下限：状态行、面包屑、矩形图的位置
  // 因此完全不随条目多少移动（面板整体尺寸由 dropdown 钉死）。
  minHeight: 200,
  borderTop: "1px solid var(--mantine-color-default-border)",
  paddingTop: 6,
};

const crumbStyle = (active: boolean): CSSProperties => ({
  fontSize: 12,
  color: active ? "var(--mantine-color-text)" : "var(--mantine-primary-color-filled)",
  cursor: active ? "default" : "pointer",
  padding: "1px 4px",
});

const rowNameStyle = (isDir: boolean): CSSProperties => ({
  cursor: isDir ? "pointer" : "default",
  color: isDir ? "var(--mantine-primary-color-filled)" : "var(--mantine-color-text)",
  minWidth: 0,
});

const linkStyle: CSSProperties = {
  color: "var(--mantine-primary-color-filled)",
  cursor: "pointer",
};
