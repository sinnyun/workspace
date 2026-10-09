/**
 * `plugin-layout-views` — region B's exclusive view container (roadmap P6-48,
 * docs/01 §9.1/§9.3).
 *
 * B shows **one** sidebar view at a time, and that exclusion is this container's
 * job — not a `return null` each view panel has to remember to write. It occupies
 * `nav-zone`, discovers every `nav-panel:<viewId>` that holds a contribution
 * (`host.contributedSlots`, docs/02 §4.5) and renders exactly the one matching the
 * base's opaque `activeSidebarView`; with no view chosen it falls back to the first.
 *
 * Inactive panels stay mounted but hidden: unmounting would drop their local state
 * (tree expansion, scroll) every time the user taps another A icon, and rebuilding
 * it is the view plugin's business, not the container's.
 *
 * Geometry + selection only: this file never lists a directory, a favorite or a tag.
 */
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { type PluginHost, type SlotProps } from "@my-file-manager/plugin-sdk";

const PREFIX = "nav-panel";

export function ViewsContainer({ host }: SlotProps) {
  const [activeView, setActiveView] = useState(host.getState().activeSidebarView);
  const [, bump] = useState(0);

  useEffect(() => host.onStateChange((s) => setActiveView(s.activeSidebarView)), [host]);
  useEffect(() => host.onSlotsChange(() => bump((n) => n + 1)), [host]);

  const panels = host.contributedSlots(PREFIX);
  if (panels.length === 0) return null;
  const wanted = `${PREFIX}:${activeView}`;
  const active = panels.includes(wanted) ? wanted : panels[0];

  return (
    <div style={{ height: "100%", minHeight: 0 }}>
      {panels.map((slotId) => (
        <div key={slotId} style={slotId === active ? { display: "block", height: "100%", minHeight: 0 } : hiddenStyle}>
          <Panel host={host} slotId={slotId} />
        </div>
      ))}
    </div>
  );
}

/** One live view panel: the outlet this container provides for `nav-panel:<viewId>`. */
function Panel({ host, slotId }: { host: PluginHost; slotId: string }) {
  const Outlet = host.provideSlot(slotId);
  return <Outlet id={slotId} />;
}

/** Hidden, not unmounted — the view plugin keeps its local state (docs/02 §4.5). */
const hiddenStyle: CSSProperties = { display: "none" };
