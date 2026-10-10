/**
 * `plugin-layout-views` — region B's exclusive view container (roadmap P7-3,
 * docs/01 §9.1/§9.3, docs/02 §4.5, docs/09 §4 `activeSidebarView` + §5).
 *
 * B shows **one** sidebar view at a time, and that exclusion is this container's
 * job — not a `return null` each view panel has to remember to write (docs/02 §4.5:
 * 互斥由容器负责). It occupies `nav-zone`, discovers every `nav-panel:<viewId>`
 * that currently holds a contribution (`host.contributedSlots`) and shows exactly
 * the one matching the base's opaque `activeSidebarView`.
 *
 * Two failures look different on purpose (docs/09 §4, "选取可用视图或显示空侧栏"):
 *  - 没有任何候选面板 -> 中文空侧栏说明（`EmptySidebar`）：白屏、残留内容、伪造的
 *    默认目录都不允许（docs/plugin-functional/plugin-layout-views.md）。
 *  - 有候选面板，但活动视图的面板不见了（视图插件被停用）-> 回落第一个有效面板，
 *    并把它保持挂载，等该插件重新启用后自动回到它。
 *
 * Inactive panels stay mounted but hidden: unmounting would drop their local state
 * (tree expansion, scroll) every time the user taps another A icon, and rebuilding
 * it is the view plugin's business, not the container's. `Transition keepMounted`
 * gives that for free — it applies `display: none` instead of unmounting.
 *
 * Geometry + selection only: this file never lists a directory, a favorite or a tag,
 * and it never writes meta state (`sidebar:view:changed` belongs to the A rail).
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Stack, Text, Transition } from "@mantine/core";
import { type PluginHost, type SlotProps } from "@my-file-manager/plugin-sdk";

const PREFIX = "nav-panel";

/** 面板淡入时长：docs/09 §3 要求 120–180ms 的切换过渡。退场用 0ms——两个面板同时
 *  半透明就等于同一瞬间有两个可见面板，违反"只能有一个面板可见"。
 *  减少动态效果时基座全局 CSS（`prefers-reduced-motion` 下
 *  `transition-duration: .01ms !important`）会把这段内联过渡压成即时切换，因此这里
 *  只依赖 Mantine 的过渡组件与主题令牌，不自写动画。 */
const ENTER_MS = 150;

export function ViewsContainer({ host }: SlotProps) {
  const [activeView, setActiveView] = useState(host.getState().activeSidebarView);
  const [, bump] = useState(0);

  // 面板清单每次渲染都重新向基座询问（不缓存），启停/卸载只靠这两个订阅驱动：
  // 元状态决定"看哪个"，slot registry 决定"有哪些可看"（docs/09 §5，不轮询）。
  useEffect(() => host.onStateChange((s) => setActiveView(s.activeSidebarView)), [host]);
  useEffect(() => host.onSlotsChange(() => bump((n) => n + 1)), [host]);

  const panels = host.contributedSlots(PREFIX);

  // —— 路径一：一个候选面板都没有（视图插件全部停用/尚未加载）→ 中文空侧栏 ——
  if (panels.length === 0) return <EmptySidebar />;

  // —— 路径二：有候选面板。活动视图没有对应面板时回落第一个有效面板 ——
  const wanted = `${PREFIX}:${activeView}`;
  const active = panels.includes(wanted) ? wanted : panels[0];

  return (
    <div style={rootStyle}>
      {panels.map((slotId) => (
        <Transition
          key={slotId}
          mounted={slotId === active}
          transition="fade"
          duration={ENTER_MS}
          exitDuration={0}
          keepMounted
        >
          {(styles) => (
            // 槽 id 只作地址/调试信息，因此只进 title 悬停提示，不进可见文本
            //（docs/09 §3、§5.5）。
            <div title={slotId} style={{ ...panelStyle, ...styles }}>
              <Panel host={host} slotId={slotId} />
            </div>
          )}
        </Transition>
      ))}
    </div>
  );
}

/** 空侧栏：说明为什么是空的以及下一步做什么。这里不列任何目录，也不假装有一个默认
 *  视图——伪造内容会让用户以为数据真的存在。 */
function EmptySidebar() {
  return (
    <div style={rootStyle}>
      {/* 只用 Mantine 组件与主题变量：居中说明文案，不借用基座的全局样式类。 */}
      <Stack gap={4} p="md" align="center" justify="center" style={emptyStyle}>
        <Text size="sm" fw={600}>
          侧栏暂无可用视图
        </Text>
        <Text size="xs" c="dimmed" style={{ textAlign: "center" }}>
          可在设置中启用插件后使用侧栏视图。
        </Text>
      </Stack>
    </div>
  );
}

/** One live view panel: the outlet this container provides for `nav-panel:<viewId>`. */
function Panel({ host, slotId }: { host: PluginHost; slotId: string }) {
  const Outlet = host.provideSlot(slotId);
  return <Outlet id={slotId} />;
}

const rootStyle: CSSProperties = { height: "100%", minHeight: 0 };

/** 可见面板占满 B 区高度；隐藏由 `Transition` 交来的 `display: none` 负责，
 *  所以面板实例一直活着（docs/02 §4.5：隐藏 ≠ 未挂载）。 */
const panelStyle: CSSProperties = { display: "block", height: "100%", minHeight: 0 };

/** 空态占满 B 区并垂直居中；水平居中由 Stack 的 align/justify 负责，不重复设。 */
const emptyStyle: CSSProperties = { height: "100%" };
