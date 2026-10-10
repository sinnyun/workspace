/**
 * Cascading meta-state (roadmap P6-44, docs/01 §9.2, docs/02 §4.2/§6.4).
 *
 * The base holds ONE cascade snapshot per browsing session (top tab):
 * `{activeSidebarView, sidebarSelection, focusRef, activeDetailTab}` — opaque
 * `Ref`s only, never business data (red line 2). Switching a session restores the
 * whole group, which is what keeps "切会话不混乱".
 *
 * The bus is the SINGLE write path: the base's own UI and plugins both publish the
 * §6.4 coordination events (`host.emit` for plugins is manifest-gated), and this
 * store is the only consumer that applies them. So there is no second way to mutate
 * meta-state, and every applier is idempotent (no echo-driven re-renders).
 */

import type {
  DetailTabChangedArgs,
  HostMetaState,
  Ref,
  SidebarViewChangedArgs,
  TabActivatedArgs,
} from "@my-file-manager/plugin-sdk";
import { Events } from "@my-file-manager/plugin-sdk";
import { create } from "zustand";
import { bus } from "./eventbus";

/** One session's cascade snapshot (`activeTabId` is the session itself). */
export interface CascadeSnapshot {
  activeSidebarView: string;
  sidebarSelection: Ref | null;
  focusRef: Ref | null;
  activeDetailTab: string;
}

const EMPTY_SNAPSHOT: CascadeSnapshot = {
  activeSidebarView: "",
  sidebarSelection: null,
  focusRef: null,
  activeDetailTab: "",
};

interface MetaStore {
  /** Session ids in tab order. */
  tabs: string[];
  activeTabId: string;
  snapshots: Record<string, CascadeSnapshot>;
  /** Base-owned session container actions (tab strip). */
  createTab: () => string;
  closeTab: (tabId: string) => void;
}

let tabSeq = 0;
const nextTabId = (): string => `tab-${++tabSeq}`;

const refEq = (a: Ref | null, b: Ref | null): boolean =>
  a === b || (!!a && !!b && a.kind === b.kind && a.id === b.id && a.sourcePlugin === b.sourcePlugin);

export const useMeta = create<MetaStore>((set, get) => {
  const first = nextTabId();
  return {
    tabs: [first],
    activeTabId: first,
    snapshots: { [first]: { ...EMPTY_SNAPSHOT } },

    createTab: () => {
      const id = nextTabId();
      set((s) => ({
        tabs: [...s.tabs, id],
        snapshots: { ...s.snapshots, [id]: { ...EMPTY_SNAPSHOT } },
      }));
      bus.emit(Events.tabActivated, { tabId: id } satisfies TabActivatedArgs);
      return id;
    },

    closeTab: (tabId) => {
      const s = get();
      if (s.tabs.length <= 1) return; // always keep one session alive
      const idx = s.tabs.indexOf(tabId);
      if (idx < 0) return;
      const tabs = s.tabs.filter((t) => t !== tabId);
      const snapshots = { ...s.snapshots };
      delete snapshots[tabId];
      set({ tabs, snapshots });
      // Restore the cascade of a neighbour, never leave the shell without a session.
      const next = s.activeTabId === tabId ? tabs[Math.min(idx, tabs.length - 1)] : s.activeTabId;
      if (next !== s.activeTabId) bus.emit(Events.tabActivated, { tabId: next } satisfies TabActivatedArgs);
    },
  };
});

/** Patch the ACTIVE session's snapshot; returns whether anything really changed. */
function patchActive(patch: Partial<CascadeSnapshot>): boolean {
  const s = useMeta.getState();
  const cur = s.snapshots[s.activeTabId];
  if (!cur) return false;
  const changed = (Object.keys(patch) as Array<keyof CascadeSnapshot>).some((k) =>
    k === "sidebarSelection" || k === "focusRef"
      ? !refEq(cur[k], patch[k] as CascadeSnapshot[typeof k])
      : cur[k] !== patch[k],
  );
  if (!changed) return false;
  useMeta.setState({
    snapshots: { ...s.snapshots, [s.activeTabId]: { ...cur, ...patch } },
  });
  return true;
}

function applyTabActivated(tabId: string): void {
  const s = useMeta.getState();
  if (!(tabId in s.snapshots)) {
    console.warn(`[meta] tab:activated for unknown session "${tabId}" — ignored`);
    return;
  }
  if (s.activeTabId === tabId) return;
  useMeta.setState({ activeTabId: tabId });
}

let wired = false;

/** Wire the §6.4 coordination events into the store. Called once at bootstrap,
 *  before plugins activate, so no early emission is lost. Idempotent. */
export function initCascadeBus(): void {
  if (wired) return;
  wired = true;

  bus.on<TabActivatedArgs>(Events.tabActivated, (p) => applyTabActivated(p.tabId));
  bus.on<SidebarViewChangedArgs>(Events.sidebarViewChanged, (p) => patchActive({ activeSidebarView: p.viewId }));
  bus.on<Ref | null>(Events.sidebarSelectionChanged, (p) => patchActive({ sidebarSelection: p ?? null }));
  bus.on<Ref | null>(Events.focusChanged, (p) => {
    const ref = p ?? null;
    if (!patchActive({ focusRef: ref })) return;
    // Compat broadcast (docs/02 §6.4): `selection:changed` is the file subset of
    // `focus:changed`, kept so file-oriented plugins keep working unchanged.
    bus.emit(Events.selectionChanged, { fileId: ref?.kind === "file" ? ref.id : null });
  });
  bus.on<DetailTabChangedArgs>(Events.detailTabChanged, (p) => patchActive({ activeDetailTab: p.tabId }));
}

// Only the base's own session container publishes through the bus directly;
// plugins reach the same events through their gated host.emit.
export const activateTab = (tabId: string): void => bus.emit(Events.tabActivated, { tabId } satisfies TabActivatedArgs);

/** Snapshot for PluginHost.getState() — the active session's cascade, flattened. */
export function metaSnapshot(): HostMetaState {
  const { activeTabId, snapshots } = useMeta.getState();
  const snap = snapshots[activeTabId] ?? EMPTY_SNAPSHOT;
  return { activeTabId, ...snap };
}
