/**
 * MockDatasetView — the dev harness's B-region dataset picker.
 *
 * It lists `/stress` through the ordinary `fs.list` capability and emits a
 * folder reference on click, i.e. exactly what `view-favorites` / `view-tags`
 * do. The data therefore lands in the **real** center grid (`plugin-file-browser`
 * in a `pane-slot`), so a stress run measures the component users actually look
 * at — virtualization, thumbnails, group headers — instead of a side panel with
 * its own hand-rolled window.
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Divider, Stack, Text } from "@mantine/core";
import {
  Events,
  errorMessage,
  type ListEntry,
  type Ref,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";

const DATASET_ROOT = "/stress";

export function MockDatasetView({ host }: SlotProps) {
  const [entries, setEntries] = useState<ListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    host
      .invoke<ListEntry[]>("fs.list", { path: DATASET_ROOT })
      .then(setEntries)
      .catch((err) => setError(errorMessage(err)));
  }, [host]);

  const open = (ent: ListEntry): void => {
    host.emit(Events.sidebarSelectionChanged, {
      kind: ent.isDir ? "folder" : "file",
      id: ent.path,
      sourcePlugin: "plugin-mock-data",
    } satisfies Ref);
  };

  return (
    <Stack gap={2} style={{ height: "100%", minHeight: 0 }}>
      <Text size="xs" fw={600} px={4} pt={4}>
        模拟数据集
      </Text>
      <Text size="xs" c="dimmed" px={4}>
        点击目录即在中间网格加载；每栏独立，可左右对比不同量级。
      </Text>
      <Divider />
      {error && (
        <Text size="xs" c="red" px={4}>
          {error}
        </Text>
      )}
      <div style={listStyle}>
        {entries.map((ent) => (
          <button
            key={ent.path}
            type="button"
            onClick={() => open(ent)}
            title={ent.path}
            style={rowStyle}
          >
            <Text size="xs" truncate style={{ flex: 1 }}>
              {ent.isDir ? `📁 ${ent.name}` : `📄 ${ent.name}`}
            </Text>
          </button>
        ))}
      </div>
    </Stack>
  );
}

const listStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
};

const rowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  width: "100%",
  padding: "3px 6px",
  fontSize: 12,
  textAlign: "left",
  cursor: "pointer",
  border: "none",
  borderRadius: "var(--mantine-radius-sm)",
  background: "transparent",
  color: "inherit",
};
