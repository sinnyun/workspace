/**
 * HistoryPanel — the file-history plugin's sidebar UI.
 *
 * Data flow (docs/01 §5, roadmap P4-2/P4-3): the backend plugin records a
 * snapshot on `file:changed` and emits `history:updated`; this panel reloads on
 * both `history:updated` and `selection:changed` (via host state), so the
 * timeline refreshes with NO polling. All subscriptions are torn down on unload
 * (docs/02 §4.3).
 *
 * Uses Mantine from the shared singleton (import map) so it themes with the base.
 */
import { useCallback, useEffect, useState } from "react";
import {
  Stack,
  Text,
  Timeline,
  Loader,
  Center,
  Code,
  ScrollArea,
} from "@mantine/core";
import type { HostMetaState, SlotProps } from "@my-file-manager/plugin-sdk";
import { Events } from "@my-file-manager/plugin-sdk";

interface HistoryEntry {
  hash: string;
  at: number;
  size?: number;
}

/** History is a per-FILE panel: only a `file` focus reference selects one. */
function focusedFileId(s: HostMetaState): string | null {
  return s.focusRef?.kind === "file" ? s.focusRef.id : null;
}

export function HistoryPanel({ host }: SlotProps) {
  const [path, setPath] = useState<string | null>(focusedFileId(host.getState()));
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(
    async (target: string | null) => {
      if (!target) {
        setEntries([]);
        return;
      }
      setLoading(true);
      try {
        const rows = await host.invoke<HistoryEntry[]>("db.history.list", {
          path: target,
        });
        setEntries(rows ?? []);
      } catch (err) {
        console.error("[file-history] db.history.list failed:", err);
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [host],
  );

  useEffect(() => {
    // The cascade's focus reference drives which file's history we show.
    const offState = host.onStateChange((s) => {
      const fileId = focusedFileId(s);
      setPath(fileId);
      void reload(fileId);
    });
    // Backend-driven refresh: a new snapshot was recorded.
    const offUpdated = host.on<{ path: string }>(Events.historyUpdated, (p) => {
      if (p?.path && p.path === path) void reload(path);
    });
    void reload(path);
    return () => {
      offState();
      offUpdated();
    };
  }, [host, path, reload]);

  if (!path) {
    return (
      <Stack className="fm-detail-block" gap="sm">
        <Text fw={600}>文件历史</Text>
        <Text size="sm" c="dimmed">
          选择一个文件以查看其历史。
        </Text>
      </Stack>
    );
  }

  return (
    <Stack className="fm-detail-block" gap="sm" style={{ height: "100%" }}>
      <Text fw={600}>文件历史</Text>
      <Code style={{ wordBreak: "break-all" }}>{path}</Code>

      {loading ? (
        <Center py="md">
          <Loader size="sm" />
        </Center>
      ) : entries.length === 0 ? (
        <Text size="sm" c="dimmed">
          暂无历史记录。
        </Text>
      ) : (
        <ScrollArea style={{ flex: 1 }}>
          <Timeline active={entries.length} bulletSize={14} lineWidth={1}>
            {[...entries].reverse().map((e, i) => (
              <Timeline.Item
                key={`${e.at}-${i}`}
                title={new Date(e.at).toLocaleString()}
              >
                <Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
                  {e.hash.slice(0, 16)}
                  {typeof e.size === "number" ? ` · ${e.size}B` : ""}
                </Text>
              </Timeline.Item>
            ))}
          </Timeline>
        </ScrollArea>
      )}
    </Stack>
  );
}
