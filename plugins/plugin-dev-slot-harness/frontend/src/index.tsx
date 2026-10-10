/**
 * Dev-only harness — the runtime evidence for roadmap P6-45 and P7-30.
 *
 * It plays BOTH roles at once so the whole path is exercised in a real browser:
 *  - as a CONTAINER it provides two nested outlets (`dev-pane:0`, `dev-pane:1`)
 *    through `host.provideSlot`, and toggles one to show `slot:registered` /
 *    `slot:disposed`;
 *  - as CONTENT it injects a card into each outlet through `host.contributeToSlot`
 *    in `activate`, and the card renders the `slotId` it was injected into.
 *
 * It also makes deliberately FORBIDDEN attempts, each of which must be refused by
 * the base with a warning and produce nothing — docs/02 §8 and docs/04 P7-30
 * enforced at runtime rather than in a review comment:
 *  - inject into `file-sidebar-zone` (absent from `permissions.slots.contribute`);
 *  - provide `forbidden-prefix:0` (absent from `frontend.provides`);
 *  - claim the command palette via `commands.provide()` (register granted,
 *    provide NOT);
 *  - register `harness.bad-shortcut` with a malformed `"Ctrl+"`;
 *  - register `harness.dup-shortcut` on `"Ctrl+Shift+F"`, already claimed by
 *    `search.open`.
 * None of the refused commands may appear in the palette.
 */

import type { PluginHost, SlotProps } from "@my-file-manager/plugin-sdk";
import { disposer, Events } from "@my-file-manager/plugin-sdk";
import { useEffect, useState } from "react";

/** The component injected into each nested outlet: proves the outlet hands the
 *  contributor its own gated host plus the nested slot identity. */
function PaneCard({ host, slotId }: SlotProps) {
  const [focus, setFocus] = useState<string>(host.getState().focusRef?.id ?? "");
  useEffect(() => host.onStateChange((s) => setFocus(s.focusRef?.id ?? "")), [host]);
  return (
    <div
      style={{
        border: "1px dashed var(--mantine-color-blue-6)",
        padding: "4px 6px",
        fontSize: 12,
      }}
    >
      <b>{slotId}</b> 已注入 · 本会话焦点：
      <span title={focus}>{focus || "(无)"}</span>
    </div>
  );
}

export function activate(host: PluginHost): () => void {
  const offs = [host.contributeToSlot("dev-pane:0", PaneCard), host.contributeToSlot("dev-pane:1", PaneCard)];
  host.contributeToSlot("file-sidebar-zone", PaneCard); // must be DENIED
  host.provideSlot("forbidden-prefix:0"); // must be DENIED
  host.commands?.provide(); // must be DENIED (provide not granted)
  host.commands?.register({
    id: "harness.bad-shortcut",
    title: "非法快捷键自检",
    shortcut: "Ctrl+", // malformed — the whole command must be refused
    run: () => {},
  });
  host.commands?.register({
    id: "harness.dup-shortcut",
    title: "重复快捷键自检",
    shortcut: "Ctrl+Shift+F", // claimed by search.open — must be refused
    run: () => {},
  });
  return disposer(...offs);
}

export function SlotHarness({ host }: SlotProps) {
  // provideSlot is idempotent and identity-stable per id, so render-time calls are safe.
  const Outlet0 = host.provideSlot("dev-pane:0");
  const Outlet1 = host.provideSlot("dev-pane:1");
  const [secondOpen, setSecondOpen] = useState(true);
  const [trail, setTrail] = useState<string[]>([]);

  useEffect(() => {
    const push = (line: string) => setTrail((t) => [...t.slice(-5), line]);
    const offs = [
      host.on<{ slotId: string }>(Events.slotRegistered, (p) => push(`registered ${p.slotId}`)),
      host.on<{ slotId: string }>(Events.slotDisposed, (p) => push(`disposed ${p.slotId}`)),
    ];
    return disposer(...offs);
  }, [host]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: 8,
        fontSize: 12,
        border: "1px solid var(--mantine-color-default-border)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <b>嵌套槽自检（P6-45）</b>
        <button type="button" onClick={() => setSecondOpen((v) => !v)}>
          {secondOpen ? "卸载 dev-pane:1" : "挂载 dev-pane:1"}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 160 }}>
          <Outlet0 id="dev-pane:0" />
        </div>
        {secondOpen && (
          <div style={{ flex: 1, minWidth: 160 }}>
            <Outlet1 id="dev-pane:1" />
          </div>
        )}
      </div>

      <div style={{ fontFamily: "monospace", color: "var(--mantine-color-dimmed)" }}>
        {trail.length === 0 ? "(等待 slot:registered)" : trail.join(" · ")}
      </div>
    </div>
  );
}
