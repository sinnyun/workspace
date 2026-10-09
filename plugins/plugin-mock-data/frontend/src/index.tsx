/**
 * mock-data dev plugin entry (docs/02 §4). Dev-only: served through the browser
 * mock index (dev-mocks.ts); the dataset itself comes from the ordinary
 * `fs.list` / `thumb.image` capabilities, so nothing here is a special data path.
 *
 * Two named exports: `StressIcon` (A activity rail, selects the "stress" sidebar
 * view) and `MockDatasetView` (nav-panel:stress, i.e. region B's content behind
 * `plugin-layout-views`). The view lists the synthetic volumes and emits a folder
 * reference on click, which the center grid's browser pane follows — the point is
 * that the pressure test runs through the real rendering path, not a side panel.
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Events, type PluginHost, type SlotProps } from "@my-file-manager/plugin-sdk";
import { MockDatasetView } from "./MockDatasetView";

const VIEW_ID = "stress";

export function activate(_host: PluginHost): void {
  // Panels are mounted by the base via named exports; no imperative setup needed.
}

/** A rail icon for the stress view — same shape as the production view plugins use. */
export function StressIcon({ host }: SlotProps) {
  const [active, setActive] = useState(host.getState().activeSidebarView);
  useEffect(() => host.onStateChange((s) => setActive(s.activeSidebarView)), [host]);
  return (
    <button
      type="button"
      className="fm-rail-button" aria-label="模拟数据集" aria-pressed={active === VIEW_ID}
      title="模拟数据集(压力测试)"
      onClick={() => host.emit(Events.sidebarViewChanged, { viewId: VIEW_ID })}
      style={railButtonStyle(active === VIEW_ID)}
    >
      ▥
    </button>
  );
}

const railButtonStyle = (active: boolean): CSSProperties => ({
  display: "block",
  width: 40,
  height: 40,
  margin: "2px auto",
  fontSize: 16,
  cursor: "pointer",
  borderRadius: "var(--mantine-radius-md)",
  border: "none",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
});

export { MockDatasetView };
