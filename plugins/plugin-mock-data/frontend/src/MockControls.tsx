/**
 * MockControls — topbar-zone control strip for the dev mock harness.
 *
 * Sets the stress dataset size and pulls generated rows through the dev-only
 * `mock.stress` capability, timing the round-trip. The shared store drives
 * MockStressList (nav-zone), so injecting data here repaints that region.
 */
import { useSyncExternalStore } from "react";
import { Group, Button, Badge, Text, Tooltip } from "@mantine/core";
import type { SlotProps, ListEntry } from "@my-file-manager/plugin-sdk";
import { stressStore } from "./store";

const VOLUMES = [100, 1_000, 5_000, 20_000, 100_000];

export function MockControls({ host }: SlotProps) {
  const s = useSyncExternalStore(stressStore.subscribe, stressStore.get, stressStore.get);

  async function load(n: number): Promise<void> {
    stressStore.set({ n, loading: true, error: null });
    const t0 = performance.now();
    try {
      const rows = await host.invoke<ListEntry[]>("mock.stress", { n });
      stressStore.set({ rows: rows ?? [], fetchMs: performance.now() - t0, loading: false });
    } catch (err) {
      stressStore.set({ rows: [], error: String(err), loading: false });
    }
  }

  return (
    <Group gap={6}>
      <Text size="xs" c="dimmed" fw={600}>
        模拟数据:
      </Text>
      {VOLUMES.map((n) => (
        <Button
          key={n}
          size="xs"
          variant={s.n === n ? "filled" : "light"}
          loading={s.loading && s.n === n}
          onClick={() => void load(n)}
        >
          {n.toLocaleString()}
        </Button>
      ))}
      {s.error ? (
        <Tooltip label={s.error}>
          <Badge size="sm" color="red" variant="light">mock.stress 失败</Badge>
        </Tooltip>
      ) : (
        <Badge size="sm" color="teal" variant="light">
          {s.rows.length.toLocaleString()} 行 · 拉取 {s.fetchMs.toFixed(1)}ms
        </Badge>
      )}
    </Group>
  );
}
