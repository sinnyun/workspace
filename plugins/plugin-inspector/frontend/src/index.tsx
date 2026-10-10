/**
 * `plugin-inspector` — region D's detail container (roadmap P6-47 → P7-6,
 * docs/01 §9.3, docs/02 §4.5, docs/09 §3.1/§3.2/§4).
 *
 * Owns the **focus header, the tab strip and the focus-kind template**. It provides
 * the nested slots `detail-tab:<name>` (one tab each), plus, inside the built-in
 * 信息 tab, `preview-zone` / `detail-info-zone` / `file-extension-zone`. Content
 * plugins decide what any of that means; this file never reads a file, a hash or a tag.
 *
 * Which extra tabs exist comes from the slot runtime: every `detail-tab:<name>` that
 * currently holds a contribution becomes a tab, titled by that plugin's own manifest
 * `label` (`host.slotLabel`) and falling back to the slot name (docs/02 §4.5).
 *
 * Four invariants this container guarantees with STRUCTURE (geometry + one event
 * path), not by asking every content plugin to behave (docs/09 §3.1 滚动责任, §4
 * `activeDetailTab`):
 *  1. a tab whose contribution disappeared (its plugin was switched off in settings)
 *     can never stay active — `liveTabIds()` is the single definition of "valid tab"
 *     for both the render and the write-back effect, so the active tab falls back to
 *     the built-in 信息 tab (always present, first entry) through `detail:tab:changed`;
 *  2. every tab subtree stays MOUNTED, inactive ones only hidden, so a content plugin
 *     keeps its local state across switches (same rule as `plugin-layout-panes`);
 *  3. the root is a three-row grid whose last row is `minmax(0, 1fr)`: the header and
 *     the tab strip sit in `auto` rows above a bounded scroll viewport, so long
 *     content scrolls INSIDE region D and never drags the header/tab strip away;
 *  4. a long focus path is middle-abbreviated while the name and the kind badge stay
 *     on the first row — the full path lives in `title`, the only place slot ids and
 *     full addresses are allowed to appear (全中文 UI 约束).
 *
 * Failure isolation needs no extra layer here: `PluginSlot` already wraps EVERY
 * contribution in its own error boundary, so a detail plugin that throws degrades
 * only its own slot — sibling tabs and this container keep rendering.
 *
 * Local state = which tab is open, mirrored into the base's `activeDetailTab`
 * through `detail:tab:changed`, so a session switch restores it with the rest of
 * the cascade.
 */

import { Badge, Group, Tabs, Text } from "@mantine/core";
import {
  disposer,
  Events,
  type HostMetaState,
  type PluginHost,
  type Ref,
  type SlotProps,
  slotPrefix,
} from "@my-file-manager/plugin-sdk";
import { FileText, FolderClosed } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";

const INFO_TAB = "info";
const TAB_PREFIX = "detail-tab";
/** This container's own tab titles; content plugins title their own tabs through
 *  their manifest (`frontend.slots[].label` → `host.slotLabel`). */
const OWN_LABELS: Record<string, string> = { [INFO_TAB]: "信息" };
/** Which zones the built-in 信息 tab shows, per opaque focus `kind` (docs/01 §9.3).
 *  Unknown kinds get the plain info zone — the container still carries, never judges. */
const TEMPLATE: Record<string, string[]> = {
  file: ["preview-zone", "detail-info-zone", "file-extension-zone"],
  folder: ["detail-info-zone", "file-extension-zone"],
};
const FALLBACK_ZONES = ["detail-info-zone"];
/** Chinese names for the zones this container owns — a slot id never reads out loud. */
const ZONE_LABELS: Record<string, string> = {
  "file-extension-zone": "文件扩展",
  "preview-zone": "预览",
  "detail-info-zone": "属性信息",
};
/** `Ref.kind` is plugin-side vocabulary; only the words live here. */
const KIND_LABELS: Record<string, string> = { file: "文件", folder: "目录" };
/** 面板进入反馈的时长：docs/09 §3.2 普通控件 120–180ms。 */
const PANE_MOTION_MS = 150;

const tabIdOf = (slotId: string): string => slotId.slice(`${TAB_PREFIX}:`.length);
const baseName = (path: string): string => {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
};

/** The tab strip as it exists RIGHT NOW: the built-in 信息 tab plus one tab per live
 *  `detail-tab:<name>` contribution — first-registration order, so 信息 is always
 *  index 0 and is the fallback target. Both the render and the write-back effect read
 *  this, which is what keeps "valid tab" from drifting into two definitions. */
const liveTabIds = (host: PluginHost): string[] => [INFO_TAB, ...host.contributedSlots(TAB_PREFIX).map(tabIdOf)];

const ELLIPSIS = "…";
/** 中间省略：保留路径头部与末段名称，长路径读起来仍然认得出在哪。完整路径不进正文，
 *  只进 `title` 悬停（docs/09 §3.1 输入规则 + 全中文 UI 约束）。 */
function abbreviatePath(path: string, budget = 46): string {
  if (path.length <= budget) return path;
  const base = baseName(path);
  const dir = path.slice(0, path.length - base.length);
  const tailBudget = Math.max(8, Math.min(base.length, Math.floor(budget / 2)));
  const headBudget = Math.max(6, budget - tailBudget - ELLIPSIS.length);
  const head = dir.length <= headBudget ? dir : `${dir.slice(0, headBudget)}${ELLIPSIS}`;
  const tail = base.length <= tailBudget ? base : `${ELLIPSIS}${base.slice(base.length - tailBudget)}`;
  return head + tail;
}

/** tab 切换的轻量反馈：新面板先绘制一次“起始态”（略透明 + 微位移），下一拍回到常态，
 *  由 CSS 过渡补完约 150ms。用户在系统里开启“减少动态效果”时，外壳全局样式把
 *  `transition-duration` 压成近零，因此这里不需要重复判断偏好，反馈自动降级为即时切换。 */
function usePaneEnterMotion(active: string): boolean {
  const [settled, setSettled] = useState(true);
  const prevActive = useRef(active);
  useEffect(() => {
    if (prevActive.current === active) return;
    prevActive.current = active;
    setSettled(false);
    const timer = window.setTimeout(() => setSettled(true), 24);
    return () => window.clearTimeout(timer);
  }, [active]);
  return settled;
}

export function InspectorContainer({ host }: SlotProps) {
  const [meta, setMeta] = useState<HostMetaState>(() => host.getState());
  const [, bump] = useState(0);

  /** 贡献消失的安全回退（docs/09 §4 `activeDetailTab` 行）：活动 tab 指向的
   *  `detail-tab:<name>` 不再持有贡献（对应插件在设置里被关闭、槽被释放）时，把活动
   *  tab 写回永远有效的首个 tab「信息」。由槽注册表变更驱动（`host.onSlotsChange`），
   *  无轮询；写回只走 `detail:tab:changed` 这条既有事件，基座快照随之修正，切会话不会
   *  再把幽灵 tab 带回来。相同输入不重复发事件，因此不会和状态订阅互相回声。 */
  useEffect(() => {
    const enforceActiveTab = (): void => {
      const { activeDetailTab } = host.getState();
      // 「信息」是 liveTabIds 的第 0 项、恒在，所以这一个判断就覆盖了“默认页或首个有效 tab”。
      if (liveTabIds(host).includes(activeDetailTab)) return;
      host.emit(Events.detailTabChanged, { tabId: INFO_TAB });
    };
    // 挂载即校验：基座默认值是空串（从未写过 tab），首次渲染就归位到「信息」。
    enforceActiveTab();
    return disposer(
      host.onStateChange((s) => {
        setMeta(s);
        enforceActiveTab();
      }),
      host.onSlotsChange(() => {
        bump((n) => n + 1);
        enforceActiveTab();
      }),
    );
  }, [host]);

  const tabs = liveTabIds(host);
  const extraTabs = tabs.slice(1);
  // 渲染期兜底：事件落地前那一帧也不会停在失效 tab 上（空白/错误高亮都不允许出现）。
  const active = tabs.includes(meta.activeDetailTab) ? meta.activeDetailTab : INFO_TAB;
  const settled = usePaneEnterMotion(active);
  const focusKind = meta.focusRef?.kind;
  const zones = TEMPLATE[focusKind ?? ""] ?? FALLBACK_ZONES;

  const selectTab = (tabId: string): void => host.emit(Events.detailTabChanged, { tabId });

  return (
    <div className="fm-inspector" style={rootStyle}>
      <FocusHeader focus={meta.focusRef} />

      <Tabs
        value={active}
        onChange={(v) => {
          if (v) selectTab(String(v));
        }}
        variant="default"
        styles={{ tab: tabStyle, list: tabListStyle }}
        style={tabStripStyle}
        aria-label="详情标签页"
      >
        <Tabs.List>
          {tabs.map((t) => (
            <Tabs.Tab key={t} value={t}>
              {host.slotLabel(`${TAB_PREFIX}:${t}`) ?? OWN_LABELS[t] ?? t}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>

      {/* 唯一的滚动视口：三个行里的第三行，高度被 grid 的 minmax(0, 1fr) 限死。 */}
      <div style={paneAreaStyle}>
        <div style={paneStyle(active === INFO_TAB, settled)}>
          {zones.map((zone) => (
            <Zone key={zone} host={host} slotId={zone} />
          ))}
        </div>

        {extraTabs.map((t) => (
          <div key={t} style={paneStyle(active === t, settled)}>
            <TabPane host={host} tab={t} />
          </div>
        ))}
      </div>
    </div>
  );
}

/** What the cascade is currently focused on — the panel's own title line. */
function FocusHeader({ focus }: { focus: Ref | null }) {
  if (!focus) {
    return (
      <div className="fm-empty" style={{ padding: "24px 10px" }}>
        <span className="fm-empty-icon">
          <FileText size={26} />
        </span>
        <Text size="sm" fw={600}>
          文件信息
        </Text>
        <Text size="xs" c="dimmed">
          选中项目，查看预览、属性与历史
        </Text>
      </div>
    );
  }
  const isDir = focus.kind === "folder";
  return (
    <Group className="fm-inspector-header" gap={10} wrap="nowrap" align="center" style={headerStyle}>
      <span className="fm-inspector-icon">
        {isDir ? (
          <FolderClosed size={23} color="var(--mantine-color-yellow-6)" />
        ) : (
          <FileText size={23} color="var(--mantine-color-gray-6)" />
        )}
      </span>
      <div style={{ minWidth: 0, flex: 1 }}>
        {/* 第一行：名称 + 类型徽标。两者都不参与收缩竞争——名称 truncate 让位，
            徽标 flex 0 0 auto，所以栏再窄也不会丢掉“是什么类型的东西”这一眼信息。 */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Text size="sm" fw={600} truncate title={focus.id} style={{ minWidth: 0, flex: "1 1 auto" }}>
            {baseName(focus.id)}
          </Text>
          <Badge size="xs" variant="light" color={isDir ? "yellow" : "blue"} style={{ flex: "0 0 auto" }}>
            {KIND_LABELS[focus.kind] ?? focus.kind}
          </Badge>
        </div>
        {/* 第二行：路径中间省略，完整路径悬停可查。 */}
        <Text size="xs" c="dimmed" truncate mt={2} title={focus.id}>
          {abbreviatePath(focus.id)}
        </Text>
      </div>
    </Group>
  );
}

/** One `detail-tab:<name>` outlet. */
function TabPane({ host, tab }: { host: PluginHost; tab: string }) {
  const slotId = `${TAB_PREFIX}:${tab}`;
  const Outlet = host.provideSlot(slotId);
  return <Outlet id={slotId} />;
}

/** A fixed zone inside the 信息 tab. */
function Zone({ host, slotId }: { host: PluginHost; slotId: string }) {
  const Outlet = host.provideSlot(slotId);
  const content = host.contributedSlots(slotPrefix(slotId)).length > 0;
  return (
    <div style={{ marginBottom: 8 }}>
      {content ? (
        <Outlet id={slotId} />
      ) : (
        <div
          className={slotId === "file-extension-zone" ? "fm-extension-placeholder" : undefined}
          style={emptyZoneStyle}
        >
          <Text size="xs" fw={600}>
            {ZONE_LABELS[slotId] ?? slotId}
          </Text>
          <Text size="xs" c="dimmed">
            {slotId === "file-extension-zone" ? "启用文件扩展插件后，相关功能会显示在这里。" : "暂无内容"}
          </Text>
        </div>
      )}
    </div>
  );
}

/** 容器几何：三行 grid，前两行 `auto`（标题条、tab 条），第三行 `minmax(0, 1fr)`。
 *  `minHeight: 0` 让 grid 在 D 栏被压扁时不会撑破 aside（外壳那层是 overflow:hidden），
 *  于是超长内容只能落在第三行的滚动视口里，上面两行始终留在原位。
 *  `overflow: hidden` 再兜一层：任何子贡献想要溢出区域滚动都溢出不了。 */
const rootStyle: CSSProperties = {
  display: "grid",
  gridTemplateRows: "auto auto minmax(0, 1fr)",
  height: "100%",
  minHeight: 0,
  minWidth: 0,
  overflow: "hidden",
};

const tabStyle: CSSProperties = { fontSize: 12, padding: "10px 12px" };

/** 窄栏时 tab 换行而不是被裁掉：tab 条仍是独立的一行，不会跟内容一起滚走。 */
const tabListStyle: CSSProperties = { flexWrap: "wrap", rowGap: 2, minWidth: 0 };

const tabStripStyle: CSSProperties = { minWidth: 0 };

const headerStyle: CSSProperties = {
  padding: "12px 2px",
  minHeight: 110,
  borderBottom: "1px solid var(--mantine-color-default-border)",
  minWidth: 0,
  alignItems: "center",
};

/** 内容视口：grid 的 1fr 行 + `minHeight: 0` + `overflow: auto` = 滚动只发生在这里。 */
const paneAreaStyle: CSSProperties = {
  minHeight: 0,
  minWidth: 0,
  overflow: "auto",
  overscrollBehavior: "contain",
  paddingTop: 12,
};

/** Hidden, not unmounted: the tab's plugin keeps its local state (docs/02 §4.5) —
 *  switching a tab only flips `display`, never remounts. */
const hiddenStyle: CSSProperties = { display: "none" };

/** 活动面板：常态。过渡属性挂在两个状态上，切换才有一段可插值的轻反馈。 */
const paneSettledStyle: CSSProperties = {
  transition: `opacity ${PANE_MOTION_MS}ms ease, transform ${PANE_MOTION_MS}ms ease`,
};

/** 活动面板的起始态：略透明 + 微下移，下一拍过渡回常态。 */
const paneEnteringStyle: CSSProperties = {
  ...paneSettledStyle,
  opacity: 0.55,
  transform: "translateY(2px)",
};

/** 面板三态：隐藏（保留挂载）/ 起始 / 常态。 */
const paneStyle = (visible: boolean, settled: boolean): CSSProperties =>
  !visible ? hiddenStyle : settled ? paneSettledStyle : paneEnteringStyle;

const emptyZoneStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--mantine-color-dimmed)",
  border: "1px dashed var(--mantine-color-default-border)",
  borderRadius: "var(--mantine-radius-sm)",
  padding: "4px 6px",
};
