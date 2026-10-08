/**
 * `plugin-settings` — the 设置 view (roadmap P6-56, docs/08 §5).
 *
 * Contributes the A rail's bottom gear and a `nav-panel:settings` panel; the
 * exclusive rendering is `plugin-layout-views`' job. Theme choice is delegated
 * entirely to Mantine (`useMantineColorScheme`): it owns the `data-mantine-color-scheme`
 * attribute and its own persistence, so the base header switch and this panel read
 * and write ONE value. The plugin has no storage key of its own and the base holds
 * no business state (docs/01 §6 red line 2).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Group, SegmentedControl, Stack, Text, useMantineColorScheme } from "@mantine/core";
import { Monitor, Moon, Settings, Sun } from "lucide-react";
import { Events, type SlotProps } from "@my-file-manager/plugin-sdk";

const VIEW_ID = "settings";
type Scheme = "auto" | "light" | "dark";

export function RailIcon({ host }: SlotProps) {
  const [active, setActive] = useState(host.getState().activeSidebarView);
  useEffect(() => host.onStateChange((s) => setActive(s.activeSidebarView)), [host]);
  return (
    <button
      type="button"
      title="设置"
      aria-label="设置"
      onClick={() => host.emit(Events.sidebarViewChanged, { viewId: VIEW_ID })}
      style={railButtonStyle(active === VIEW_ID)}
    >
      <Settings size={17} />
    </button>
  );
}

export function SettingsPanel() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <Stack gap="sm" style={{ fontSize: 12 }}>
      <Text fw={600}>外观</Text>
      <SegmentedControl
        fullWidth
        size="xs"
        value={colorScheme}
        onChange={(v) => setColorScheme(v as Scheme)}
        data={[
          { value: "auto", label: <SchemeLabel icon={<Monitor size={12} />} text="跟随系统" /> },
          { value: "light", label: <SchemeLabel icon={<Sun size={12} />} text="亮色" /> },
          { value: "dark", label: <SchemeLabel icon={<Moon size={12} />} text="暗色" /> },
        ]}
      />
      <Text size="xs" c="dimmed">
        主题由界面库记忆并即时生效，与其他入口共用同一个值。
      </Text>
    </Stack>
  );
}

const SchemeLabel = ({ icon, text }: { icon: ReactNode; text: string }) => (
  <Group gap={4} wrap="nowrap">
    {icon}
    <span>{text}</span>
  </Group>
);

const railButtonStyle = (active: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 36,
  height: 36,
  margin: "2px auto",
  cursor: "pointer",
  borderRadius: 6,
  border: "none",
  // The rail is a flex column, so the gear sits at its bottom edge.
  marginTop: "auto",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
  color: active ? "var(--mantine-color-blue-7)" : "var(--mantine-color-dimmed)",
});
