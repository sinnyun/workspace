/**
 * @my-file-manager/plugin-sdk — the ONLY package a frontend plugin may depend on.
 *
 * Types + stateless helpers. Anything needing access to base internals comes
 * through the injected {@link PluginHost}, never from this package, so the SDK
 * never couples to a base version (docs/03 §5, docs/02 §4).
 *
 * Event names and payload shapes mirror the Rust `fm-contracts` crate; a
 * contract test (P3-3) keeps the two sides in sync.
 */

import type { ComponentType } from "react";

// ─────────────────────────── host meta state ───────────────────────────

/** An opaque cross-region reference. The base carries these and never
 *  interprets `kind`: the plugins that publish/consume a kind own its meaning
 *  (docs/01 §9.2). `sourcePlugin` is `"base"` for references the shell itself
 *  publishes (e.g. its transitional file browser). */
export interface Ref {
  kind: string;
  id: string;
  sourcePlugin: string;
}

/** The cascading selection state of ONE browsing session (tab). Read-only for
 *  plugins: write it by emitting the §6.4 coordination events, never by hand.
 *  The base holds no business state (red line 2) — only these references.
 *
 *  Cascade: activeSidebarView(A) → sidebarSelection(B) → focusRef(C) → activeDetailTab(D).
 */
export interface HostMetaState {
  /** Top session container: which browsing session is active. */
  activeTabId: string;
  /** A activity rail: which sidebar view B currently shows. */
  activeSidebarView: string;
  /** B sidebar: the selected item, drives C. */
  sidebarSelection: Ref | null;
  /** C main view: last interacted object, drives D. */
  focusRef: Ref | null;
  /** D detail container: which tab is open. */
  activeDetailTab: string;
}

// ─────────────────────────── slot props ───────────────────────────

/** Props handed to every component mounted into a slot. `slotId` tells the
 *  component which region it is rendering into, so one component can be
 *  contributed to several slots. */
export interface SlotProps {
  host: PluginHost;
  slotId: string;
}

/** Props of the outlet component returned by {@link PluginHost.provideSlot}. */
export interface SlotOutletProps {
  id: string;
}

/** Base-reserved outer region slots (docs/08 §2). Contributing here needs no
 *  nested-slot prefix, but still must be listed in
 *  `permissions.slots.contribute`. */
export const BaseSlots = {
  activityRail: "activity-rail-zone",
  topbar: "topbar-zone",
  nav: "nav-zone",
  mainView: "main-view-zone",
  fileSidebar: "file-sidebar-zone",
  statusbar: "statusbar-zone",
  bottomDrawer: "bottom-drawer",
  commandPalette: "command-palette",
} as const;

/** Every base outer slot id, in layout order. The loader validates manifest
 *  slot targets against this set. */
export const BASE_SLOT_IDS: readonly string[] = Object.values(BaseSlots);

// ─────────────────────────── plugin host ───────────────────────────

/** The base-injected capability surface. A plugin touches the outside world
 *  ONLY through this object (docs/02 §4.2). */
export interface PluginHost {
  /** The plugin's own manifest name — the value a `Ref.sourcePlugin` should carry
   *  when this plugin publishes a reference (docs/01 §9.2). */
  readonly name: string;

  // —— UI: inject into a base outer slot (frozen since v1) ——
  /** Mount a component into a named slot. Returns an unmount function. */
  registerSlot(slotId: string, component: ComponentType<SlotProps>): () => void;

  // —— UI: nested slots (containers provide, content plugins inject) ——
  /** Container plugin only: declare one outlet, e.g. `pane-slot:0`. The prefix
   *  must be listed in manifest `frontend.provides` (docs/02 §8). Returns an
   *  outlet component that renders whatever OTHER plugins contributed to that
   *  id; mounting it broadcasts `slot:registered`, unmounting `slot:disposed`.
   *  Idempotent per id: asking twice yields the same outlet. */
  provideSlot(id: string): ComponentType<SlotOutletProps>;
  /** Inject into any slot (base outer or another plugin's nested slot). The
   *  target prefix must be listed in `permissions.slots.contribute`. */
  contributeToSlot(id: string, component: ComponentType<SlotProps>): () => void;

  // —— UI: runtime introspection for container plugins ——
  /** Slot ids under `prefix` that currently hold at least one contribution, e.g.
   *  `contributedSlots("detail-tab")` -> `["detail-tab:history"]`. A container uses
   *  it to build its tab strip / pane menu from what content plugins actually
   *  injected; it reveals slot **addresses only**, never a component or data.
   *  Call without a prefix to list every slot with content. */
  contributedSlots(prefix?: string): string[];
  /** Live nested slot ids under `prefix` (a container's mounted outlets), e.g.
   *  `providedSlots("pane-slot")` -> `["pane-slot:0","pane-slot:1"]`. A content
   *  plugin uses it to inject into panes that already exist, then follows
   *  `slot:registered` / `slot:disposed` for later changes. */
  providedSlots(prefix?: string): string[];
  /** The display label a contributor declared for one slot id (manifest
   *  `frontend.slots[].label`), e.g. `slotLabel("detail-tab:history")` -> `"版本"`.
   *  Containers use it to label tab strips in the contributor's own words instead
   *  of raw slot ids. Undefined when nobody declared one. Address-level metadata:
   *  it exposes no component and no data, so it needs no permission. */
  slotLabel(slotId: string): string | undefined;
  /** Subscribe to slot registry changes (outlet mounted/disposed, content
   *  registered or removed). Returns an unsubscribe. Pairs with
   *  {@link PluginHost.contributedSlots} / {@link PluginHost.providedSlots}. */
  onSlotsChange(cb: () => void): () => void;

  // —— events (frontend bus, including bridged backend events) ——
  /** Subscribe to an event. Returns an unsubscribe function. */
  on<T = unknown>(event: string, handler: (payload: T) => void): () => void;
  /** Emit on the frontend bus. Stays frontend-local unless a capability is invoked. */
  emit(event: string, payload?: unknown): void;

  // —— capabilities (gated by manifest permissions.capabilities) ——
  /** Invoke an atomic capability by `domain.action` name. Rejects if not whitelisted. */
  invoke<T = unknown>(
    capability: string,
    args?: Record<string, unknown>,
  ): Promise<T>;

  // —— meta state (read-only) ——
  getState(): HostMetaState;
  /** Subscribe to meta-state changes. Returns an unsubscribe function. */
  onStateChange(cb: (s: HostMetaState) => void): () => void;
}

// ─────────────────────────── activate entry ───────────────────────────

/** A frontend plugin entry must export `activate`. Called once on load; if it
 *  returns a function, that is the teardown hook run on disable/unload. */
export type ActivateFn = (host: PluginHost) => void | (() => void);

/** Shape of a loaded frontend plugin ESM module. */
export interface PluginModule {
  activate: ActivateFn;
  /** Named component exports declared in manifest `frontend.slots[].export`. */
  [componentName: string]: unknown;
}

// ─────────────────────────── manifest ───────────────────────────

/** manifest.json (docs/02 §2). Mirrored on the Rust side for backend loading. */
export interface PluginManifest {
  schemaVersion: number;
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  author?: string;
  minHostVersion?: string;
  backend?: {
    crate: string;
    enabledByDefault?: boolean;
    config?: Record<string, unknown>;
  };
  frontend?: {
    entry: string;
    slots?: Array<{
      id: string;
      export: string;
      /** Display name containers should use for this slot (e.g. a tab title). */
      label?: string;
    }>;
    /** Container plugins only: nested-slot prefixes this plugin provides
     *  (e.g. `["pane-slot"]`). Ordinary plugins omit it (docs/02 §4.5). */
    provides?: string[];
  };
  permissions: {
    capabilities: string[];
    events: {
      subscribe: string[];
      emit: string[];
    };
    /** Slot-injection whitelist. `contribute` lists slot ids or `prefix:*`
     *  patterns this plugin may inject into — including nested slots owned by
     *  other plugins, which must be authorised explicitly (docs/02 §2.2). */
    slots?: {
      contribute?: string[];
    };
  };
}

// ─────────────────────────── event payloads ───────────────────────────
// Keep in lockstep with fm-contracts::events (Rust).

/** `file:changed` — emitted by the watch capability. */
export interface FileChangedArgs {
  path: string;
  /** create / modify / remove / ... */
  kind: string;
}

/** `history:updated` — emitted by the file-history backend plugin. */
export interface HistoryUpdatedArgs {
  path: string;
}

/** `selection:changed` — emitted by the frontend base on meta-state change.
 *  Kept for compatibility: it is the file subset of `focus:changed`. */
export interface SelectionChangedArgs {
  fileId: string | null;
}

// Cascade coordination + nested-slot events. FRONTEND BUS ONLY: they never cross
// IPC, so they have no Rust counterpart and are excluded from `contract:check`
// (docs/02 §6.4, §7.1).

/** `tab:activated` — the base switched browsing sessions; whole snapshot restored. */
export interface TabActivatedArgs {
  tabId: string;
}

/** `sidebar:view:changed` — A activity rail picked another sidebar view. */
export interface SidebarViewChangedArgs {
  viewId: string;
}

/** `detail:tab:changed` — D detail container switched its active tab. */
export interface DetailTabChangedArgs {
  tabId: string;
}

/** `sidebar:selection:changed` — B selection, drives C. */
export type SidebarSelectionChangedArgs = Ref | null;

/** `focus:changed` — last interacted object in C, drives D. */
export type FocusChangedArgs = Ref | null;

/** `slot:registered` — a container outlet mounted; content plugins may inject. */
export interface SlotRegisteredArgs {
  slotId: string;
}

/** `slot:reconfigured` — panes/tabs added or removed by the container. */
export interface SlotReconfiguredArgs {
  slotId: string;
  action: "add" | "remove";
}

/** `slot:disposed` — the outlet unmounted; contributors must leave cleanly. */
export interface SlotDisposedArgs {
  slotId: string;
}

/** Well-known event names (single source for string literals). */
export const Events = {
  fileChanged: "file:changed",
  historyUpdated: "history:updated",
  selectionChanged: "selection:changed",
  tabActivated: "tab:activated",
  sidebarViewChanged: "sidebar:view:changed",
  sidebarSelectionChanged: "sidebar:selection:changed",
  focusChanged: "focus:changed",
  detailTabChanged: "detail:tab:changed",
  slotRegistered: "slot:registered",
  slotReconfigured: "slot:reconfigured",
  slotDisposed: "slot:disposed",
} as const;

// ─────────────────────────── capability DTOs ───────────────────────────
// Keep in lockstep with fm-contracts::capability (Rust).

export interface ListEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
  /** Unix epoch millis of last modification; null for directories and whenever
   *  the provider cannot read an mtime. Lets a list show the column without one
   *  `fs.stat` per row. */
  modifiedMs: number | null;
}

export interface StatOut {
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number | null;
}

/** `thumb.image` result: a downscaled image as a `data:` URL, so the plugin can
 *  drop it straight into `<img src>`. `edge` is the longest edge actually
 *  produced (<= the requested one). */
export interface ThumbOut {
  dataUrl: string;
  mime: string;
  edge: number;
}

export type HashAlgo = "blake3" | "sha256";

/** Well-known capability names. Mirrors `fm_contracts::capability::names` (Rust);
 *  the contract test (P3-3) asserts the two sets are identical. */
export const Capabilities = {
  fsHome: "fs.home",
  fsList: "fs.list",
  fsStat: "fs.stat",
  fsReadChunk: "fs.readChunk",
  fsReadText: "fs.readText",
  hashCompute: "hash.compute",
  thumbImage: "thumb.image",
  watchSubscribe: "watch.subscribe",
} as const;

// ─────────────────────────── stateless helpers ───────────────────────────

/** Manifest schema version the host accepts. Mirrors
 *  `fm_contracts::manifest::SCHEMA_VERSION` (Rust). */
export const MANIFEST_SCHEMA_VERSION = 1;

/** Semantic manifest checks the type system cannot express. Mirrors
 *  `PluginManifest::validate` (Rust) so both sides reject the same plugins.
 *  Returns the first violation, or null when valid. */
export function validateManifest(m: PluginManifest): string | null {
  if (m.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return `unsupported schemaVersion ${m.schemaVersion} (host accepts ${MANIFEST_SCHEMA_VERSION})`;
  }
  if (!m.name || !m.name.trim()) return "name must be non-empty";
  if (!m.version || !m.version.trim()) return "version must be non-empty";
  if (!m.backend && !m.frontend) return "manifest declares neither backend nor frontend";
  if (m.frontend) {
    if (!m.frontend.entry || !m.frontend.entry.trim()) return "frontend.entry must be non-empty";
    for (const slot of m.frontend.slots ?? []) {
      if (!slot.id?.trim() || !slot.export?.trim()) {
        return `slot in plugin \`${m.name}\` has empty id/export`;
      }
      if (slot.label !== undefined && !slot.label.trim()) {
        return `slot in plugin \`${m.name}\` has empty label`;
      }
    }
    for (const prefix of m.frontend.provides ?? []) {
      if (!prefix?.trim()) return `provides in plugin \`${m.name}\` has empty prefix`;
    }
  }
  for (const pattern of m.permissions?.slots?.contribute ?? []) {
    if (!pattern?.trim()) return `permissions.slots.contribute in plugin \`${m.name}\` has empty entry`;
  }
  return null;
}

/** Match a `domain.action` name (or a slot id) against manifest permission
 *  patterns: a bare `*` matches everything, a trailing `*` is a prefix match,
 *  anything else must match exactly. e.g. `db.history.*` matches
 *  `db.history.list`; `pane-slot:*` matches `pane-slot:2`. Used by the base's
 *  PluginHost to enforce `permissions.capabilities` / `events` / `slots`. */
export function matchesPermission(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith("*")) return name.startsWith(p.slice(0, -1));
    return p === name;
  });
}

/** The prefix of a slot id: `pane-slot:2` -> `pane-slot`, `nav-zone` -> `nav-zone`.
 *  Nested slots are addressed as `<prefix>:<instance>` (docs/03 §6). */
export function slotPrefix(slotId: string): string {
  const idx = slotId.indexOf(":");
  return idx < 0 ? slotId : slotId.slice(0, idx);
}

/** Collect teardown functions and run them all (reverse order), swallowing
 *  per-callback errors so one bad unsubscribe cannot block the rest. */
export function disposer(...fns: Array<() => void>): () => void {
  return () => {
    for (const fn of [...fns].reverse()) {
      try {
        fn();
      } catch {
        // best-effort teardown; the base logs at a higher layer
      }
    }
  };
}

/** A thrown value as display text. `String(err)` on an Error prepends its class
 *  name (`Error: …`), which is not part of what the provider said and must not
 *  reach a Chinese UI; the message alone is what the user should read. */
export function errorMessage(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error:\s*/, "");
}
