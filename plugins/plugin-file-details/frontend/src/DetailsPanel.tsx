/**
 * DetailsPanel — the file-details plugin's D-region UI (docs/plugin-functional/
 * plugin-file-details.md).
 *
 * One focus reference in, three independent outputs out: `fs.stat` for the
 * properties, `hash.compute` for the digest (its own loading state, so a slow
 * hash never blocks the table), and `clipboard.write` for "copy path". Every
 * async result carries the token of the request that produced it, so a late
 * answer for a previously focused file can never paint over the current one
 * (docs/09 §9.2). All subscriptions die with the component.
 */

import { ActionIcon, Badge, Code, Group, Stack, Table, Text, Title, Tooltip } from "@mantine/core";
import type { SlotProps, StatOut } from "@my-file-manager/plugin-sdk";
import { errorMessage, formatDateTime, formatSize } from "@my-file-manager/plugin-sdk";
import { Copy } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

function extension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "—";
}

function baseName(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Capability errors arrive with the Rust `CapabilityError` text; map the kinds
 *  the spec requires to distinct Chinese reasons instead of one generic 加载失败. */
function userError(err: unknown): string {
  const text = errorMessage(err);
  if (/permission denied/i.test(text)) return "没有权限读取该项目。";
  if (/not found/i.test(text)) return "该项目已不存在，可能已被移动或删除。";
  if (/invalid argument/i.test(text)) return "路径无效，无法读取。";
  return text || "读取该项目时出错。";
}

interface Snapshot {
  stat: StatOut | null;
  error: string | null;
}

export function DetailsPanel({ host }: SlotProps) {
  const [target, setTarget] = useState<{ kind: string; path: string } | null>(() => {
    const ref = host.getState().focusRef;
    return ref ? { kind: ref.kind, path: ref.id } : null;
  });
  const [snap, setSnap] = useState<Snapshot>({ stat: null, error: null });
  const [statLoading, setStatLoading] = useState(false);
  const [hash, setHash] = useState<string | null>(null);
  const [hashLoading, setHashLoading] = useState(false);
  const [hashError, setHashError] = useState<string | null>(null);
  /** Transient copy feedback: lives in component memory only (docs/09 §7). */
  const [copied, setCopied] = useState<"ok" | string | null>(null);
  /** Per-field request tokens: a stale answer is dropped, not painted (docs/09 §9.2). */
  const statToken = useRef(0);
  const hashToken = useRef(0);

  const load = useCallback(
    async (next: { kind: string; path: string } | null) => {
      const myStat = ++statToken.current;
      const myHash = ++hashToken.current;
      setSnap({ stat: null, error: null });
      setHash(null);
      setHashError(null);
      if (!next) {
        setStatLoading(false);
        setHashLoading(false);
        return;
      }
      setStatLoading(true);
      // A directory has no content digest. Before `fs.stat` lands the focus kind
      // is all we have, so a file-kind reference starts hashing right away.
      let fileLike = next.kind !== "folder" && next.kind !== "directory";
      try {
        const stat = await host.invoke<StatOut>("fs.stat", { path: next.path });
        if (myStat !== statToken.current) return;
        setSnap({ stat, error: null });
        fileLike = !stat.isDir;
      } catch (err) {
        if (myStat !== statToken.current) return;
        setSnap({ stat: null, error: userError(err) });
        return;
      } finally {
        if (myStat === statToken.current) setStatLoading(false);
      }
      if (!fileLike || myHash !== hashToken.current) return;
      setHashLoading(true);
      try {
        const digest = await host.invoke<string>("hash.compute", {
          path: next.path,
          algo: "blake3",
        });
        if (myHash !== hashToken.current) return;
        setHash(String(digest));
      } catch (err) {
        if (myHash !== hashToken.current) return;
        setHashError(userError(err));
      } finally {
        if (myHash === hashToken.current) setHashLoading(false);
      }
    },
    [host],
  );

  useEffect(
    () =>
      host.onStateChange((s) => {
        const ref = s.focusRef;
        setTarget(ref ? { kind: ref.kind, path: ref.id } : null);
      }),
    [host],
  );

  useEffect(() => {
    setCopied(null);
    void load(target);
  }, [load, target]);

  if (!target) {
    return (
      <Stack className="fm-detail-block" gap="xs">
        <Title order={6}>文件详情</Title>
        <Text size="sm" c="dimmed">
          在中间区域选中文件或目录后，这里显示名称、大小、类型和修改时间。
        </Text>
      </Stack>
    );
  }

  const isDir = target.kind === "folder" || target.kind === "directory";
  const stat = snap.stat;
  const copyPath = (): void => {
    host
      .invoke("clipboard.write", { text: target.path })
      .then(() => setCopied("ok"))
      .catch((err) => setCopied(userError(err)));
  };

  return (
    <Stack className="fm-detail-block" gap="xs">
      <Group justify="space-between">
        <Title order={6}>文件详情</Title>
        <Badge size="sm" variant="light" color={isDir ? "blue" : "gray"}>
          {isDir ? "文件夹" : target.kind === "file" ? "文件" : target.kind}
        </Badge>
      </Group>

      {snap.error ? (
        <Stack gap={4}>
          <Text size="sm" c="red">
            {snap.error}
          </Text>
          <Text size="xs" c="dimmed">
            重新选择该项目可再次读取。
          </Text>
        </Stack>
      ) : (
        <Table withRowBorders verticalSpacing={6} style={{ fontSize: 12 }}>
          <Table.Tbody>
            <Table.Tr>
              <Table.Td style={{ color: "var(--mantine-color-dimmed)", width: 72 }}>名称</Table.Td>
              <Table.Td style={{ wordBreak: "break-all" }}>{baseName(target.path)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>路径</Table.Td>
              <Table.Td style={{ wordBreak: "break-all" }}>
                <Group gap={6} wrap="nowrap">
                  <span>{target.path}</span>
                  <Tooltip label="复制路径">
                    <ActionIcon size="xs" variant="subtle" aria-label="复制路径" onClick={copyPath}>
                      <Copy size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Group>
              </Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>大小</Table.Td>
              <Table.Td>{statLoading ? "读取中…" : stat ? (stat.isDir ? "—" : formatSize(stat.size)) : "—"}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>类型</Table.Td>
              <Table.Td>{isDir ? "文件夹" : extension(baseName(target.path))}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>修改时间</Table.Td>
              <Table.Td>{statLoading ? "读取中…" : formatDateTime(stat?.modifiedMs ?? null)}</Table.Td>
            </Table.Tr>
            <Table.Tr>
              <Table.Td style={{ color: "var(--mantine-color-dimmed)" }}>BLAKE3</Table.Td>
              <Table.Td>
                {isDir ? (
                  "—"
                ) : hashLoading ? (
                  <Text size="xs" c="dimmed" inline>
                    计算中…（大文件可能需要等待）
                  </Text>
                ) : hash ? (
                  <Code style={{ wordBreak: "break-all" }}>{hash}</Code>
                ) : hashError ? (
                  <Text size="xs" c="red" inline>
                    {hashError}
                  </Text>
                ) : (
                  "—"
                )}
              </Table.Td>
            </Table.Tr>
          </Table.Tbody>
        </Table>
      )}

      {copied !== null &&
        (copied === "ok" ? (
          <Text size="xs" c="dimmed">
            路径已复制到剪贴板。
          </Text>
        ) : (
          <Text size="xs" c="red">
            {copied}，可直接选中上面的路径文本。
          </Text>
        ))}
    </Stack>
  );
}
