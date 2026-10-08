/**
 * `plugin-inspector` — region D's detail container (roadmap P6-47, docs/01 §9.3,
 * docs/02 §4.5).
 *
 * Owns the **focus header, the tab strip and the focus-kind template**. It provides
 * the nested slots `detail-tab:<name>` (one tab each), plus, inside the built-in
 * 信息 tab, `file-extension-zone` / `preview-zone` / `detail-info-zone`. Content
 * plugins decide what any of that means; this file never reads a file, a hash or a tag.
 *
 * Which extra tabs exist comes from the slot runtime: every `detail-tab:<name>` that
 * currently holds a contribution becomes a tab, titled by that plugin's own manifest
 * `label` (`host.slotLabel`) and falling back to the slot name (docs/02 §4.5).
 *
 * Local state = which tab is open, mirrored into the base's `activeDetailTab`
 * through `detail:tab:changed`, so a session switch restores it with the rest of
 * the cascade. Tab subtrees stay mounted (inactive ones hidden) to keep their
 * local state, same rule as `plugin-layout-panes`.
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Badge, Group, Tabs, Text } from "@mantine/core";
import { FileText, FolderClosed } from "lucide-react";
import {
  Events,
  slotPrefix,
  type HostMetaState,
  type PluginHost,
  type Ref,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";

const INFO_TAB = "info";
/** This container's own tab titles; content plugins title their own tabs through
 *  their manifest (`frontend.slots[].label` → `host.slotLabel`). */
const OWN_LABELS: Record<string, string> = { [INFO_TAB]: "信息" };
/** Which zones the built-in 信息 tab shows, per opaque focus `kind` (docs/01 §9.3).
 *  Unknown kinds get the plain info zone — the container still carries, never judges. */
const TEMPLATE: Record<string, string[]> = {
  file: ["file-extension-zone", "preview-zone", "detail-info-zone"],
  folder: ["file-extension-zone", "detail-info-zone"],
};
const FALLBACK_ZONES = ["detail-info-zone"];
/** Chinese names for the zones this container owns. */
const ZONE_LABELS: Record<string, string> = {
  "file-extension-zone": "插件预留",
  "preview-zone": "预览",
  "detail-info-zone": "属性信息",
};
/** `Ref.kind` is plugin-side vocabulary; only the words live here. */
const KIND_LABELS: Record<string, string> = { file: "文件", folder: "目录" };

const tabIdOf = (slotId: string): string => slotId.slice("detail-tab:".length);
const baseName = (path: string): string => {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
};

export function InspectorContainer({ host }: SlotProps) {
  const [meta, setMeta] = useState<HostMetaState>(() => host.getState());
  const [, bump] = useState(0);

  useEffect(() => host.onStateChange(setMeta), [host]);
  useEffect(() => host.onSlotsChange(() => bump((n) => n + 1)), [host]);

  const extraTabs = host.contributedSlots("detail-tab").map(tabIdOf);
  const tabs = [INFO_TAB, ...extraTabs];
  const active = tabs.includes(meta.activeDetailTab) ? meta.activeDetailTab : INFO_TAB;
  const focusKind = meta.focusRef?.kind;
  const zones = TEMPLATE[focusKind ?? ""] ?? FALLBACK_ZONES;

  const selectTab = (tabId: string): void => host.emit(Events.detailTabChanged, { tabId });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <FocusHeader focus={meta.focusRef} />

      <Tabs
        value={active}
        onChange={(v) => {
          if (v) selectTab(String(v));
        }}
        variant="outline"
        styles={{ tab: tabStyle }}
        style={{ flexShrink: 0 }}
      >
        <Tabs.List>
          {tabs.map((t) => (
            <Tabs.Tab key={t} value={t}>
              {host.slotLabel(`detail-tab:${t}`) ?? OWN_LABELS[t] ?? t}
            </Tabs.Tab>
          ))}
        </Tabs.List>
      </Tabs>

      <div style={paneAreaStyle}>
        <div style={active === INFO_TAB ? undefined : hiddenStyle}>
          {zones.map((zone) => (
            <Zone key={zone} host={host} slotId={zone} />
          ))}
        </div>

        {extraTabs.map((t) => (
          <div key={t} style={active === t ? undefined : hiddenStyle}>
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
      <Text size="xs" c="dimmed" py={4}>
        未选择任何项目
      </Text>
    );
  }
  const isDir = focus.kind === "folder";
  return (
    <Group gap={6} wrap="nowrap" style={headerStyle}>
      {isDir ? (
        <FolderClosed size={15} color="var(--mantine-color-yellow-6)" />
      ) : (
        <FileText size={15} color="var(--mantine-color-gray-6)" />
      )}
      <div style={{ minWidth: 0 }}>
        <Text size="sm" fw={600} truncate title={focus.id}>
          {baseName(focus.id)}
        </Text>
        <Text size="xs" c="dimmed" truncate>
          {focus.id}
        </Text>
      </div>
      <Badge size="xs" variant="light" color={isDir ? "yellow" : "blue"} style={{ marginLeft: "auto" }}>
        {KIND_LABELS[focus.kind] ?? focus.kind}
      </Badge>
    </Group>
  );
}

/** One `detail-tab:<name>` outlet. */
function TabPane({ host, tab }: { host: PluginHost; tab: string }) {
  const slotId = `detail-tab:${tab}`;
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
        <div style={emptyZoneStyle}>{ZONE_LABELS[slotId] ?? slotId}：暂无插件注入</div>
      )}
    </div>
  );
}

const tabStyle: CSSProperties = { fontSize: 12, padding: "2px 10px" };

const headerStyle: CSSProperties = {
  padding: "6px 2px",
  borderBottom: "1px solid var(--mantine-color-default-border)",
  flexShrink: 0,
  alignItems: "center",
};

const paneAreaStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  paddingTop: 6,
};

/** Hidden, not unmounted: the tab's plugin keeps its local state (docs/02 §4.5). */
const hiddenStyle: CSSProperties = { display: "none" };

const emptyZoneStyle: CSSProperties = {
  fontSize: 11,
  color: "var(--mantine-color-dimmed)",
  border: "1px dashed var(--mantine-color-default-border)",
  borderRadius: 4,
  padding: "4px 6px",
};
