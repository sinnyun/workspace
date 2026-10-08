/**
 * MockStressList — nav-zone stress surface for the dev mock harness.
 *
 * Renders the shared store's rows through a hand-rolled window (fixed row
 * height + scroll offset), so hundreds of thousands of mock entries stay smooth
 * — the point of this panel is to *observe* per-region rendering under large
 * data. It measures each commit's JS time (render body -> layout effect) and
 * shows how many rows are actually mounted vs. the total.
 *
 * The measured time is written straight to a <span> ref, NOT React state: doing
 * it in the commit effect with setState would re-trigger the effect and spin an
 * infinite render loop.
 */
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Stack, Text, Group, Badge, Divider, Box } from "@mantine/core";
import type { SlotProps, ListEntry } from "@my-file-manager/plugin-sdk";
import { stressStore } from "./store";

const ROW_H = 26;
const OVERSCAN = 6;

function formatSize(n: number | null): string {
  if (n == null) return "—";
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

export function MockStressList(_props: SlotProps) {
  const s = useSyncExternalStore(stressStore.subscribe, stressStore.get, stressStore.get);
  const rows: ListEntry[] = s.rows;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const msRef = useRef<HTMLSpanElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(360);
  const t0 = useRef(0);

  // Timestamp the start of this render; the layout effect closes it out by
  // writing to the DOM directly (no setState -> no re-render loop).
  t0.current = performance.now();
  useLayoutEffect(() => {
    const ms = performance.now() - t0.current;
    const el = msRef.current;
    if (el) {
      el.textContent = `${ms.toFixed(2)}ms`;
      el.style.color = ms > 16 ? "var(--mantine-color-orange-6)" : "var(--mantine-color-green-6)";
    }
  });

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewportH(el.clientHeight));
    ro.observe(el);
    setViewportH(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  const total = rows.length;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
  const visible = rows.slice(start, end);

  return (
    <Stack gap={4} style={{ height: "100%", minHeight: 0 }}>
      <Group gap={4} wrap="nowrap">
        <Text size="xs" fw={600}>
          压力列表
        </Text>
        <Box style={{ flex: 1 }} />
        <Badge size="sm" variant="light" color="gray">
          挂载 {visible.length}/{total.toLocaleString()}
        </Badge>
        <Badge size="sm" variant="light">
          <span ref={msRef} style={{ fontVariantNumeric: "tabular-nums" }}>
            0.00ms
          </span>
        </Badge>
      </Group>
      <Divider />
      {total === 0 ? (
        <Text size="xs" c="dimmed">
          点击顶栏“模拟数据”按钮注入。
        </Text>
      ) : (
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          style={{ flex: 1, minHeight: 0, overflow: "auto", position: "relative" }}
        >
          <div style={{ height: total * ROW_H, position: "relative" }}>
            {visible.map((r, i) => {
              const idx = start + i;
              return (
                <div
                  key={r.path}
                  style={{
                    position: "absolute",
                    top: idx * ROW_H,
                    left: 0,
                    right: 0,
                    height: ROW_H,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "0 4px",
                    fontSize: 12,
                    borderBottom: "1px solid var(--mantine-color-default-border)",
                    background: idx % 2 ? "var(--mantine-color-dark-7)" : undefined,
                  }}
                >
                  <span style={{ width: 16 }}>{r.isDir ? "📁" : "📄"}</span>
                  <span
                    style={{
                      flex: 1,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.name}
                  </span>
                  <span style={{ color: "var(--mantine-color-dimmed)" }}>
                    {r.isDir ? "" : formatSize(r.size)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Stack>
  );
}
