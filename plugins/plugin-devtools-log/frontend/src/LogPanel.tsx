/**
 * LogPanel — the organized debug view for captured runtime data (bottom-drawer).
 *
 * Renders the store's records newest-first with per-level filtering, text
 * search, clear, and JSON export. Only the last window of matching records is
 * mounted to stay responsive when the buffer is full — this is a debug tool, so
 * it must not itself become the slow thing on screen.
 */

import {
  ActionIcon,
  Badge,
  Box,
  Group,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import type { SlotProps } from "@my-file-manager/plugin-sdk";
import { formatClock } from "@my-file-manager/plugin-sdk";
import { Download, Trash2 } from "lucide-react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { type LogLevel, type LogRecord, logStore } from "./store";

const LEVELS: LogLevel[] = ["error", "warn", "info", "log", "perf"];
const LEVEL_COLOR: Record<LogLevel, string> = {
  error: "red",
  warn: "orange",
  info: "blue",
  log: "gray",
  perf: "violet",
};

const WINDOW = 1000;

export function LogPanel(_props: SlotProps) {
  const records = useSyncExternalStore(logStore.subscribe, logStore.getSnapshot, logStore.getSnapshot);
  const [enabled, setEnabled] = useState<Set<LogLevel>>(new Set(LEVELS));
  const [query, setQuery] = useState("");
  const [newestFirst, setNewestFirst] = useState(true);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  // biome-ignore lint/correctness/useExhaustiveDependencies: 计数由 store 当前记录派生，records 变化后必须重算
  const counts = useMemo(() => logStore.counts(), [records]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = records.filter(
      (r) =>
        enabled.has(r.level) &&
        (q === "" ||
          r.message.toLowerCase().includes(q) ||
          r.source.toLowerCase().includes(q) ||
          (r.detail ?? "").toLowerCase().includes(q)),
    );
    return newestFirst ? [...out].reverse() : out;
  }, [records, enabled, query, newestFirst]);

  const shown = filtered.slice(0, WINDOW);

  const toggleLevel = (lvl: LogLevel): void => {
    setEnabled((prev) => {
      const next = new Set(prev);
      if (next.has(lvl)) next.delete(lvl);
      else next.add(lvl);
      return next;
    });
  };

  const toggleExpand = (id: number): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(filtered, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `fm-devtools-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack gap={4} style={{ height: "100%", minHeight: 0 }}>
      <Group gap={6}>
        <Title order={6}>调试台</Title>
        {LEVELS.map((lvl) => (
          <Badge
            key={lvl}
            size="sm"
            variant={enabled.has(lvl) ? "filled" : "light"}
            color={LEVEL_COLOR[lvl]}
            style={{ cursor: "pointer" }}
            onClick={() => toggleLevel(lvl)}
          >
            {lvl} {counts[lvl]}
          </Badge>
        ))}
        <Box style={{ flex: 1 }} />
        <SegmentedControl
          size="xs"
          data={["新在上", "旧在上"]}
          value={newestFirst ? "新在上" : "旧在上"}
          onChange={(v) => setNewestFirst(v === "新在上")}
        />
        <ActionIcon size="sm" variant="light" color="gray" aria-label="导出日志" title="导出 JSON" onClick={exportJson}>
          <Download size={14} />
        </ActionIcon>
        <ActionIcon
          size="sm"
          variant="light"
          color="red"
          aria-label="清空日志"
          title="清空"
          onClick={() => logStore.clear()}
        >
          <Trash2 size={14} />
        </ActionIcon>
      </Group>

      <TextInput
        size="xs"
        placeholder="搜索消息 / 来源 / 堆栈…"
        value={query}
        onChange={(e) => setQuery(e.currentTarget.value)}
      />

      <ScrollArea style={{ flex: 1, minHeight: 0 }} type="always">
        {shown.length === 0 ? (
          <Text size="xs" c="dimmed" p={4}>
            （无匹配记录）
          </Text>
        ) : (
          <Stack gap={0}>
            {shown.map((r) => (
              <LogRow key={r.id} record={r} expanded={expanded.has(r.id)} onToggle={() => toggleExpand(r.id)} />
            ))}
            {filtered.length > WINDOW && (
              <Text size="xs" c="dimmed" p={4}>
                仅显示最近 {WINDOW} / {filtered.length.toLocaleString()} 条
              </Text>
            )}
          </Stack>
        )}
      </ScrollArea>
    </Stack>
  );
}

function LogRow({ record: r, expanded, onToggle }: { record: LogRecord; expanded: boolean; onToggle: () => void }) {
  const hasDetail = Boolean(r.detail);
  return (
    <Box
      className="fm-log-row"
      style={{
        borderBottom: "1px solid var(--mantine-color-default-border)",
        padding: "5px 6px",
        cursor: hasDetail ? "pointer" : "default",
      }}
      onClick={hasDetail ? onToggle : undefined}
    >
      <Group gap={6} wrap="nowrap" style={{ alignItems: "flex-start" }}>
        <Text size="xs" c="dimmed" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {formatClock(r.at)}
        </Text>
        <Badge size="xs" color={LEVEL_COLOR[r.level]} variant="light" style={{ minWidth: 44, textAlign: "center" }}>
          {r.level}
        </Badge>
        <Text size="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
          {r.source}
        </Text>
        <Text size="xs" style={{ wordBreak: "break-word", flex: 1 }}>
          {r.message}
        </Text>
      </Group>
      {expanded && hasDetail && (
        <Box
          className="fm-log-detail"
          component="pre"
          mih={0}
          style={{
            margin: "4px 0 2px 0",
            padding: 6,
            fontSize: 11,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "var(--mantine-color-dark-8)",
            borderRadius: "var(--mantine-radius-sm)",
          }}
        >
          {r.detail}
        </Box>
      )}
    </Box>
  );
}
