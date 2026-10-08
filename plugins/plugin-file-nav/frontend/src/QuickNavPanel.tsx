/**
 * QuickNavPanel — the file-nav plugin's left-region (nav-zone) UI.
 *
 * Shows the home location, a small "常用位置" list, and a breadcrumb of the
 * current selection (derived from host meta-state, not business state — red
 * line 2). Selecting a file broadcasts `selection:changed` from the base, so the
 * breadcrumb refreshes reactively with no polling.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Stack, Text, Title, Group, Divider, ThemeIcon, Paper } from "@mantine/core";
import type { SlotProps } from "@my-file-manager/plugin-sdk";

const FAVORITES = [
  { label: "Demo", path: "/demo", icon: "★" },
  { label: "Demo / src", path: "/demo/src", icon: "★" },
];

const linkStyle: CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "transparent",
  border: "none",
  cursor: "pointer",
  padding: "2px 4px",
  borderRadius: 4,
  color: "inherit",
  font: "inherit",
};

/** Split a posix/windows path into display segments with cumulative prefixes. */
function breadcrumbs(path: string): Array<{ label: string; full: string }> {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const sep = path.includes("\\") ? "\\" : "/";
  const root = path.startsWith(sep) ? (sep === "\\" ? "\\" : "/") : parts[0];
  const out: Array<{ label: string; full: string }> = [];
  let acc = sep === "/" ? "" : "";
  parts.forEach((p, i) => {
    acc = i === 0 ? `${sep}${p}` : `${acc}${sep}${p}`;
    out.push({ label: p, full: acc });
  });
  if (out.length === 0) out.push({ label: root, full: root });
  return out;
}

export function QuickNavPanel({ host }: SlotProps) {
  const [home, setHome] = useState<string | null>(null);
  const [currentFileId, setCurrentFile] = useState<string | null>(host.getState().currentFileId);

  useEffect(() => {
    host.invoke<string>("fs.home")
      .then((h) => setHome(String(h)))
      .catch(() => setHome(null));
    return host.onStateChange((s) => setCurrentFile(s.currentFileId));
  }, [host]);

  return (
    <Stack gap="xs">
      <Title order={6}>快捷导航</Title>

      {home && (
        <button type="button" onClick={() => setCurrentFile(home)} style={linkStyle}>
          <Group gap={6}>
            <ThemeIcon size="sm" variant="subtle" color="blue">⌂</ThemeIcon>
            <Text size="sm">主页</Text>
          </Group>
        </button>
      )}

      <Divider my={2} />
      <Text size="xs" c="dimmed" fw={600}>常用位置</Text>
      {FAVORITES.map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => setCurrentFile(f.path)}
          style={linkStyle}
        >
          <Group gap={6}>
            <span style={{ color: "var(--mantine-color-yellow-6)" }}>{f.icon}</span>
            <Text size="sm">{f.label}</Text>
          </Group>
        </button>
      ))}

      {currentFileId && (
        <>
          <Divider my={2} />
          <Text size="xs" c="dimmed" fw={600}>当前位置</Text>
          <Paper p={6} withBorder radius="xs">
            <Group gap={2}>
              {breadcrumbs(currentFileId).map((b, i, arr) => (
                <Text key={b.full} size="xs">
                  {b.label}
                  {i < arr.length - 1 ? <span style={{ color: "var(--mantine-color-dimmed)" }}> › </span> : null}
                </Text>
              ))}
            </Group>
          </Paper>
        </>
      )}
    </Stack>
  );
}
