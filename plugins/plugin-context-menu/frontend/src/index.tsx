/**
 * plugin-context-menu — the app-wide right-click PANEL (docs/plugin-functional/
 * plugin-context-menu.md, roadmap P7-11).
 *
 * Scope: appearance, positioning, filtering and keyboard behaviour ONLY. Every
 * action belongs to the plugin that registered it; this file never calls a
 * business capability, never interprets a `Ref`, and never persists a context.
 *
 * The panel lives in a `Portal` over the whole window. It is mounted from the
 * always-present status bar slot, so it needs no base-reserved overlay slot.
 */
import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { Group, Loader, Paper, Portal, Stack, Text } from "@mantine/core";
import type {
  ContextMenuItemDescriptor,
  ContextMenuProvider,
  SlotProps,
} from "@my-file-manager/plugin-sdk";
import type { PluginHost } from "@my-file-manager/plugin-sdk";

/** Opening/closing is a 160–220ms menu transition (docs/09 §3.2); the shell's
 *  global reduced-motion rule collapses it to near zero. */
const MENU_MS = 180;
const PANEL_WIDTH = 236;
const EDGE = 6;

interface Row {
  owner: string;
  id: string;
  label: string;
  shortcut?: string;
  order: number;
  enabled: boolean;
  group: string;
}

/** Group order = the order the first member of a group appears after sorting. */
function buildRows(
  provider: ContextMenuProvider,
  context: NonNullable<ReturnType<ContextMenuProvider["current"]>>["context"],
  executingId: string | null,
): Row[][] {
  const visible: Row[] = [];
  for (const { owner, descriptor } of provider.items()) {
    if (descriptor.when && !descriptor.when(context)) continue;
    visible.push({
      owner,
      id: descriptor.id,
      label: descriptor.label,
      shortcut: descriptor.shortcut,
      order: descriptor.order ?? 0,
      // A running action blocks the whole panel: no double-triggering (spec).
      enabled: executingId === null && (descriptor.enabled ? descriptor.enabled(context) : true),
      group: descriptor.group ?? "",
    });
  }
  visible.sort(
    (a, b) => a.order - b.order || a.label.localeCompare(b.label, "zh-Hans-CN"),
  );
  const groups: Row[][] = [];
  for (const row of visible) {
    const last = groups[groups.length - 1];
    if (last && last[0] && last[0].group === row.group) last.push(row);
    else groups.push([row]);
  }
  return groups;
}

export function activate(_host: PluginHost): void {
  // The panel claims its provider on mount; nothing to install globally.
}

export function MenuLayer({ host }: SlotProps) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [provider] = useState<ContextMenuProvider | null>(
    () => host.contextMenu?.provide() ?? null,
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: EDGE, y: EDGE });
  const [active, setActive] = useState(0);
  /** Where focus was before the menu opened — restored on close (spec). */
  const restoreFocus = useRef<Element | null>(null);

  useEffect(() => {
    if (!provider) return;
    return provider.onChange(rerender);
  }, [provider]);

  const request = provider?.current() ?? null;
  const open = request !== null;
  const executing = provider?.executing() ?? null;
  const groups = request && provider ? buildRows(provider, request.context, executing?.id ?? null) : [];
  const flatRows = groups.flat();

  // A surface with no applicable action gets no panel at all, not an empty one.
  useEffect(() => {
    if (request && provider && flatRows.length === 0) provider.close();
  }, [request, provider, flatRows.length]);

  // Capture the trigger, reset the cursor, and take focus into the panel.
  useEffect(() => {
    if (!request) return;
    restoreFocus.current = document.activeElement;
    setActive(0);
    panelRef.current?.focus();
  }, [request]);

  // Caret returns to the trigger, as with a native menu.
  useEffect(() => {
    if (open) return;
    const target = restoreFocus.current;
    restoreFocus.current = null;
    if (target instanceof HTMLElement) target.focus();
  }, [open]);

  // Dismissal listeners attach on the NEXT task, never inside the event that opened
  // the menu: React flushes effects before a discrete `contextmenu` finishes
  // propagating to `window`, so attaching synchronously would let the very click
  // that showed the menu close it again. A later foreign menu / scroll / resize still
  // dismisses, except when a contributor opened a newer request in that same event —
  // then the newer menu wins instead of being knocked down.
  const seq = request?.seq ?? 0;
  useEffect(() => {
    if (!open) return;
    const dismiss = () => {
      window.setTimeout(() => {
        const cur = provider?.current();
        if (!cur || cur.seq === seq) provider?.close();
      }, 0);
    };
    const detach: Array<() => void> = [];
    const attach = (): void => {
      const offKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") provider?.close();
      };
      const offDown = (e: MouseEvent) => {
        if (!panelRef.current?.contains(e.target as Node)) provider?.close();
      };
      detach.push(
        () => document.removeEventListener("keydown", offKey),
        () => document.removeEventListener("mousedown", offDown, true),
        () => window.removeEventListener("resize", dismiss),
        () => window.removeEventListener("scroll", dismiss, true),
        () => window.removeEventListener("contextmenu", dismiss),
      );
      document.addEventListener("keydown", offKey);
      document.addEventListener("mousedown", offDown, true);
      window.addEventListener("resize", dismiss);
      window.addEventListener("scroll", dismiss, true);
      window.addEventListener("contextmenu", dismiss);
    };
    const id = window.setTimeout(attach, 0);
    return () => {
      window.clearTimeout(id);
      for (const off of detach) off();
    };
  }, [open, seq, provider]);

  useLayoutEffect(() => {
    if (!request) return;
    const el = panelRef.current;
    const w = el?.offsetWidth ?? PANEL_WIDTH;
    const h = el?.offsetHeight ?? 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const anchor = request.context.anchor;
    setPos({
      x: Math.max(EDGE, Math.min(anchor.x, vw - w - EDGE)),
      y: Math.max(EDGE, Math.min(anchor.y, vh - h - EDGE)),
    });
  }, [request, flatRows.length]);

  const run = (row: Row): void => {
    if (!provider || !row.enabled) return;
    provider.run({ owner: row.owner, id: row.id });
  };

  const move = (delta: number): void => {
    if (flatRows.length === 0) return;
    const actionable = flatRows.map((r) => r.enabled);
    let next = active;
    for (let step = 0; step < flatRows.length; step++) {
      next = (next + delta + flatRows.length) % flatRows.length;
      if (actionable[next]) break;
    }
    setActive(next);
    panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-menu-item]")[next]?.focus();
  };

  const error = provider?.lastError() ?? null;

  if (!request || flatRows.length === 0) return null;

  let cursor = -1;
  return (
    <Portal>
      <div
        ref={panelRef}
        role="menu"
        aria-label="右键操作"
        tabIndex={-1}
        data-testid="context-menu"
        style={{
          position: "fixed",
          left: pos.x,
          top: pos.y,
          width: PANEL_WIDTH,
          zIndex: 300,
          animation: `fm-menu-in ${MENU_MS}ms ease-out`,
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            move(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            move(-1);
          } else if (e.key === "Home") {
            e.preventDefault();
            setActive(0);
          }
        }}
      >
        <Paper
          withBorder
          shadow="sm"
          radius="xs"
          style={{ background: "var(--mantine-color-body)", padding: 4 }}
        >
          <Stack gap={0}>
            {groups.map((group, gi) => (
              <div key={group[0]?.group || `g${gi}`}>
                {gi > 0 && (
                  <div
                    aria-hidden="true"
                    style={{
                      height: 1,
                      margin: "4px 8px",
                      background: "var(--mantine-color-gray-3)",
                    }}
                  />
                )}
                {group.map((row) => {
                  cursor += 1;
                  const busy = executing?.id === row.id;
                  return (
                    <button
                      key={`${row.owner}/${row.id}`}
                      type="button"
                      role="menuitem"
                      data-menu-item=""
                      data-testid={`context-menu-item-${row.id}`}
                      disabled={!row.enabled}
                      aria-disabled={!row.enabled}
                      onMouseEnter={() => {
                        setActive(cursor);
                      }}
                      onClick={() => run(row)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 8,
                        width: "100%",
                        padding: "6px 10px",
                        fontSize: 13,
                        textAlign: "left",
                        color: row.enabled ? "inherit" : "var(--mantine-color-dimmed)",
                        background:
                          cursor === active && row.enabled
                            ? "var(--mantine-color-gray-1)"
                            : "transparent",
                        cursor: row.enabled ? "pointer" : "not-allowed",
                      }}
                    >
                      <span>{row.label}</span>
                      {busy ? (
                        <Loader size={12} />
                      ) : row.shortcut ? (
                        <Text size="xs" c="dimmed" inline>
                          {row.shortcut}
                        </Text>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
            {error && (
              <Group gap={6} px={10} py={4}>
                <Text size="xs" c="red" inline>
                  {error.message}
                </Text>
              </Group>
            )}
          </Stack>
        </Paper>
      </div>
      <style>{`@keyframes fm-menu-in { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }`}</style>
    </Portal>
  );
}

/** Re-exported for contributors' editor convenience; ids stay plugin-owned. */
export type { ContextMenuItemDescriptor };
