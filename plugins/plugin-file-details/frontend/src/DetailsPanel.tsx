/**
 * DetailsPanel — the file-details plugin's right-region UI.
 *
 * On selection change (host state) it pulls fs.stat for the properties and
 * hash.compute for the content digest, with no polling (docs/01 §5). All
 * subscriptions are torn down on unload. Mantine comes from the shared singleton
 * so it themes identically to the base and the other sidebar panels.
 */
import { useCallback, useEffect, useState } from "react";
import { Stack, Text, Title, Table, Badge, Code, Skeleton, Group } from "@mantine/core";
import type { SlotProps, StatOut } from "@my-file-manager/plugin-sdk";

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

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "—";
}

function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

export function DetailsPanel({ host }: SlotProps) {
  const [path, setPath] = useState<string | null>(host.getState().focusRef?.id ?? null);
  const [stat, setStat] = useState<StatOut | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(
    async (target: string | null) => {
      setStat(null);
      setHash(null);
      if (!target) return;
      setLoading(true);
      try {
        const s = await host.invoke<StatOut>("fs.stat", { path: target });
        setStat(s);
        if (s && !s.isDir) {
          const h = await host.invoke<string>("hash.compute", { path: target, algo: "blake3" });
          setHash(String(h));
        }
      } catch (err) {
        console.error("[file-details] load failed:", err);
      } finally {
        setLoading(false);
      }
    },
    [host],
  );

  useEffect(() => {
    const offState = host.onStateChange((s) => {
      const focused = s.focusRef?.id ?? null;
      setPath(focused);
      void reload(focused);
    });
    void reload(path);
    return offState;
  }, [host, path, reload]);

  if (!path) {
    return (
      <Stack className="fm-detail-block" gap="xs">
        <Title order={6}>文件详情</Title>
        <Text size="sm" c="dimmed">
          名称、大小、类型和修改时间会显示在这里。
        </Text>
      </Stack>
    );
  }

  return (
    <Stack className="fm-detail-block" gap="xs">
      <Group justify="space-between">
        <Title order={6}>文件详情</Title>
        <Badge size="sm" variant="light" color={stat?.isDir ? "blue" : "gray"}>
          {stat?.isDir ? "文件夹" : "文件"}
        </Badge>
      </Group>

      {loading && <Skeleton height={14} radius="xs" />}

      <Table withRowBorders verticalSpacing={6} style={{ fontSize: 12 }}>
        <Table.Tbody>
          <Table.Tr>
            <Table.Td style={{ color: "var(--mantine-color-dimmed)", width: 72 }}>名称</Table.Td>
            <Table.Td style={{ wordBreak: "break-all" }}>{baseName(path)}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>路径</Table.Td>
            <Table.Td style={{ wordBreak: "break-all" }}>{path}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>大小</Table.Td>
            <Table.Td>{stat ? (stat.isDir ? "—" : formatSize(stat.size)) : "—"}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>类型</Table.Td>
            <Table.Td>{baseName(path) ? extension(baseName(path)) : "—"}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>修改时间</Table.Td>
            <Table.Td>
              {stat?.modifiedMs ? new Date(stat.modifiedMs).toLocaleString() : "—"}
            </Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>BLAKE3</Table.Td>
            <Table.Td>
              {hash ? (
                <Code style={{ wordBreak: "break-all" }}>{hash}</Code>
              ) : stat?.isDir ? (
                "—"
              ) : (
                hash === null && !loading ? "—" : ""
              )}
            </Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Stack>
  );
}
