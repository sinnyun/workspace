/**
 * @my-file-manager/plugin-sdk — the ONLY package a frontend plugin may depend on.
 *
 * Types + stateless helpers. Anything needing access to base internals comes
 * through the injected {@link PluginHost}, never from this package, so the SDK
 * never couples to a base version (docs/03 §5, docs/02 §4).
 *
 * Event names and payload shapes mirror the Rust `fm-contracts` crate; a
 * contract test (P3-3) keeps the two sides in sync.
 *
 * Also the shared display layer: the size/date formatters every plugin must
 * agree on live here, so a plugin never writes its own. Both libraries are
 * inlined into the one `shared/plugin-sdk.js` the import map gives everyone.
 */

import dayjs from "dayjs";
import prettyBytes from "pretty-bytes";
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
  invoke<T = unknown>(capability: string, args?: Record<string, unknown>): Promise<T>;

  // —— meta state (read-only) ——
  getState(): HostMetaState;
  /** Subscribe to meta-state changes. Returns an unsubscribe function. */
  onStateChange(cb: (s: HostMetaState) => void): () => void;

  // —— context menu (gated by manifest permissions.contextMenu) ——
  /** Present only when the manifest asks for it; `permissions.contextMenu`
   *  decides which halves a plugin gets (docs/plugin-functional/
   *  plugin-context-menu.md). */
  contextMenu?: ContextMenuHost;

  // —— commands (gated by manifest permissions.commands) ——
  /** Present only when the manifest asks for it; `permissions.commands`
   *  decides which halves a plugin gets (docs/04 P7-30). */
  commands?: CommandHost;
}

// ─────────────────────────── context menu ───────────────────────────

/** What the caller was pointing at when it asked for a menu. Short-lived,
 *  in-memory only: it never reaches the meta state, storage or the bus, and it
 *  carries opaque {@link Ref}s rather than file records (docs/plugin-functional/
 *  plugin-context-menu.md). */
export interface ContextMenuContext {
  /** Stable address of the surface that was clicked, e.g. `browser.list.item`. */
  surfaceId: string;
  /** `kind` of the target, or null when the surface has nothing addressable.
   *  An empty-space context MAY name the containing folder (`browser.empty` →
   *  the directory being listed) — that is how a "新建文件夹"-style action gets
   *  its target without the base holding a "current directory" of its own. */
  targetKind: string | null;
  /** The single target of the request, or null. Same rule as `targetKind`. */
  targetRef: Ref | null;
  /** The effective selection: the target plus its multi-select siblings. */
  selectedRefs: Ref[];
  /** Session (tab) the request belongs to; a stale session's menu must close. */
  sessionId: string;
  /** Pane the request came from, when the surface lives inside one. */
  paneId?: string;
  /** Anchor in CSS pixels, viewport-relative. */
  anchor: { x: number; y: number };
  trigger: "pointer" | "keyboard";
}

/** One menu action, owned and executed by the plugin that registers it. The
 *  framework plugin only draws and filters it — it never learns the business
 *  meaning of `execute`. */
export interface ContextMenuItemDescriptor {
  /** Stable id, unique app-wide; prefix it with your plugin name. */
  id: string;
  /** Display text (Chinese) shown in the panel. */
  label: string;
  /** Group heading to render this item under; items group, then sort by `order`. */
  group?: string;
  /** Ascending position inside its group. Default 0. */
  order?: number;
  /** Keyboard hint shown verbatim on the row, e.g. `F2`. */
  shortcut?: string;
  /** Whether this item applies to the context. Absent means "always". */
  when?(context: ContextMenuContext): boolean;
  /** Whether the item is actionable right now; false draws it disabled. */
  enabled?(context: ContextMenuContext): boolean;
  /** Close the panel when the action starts. Default true. */
  closeOnExecute?: boolean;
  /** Run the action. `signal` aborts if the plugin is disabled mid-flight;
   *  implementations must use their own capabilities and stay quiet on abort. */
  execute(context: ContextMenuContext, signal: AbortSignal): void | Promise<void>;
}

/** The context-menu face of the host, gated by `permissions.contextMenu`.
 *  Exactly one plugin may be the provider (the framework plugin); the base
 *  enforces that, so a menu cannot be hijacked by a second claimant. */
export interface ContextMenuHost {
  /** Provider only: take ownership of the panel. The base rejects a second
   *  provider and warns. */
  provide(): ContextMenuProvider | null;
  /** Register one action. Returns an unregister handle; the base also drops it
   *  automatically when the plugin unloads. */
  registerItem(descriptor: ContextMenuItemDescriptor): () => void;
  /** Ask the provider to show the menu for this context. No-op when nobody
   *  provides a panel or the surface is not whitelisted. */
  open(context: ContextMenuContext): void;
}

/** What the provider plugin gets from the base: the live item list and the
 *  current open request. The provider draws and filters; the base runs the
 *  action, tracks busy state and aborts it when the owning plugin unloads —
 *  so no panel has to re-implement the lifecycle (docs/09 §2.1). */
export interface ContextMenuProvider {
  /** The pending request, or null when no menu is open. */
  current(): ContextMenuRequest | null;
  /** Every registered item with the owning plugin name, in registration order. */
  items(): Array<{ owner: string; descriptor: ContextMenuItemDescriptor }>;
  /** Fires on a new open request, on close, on busy/error transitions, and
   *  whenever the item set changes. */
  onChange(cb: () => void): () => void;
  /** Close the panel (user dismissed it, or the action took it down). */
  close(): void;
  /** Run one action. The base marks it busy, blocks re-entry, catches failures
   *  into `lastError()`, and honours the descriptor's `closeOnExecute`. */
  run(target: { owner: string; id: string }): void;
  /** The action currently running, or null. */
  executing(): { owner: string; id: string } | null;
  /** The last action failure, cleared when a new menu opens. */
  lastError(): { id: string; message: string } | null;
}

/** One open request: the context plus the cancel signal a late action checks. */
export interface ContextMenuRequest {
  /** Monotonic id; a stale request must never repaint the current one. */
  seq: number;
  context: ContextMenuContext;
}

// ─────────────────────────── commands ───────────────────────────

/** One command a plugin publishes to the command surfaces (docs/04 P7-30).
 *  The owning plugin runs it; the base only routes invocation and owns the
 *  keyboard shortcut, so a command's business meaning stays private. */
export interface CommandDescriptor {
  /** Stable id, unique app-wide; prefix it with your plugin name. */
  id: string;
  /** Display text (Chinese) shown on the palette row. */
  title: string;
  /** Group heading the palette renders the command under. */
  group?: string;
  /** Secondary line, e.g. what the command acts on. */
  subtitle?: string;
  /** Keyboard shortcut the BASE dispatches, canonical form `Ctrl+Shift+P`:
   *  `+`-separated modifiers (ctrl/alt/shift/meta, any order) plus one letter
   *  or digit. Duplicates and malformed strings refuse the whole registration —
   *  a silently never-firing shortcut is worse than a loud refusal at load. */
  shortcut?: string;
  /** Run the command. A rejection surfaces verbatim on the invoking surface —
   *  the palette shows it in place and stays open. */
  run(): void | Promise<void>;
}

/** The command face of the host, gated by `permissions.commands`. Exactly one
 *  plugin may be the provider (the palette plugin) — same rule as the
 *  context-menu panel, so the palette cannot be hijacked by a second claimant. */
export interface CommandHost {
  /** Provider only: take ownership of the palette. The base rejects a second
   *  provider and warns. */
  provide(): CommandLauncher | null;
  /** Register one command. Returns an unregister handle; the base also drops
   *  it automatically when the plugin unloads or is disabled. */
  register(descriptor: CommandDescriptor): () => void;
}

/** What the provider plugin gets from the base: the live command list plus a
 *  `run` that owns busy state and failure capture, so no palette has to
 *  re-implement the lifecycle (mirrors {@link ContextMenuProvider}). */
export interface CommandLauncher {
  /** Every registered command with the owning plugin name, in registration order. */
  commands(): Array<{ owner: string; descriptor: CommandDescriptor }>;
  /** Fires whenever the command set changes (register, unregister, unload). */
  onChange(cb: () => void): () => void;
  /** Run one command. Resolves `true` when it completed and `false` when it was
   *  refused (unknown id, another command still running) or threw — in both
   *  failure cases {@link CommandLauncher.lastError} carries what to show. */
  run(target: { owner: string; id: string }): Promise<boolean>;
  /** The command currently running, or null. */
  executing(): { owner: string; id: string } | null;
  /** The last command failure, cleared when a new run starts. */
  lastError(): { id: string; message: string } | null;
}

// ─────────────────────────── activate entry ───────────────────────────

/** A frontend plugin entry must export `activate`. Called once on load; if it
 *  returns a function, that is the teardown hook run on disable/unload. */
export type ActivateFn = (host: PluginHost) => undefined | (() => void);

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
    /** Context-menu grants (docs/plugin-functional/plugin-context-menu.md).
     *  Absent entirely = no menu access; `host.contextMenu` stays undefined.
     *  - `open`: surface ids this plugin may request a menu for.
     *  - `contribute`: may register menu items (their `execute` runs as this plugin).
     *  - `provide`: may claim the panel itself — the framework plugin. The base
     *    lets exactly one provider win, first come first served. */
    contextMenu?: {
      open?: string[];
      contribute?: boolean;
      provide?: boolean;
    };
    /** Command grants (docs/04 P7-30). Absent entirely = no command access;
     *  `host.commands` stays undefined.
     *  - `register`: may publish commands (their `run` executes as this plugin)
     *    and declare shortcuts the base dispatches.
     *  - `provide`: may claim the palette itself — the palette plugin. The base
     *    lets exactly one provider win, first come first served. */
    commands?: {
      register?: boolean;
      provide?: boolean;
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

/** The 12 states the unified preview zone can be in (docs/plugin-functional/
 *  plugin-preview.md). `idle` is "not started", which is a different thing from
 *  `loading`; the failure states stay separate so the UI can name the actual
 *  boundary instead of collapsing everything into "无法预览". */
export type PreviewState =
  | "idle"
  | "checking"
  | "loading"
  | "ready"
  | "unsupported"
  | "too-large"
  | "permission-denied"
  | "not-found"
  | "corrupt"
  | "password-required"
  | "cancelled"
  | "error";

/** `preview:state:changed` — the preview zone's own mode/state, for any panel
 *  that wants to show what is being previewed. Carries the opaque ref only:
 *  never file bytes, never a Blob, never an extra path. */
export interface PreviewStateChangedArgs {
  ref: Ref | null;
  mode: "thumbnail" | "viewer";
  state: PreviewState;
  /** The kind being rendered, once known — `null` while checking or with no focus. */
  format: FileKind | null;
  /** 0..1 while the resource channel is pulling chunks; `null` otherwise. */
  progress: number | null;
}

/** `tags:updated` — the tag owner (`plugin-view-tags`) finished a successful
 *  write to the `db.tags` store. Carries **no payload** by design: re-broadcasting
 *  the store would be a second copy of shared state that can go stale; consumers
 *  re-query through {@link listTags} instead. Frontend bus only (no Rust
 *  counterpart). */
export type TagsUpdatedArgs = undefined;

/** Well-known event names (single source for string literals). */
export const Events = {
  fileChanged: "file:changed",
  historyUpdated: "history:updated",
  tagsUpdated: "tags:updated",
  shellOperationProgress: "shell:operation:progress",
  shellOperationDone: "shell:operation:done",
  scanProgress: "scan:progress",
  scanDone: "scan:done",
  searchIndexProgress: "search:index-progress",
  searchIndexDone: "search:index-done",
  selectionChanged: "selection:changed",
  tabActivated: "tab:activated",
  sidebarViewChanged: "sidebar:view:changed",
  sidebarSelectionChanged: "sidebar:selection:changed",
  focusChanged: "focus:changed",
  detailTabChanged: "detail:tab:changed",
  previewStateChanged: "preview:state:changed",
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

/** Why a text read is not simply "the file's contents". */
export type TextReadState = "ok" | "too-large" | "binary";

/** `fs.readText` answer. A large or binary file is a **state**, so the panel can
 *  say why in Chinese instead of showing garbage (roadmap P7-19). */
export interface ReadTextOut {
  path: string;
  state: TextReadState;
  /** Decoded body; null unless `state === "ok"`. */
  text: string | null;
  /** Encoding actually used, normalised to an encoding_rs name (`UTF-8`, `GBK`,
   *  `windows-1252`, `UTF-16LE`, …); null with no text. */
  encoding: string | null;
  byteLength: number;
}

/** Largest body `fs.readText` returns. Mirrors `MAX_TEXT_READ_BYTES` (Rust). */
export const MAX_TEXT_READ_BYTES = 4 * 1024 * 1024;

/** Largest decoded slice one `fs.readResource` answer carries. Mirrors
 *  `MAX_RESOURCE_CHUNK_BYTES` (Rust) — a viewer loops over chunks, it never
 *  receives a whole file in one message. */
export const MAX_RESOURCE_CHUNK_BYTES = 512 * 1024;

/** How long an untouched resource handle stays valid. Mirrors `RESOURCE_TTL_MS`
 *  (Rust); the normal path is still an explicit `fs.closeResource`. */
export const RESOURCE_TTL_MS = 5 * 60 * 1000;

/** The largest file a preview will assemble. Mirrors `MAX_PREVIEW_BYTES` (Rust):
 *  past it the panel reports 文件过大 instead of paging a huge file into the
 *  WebView. */
export const MAX_PREVIEW_BYTES = 64 * 1024 * 1024;

/** `fs.openResource` input: one path, bound at open time. */
export interface ResourceIn {
  path: string;
}

/** `fs.openResource` answer. `handle` is an opaque token — not a URL, not a
 *  path, and useless to anyone who did not just ask for it. */
export interface ResourceOut {
  handle: string;
  path: string;
  byteLength: number;
  mime: string | null;
  expiresMs: number;
}

/** `fs.readResource` input. `length` is clamped to the chunk ceiling rather than
 *  rejected. */
export interface ReadResourceIn {
  handle: string;
  offset: number;
  length: number;
  /** A newer request for the same handle drops this answer, which is how a fast
   *  viewer cancels a read it no longer wants. */
  requestToken?: string | null;
}

/** `fs.readResource` answer. `data` is standard-alphabet base64 of the slice. */
export interface ReadResourceOut {
  handle: string;
  offset: number;
  data: string;
  total: number;
  eof: boolean;
  requestToken?: string | null;
}

/** Decode a resource chunk into bytes. Lives in the SDK so base64 handling stays
 *  in one place behind the contract instead of in every viewer. */
export function decodeResourceChunk(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** How hard the host may try when Windows has no cached thumbnail.
 *  `cacheOnly` = `WTS_INCACHEONLY` (never extract); `extract` lets the Shell run
 *  the registered handler, which is also what fills the system cache. */
export type ThumbnailPolicy = "cacheOnly" | "extract";

/** Why there is (or is not) a picture. A miss is a **normal answer**, not a
 *  failure, so it travels in the value rather than as a rejected call — the UI
 *  maps each one to its own Chinese text and to the type-icon fallback. */
export type ThumbnailState =
  | "ready"
  | "cache-miss"
  | "unsupported-platform"
  | "unsupported-type"
  | "denied"
  | "missing"
  | "timeout"
  | "cancelled"
  | "error";

/** `shell.thumbnail.read` result: the **Windows Shell's own** thumbnail, as a
 *  `data:` URL ready for `<img src>`. The app never decodes, draws or downscales
 *  the original file (docs/plugin-functional/plugin-windows-thumbnails.md). */
export interface ShellThumbnailOut {
  state: ThumbnailState;
  /** `data:image/png;base64,…` only when `state === "ready"`. */
  dataUrl: string | null;
  mime: string | null;
  /** Longest edge actually returned, in pixels (0 with no image). */
  edge: number;
  /** True when the picture came straight out of the system cache. */
  fromCache: boolean;
}

export type HashAlgo = "blake3" | "sha256";

// ───────────────────── shell file operations (P7-16) ─────────────────────
// The app never copies, moves, renames or deletes by itself: `IFileOperation`
// does (docs/plugin-functional/plugin-file-ops.md). These are only the question
// we hand the Shell and the answer it gives back.

/** What the Shell is asked to do with the selected items. */
export type FileOperationKind = "copy" | "move" | "rename" | "create" | "delete";

/** How a collision still standing when the Shell runs is resolved. `fail` (the
 *  default) never overwrites something the user has not agreed to lose. */
export type FileConflictPolicy = "fail" | "rename" | "overwrite";

/** Transient states come through `shell:operation:progress`; only the last four
 *  are terminal and arrive on `shell:operation:done`. */
export type FileOperationState =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "partial-failure"
  | "failed"
  | "cancelled";

/** Per-item verdict. `renamed` is its own value because the landing path differs
 *  from the one the user asked for. */
export type FileItemOutcome = "completed" | "renamed" | "skipped" | "failed" | "cancelled";

/** Stable reason categories, so the UI maps text instead of parsing Shell strings. */
export type FileFailureReason =
  | "not-found"
  | "denied"
  | "exists"
  | "read-only"
  | "disk-full"
  | "cancelled-by-shell"
  | "unsupported"
  | "other";

/** `shell.fileOperation` arguments. The call only queues the work. */
export interface FileOperationIn {
  op: FileOperationKind;
  /** Every selected source; `rename`/`create` take exactly one. */
  sources: string[];
  /** Target directory for copy/move. */
  destination?: string | null;
  /** New name for rename/create — a name, never a path. */
  newName?: string | null;
  /** Delete goes to the recycle bin unless explicitly false (回收站默认). */
  toRecycleBin: boolean;
  conflict: FileConflictPolicy;
  /** Echoed on every event so a late answer from an operation the UI already
   *  dropped can be recognised and ignored. */
  requestToken?: string | null;
}

/** `shell.fileOperation` ack. */
export interface FileOperationOut {
  operationId: string;
  state: FileOperationState;
  total: number;
  /** The Shell gives us no trustworthy percentage, so this is true by
   *  construction: show indeterminate progress, never a fabricated number. */
  indeterminate: boolean;
}

/** `shell:operation:progress` payload. */
export interface FileOperationProgress {
  operationId: string;
  state: FileOperationState;
  requestToken?: string | null;
  processed: number;
  total: number;
  indeterminate: boolean;
  currentName?: string | null;
}

/** One item inside a terminal result. */
export interface FileOperationItem {
  source: string;
  destination?: string | null;
  outcome: FileItemOutcome;
  reason?: FileFailureReason | null;
  /** The Shell's own message: for a details/copy affordance, never for logic. */
  message?: string | null;
}

/** `shell:operation:done` payload — the only place the truth lands. */
export interface FileOperationResult {
  operationId: string;
  state: FileOperationState;
  requestToken?: string | null;
  items: FileOperationItem[];
  /** A cross-volume move was done by the Shell as copy + delete. It succeeded,
   *  and the user is owed the distinction. */
  crossVolumeMove: boolean;
}

/** `shell.pickFile` / `shell.pickDirectory` arguments. */
export interface PickIn {
  title?: string | null;
  initialDir?: string | null;
  filters?: PickFilter[];
  multiple: boolean;
}

/** One named filter group in an open dialog. */
export interface PickFilter {
  description: string;
  /** Globs, e.g. `*.txt`. */
  patterns: string[];
}

/** A picker answer — cancelling is a normal outcome, not an error. */
export interface PickOut {
  paths: string[];
  cancelled: boolean;
}

/** What a path *is*: one category the whole app branches on (icon, previewer
 *  dispatch, whether an action applies at all). */
export type FileKind =
  | "directory"
  | "text"
  | "code"
  | "markdown"
  | "image"
  | "vector"
  | "video"
  | "audio"
  | "container"
  | "pdf"
  | "archive"
  | "document"
  | "sheet"
  | "presentation"
  | "font"
  | "executable"
  | "model"
  | "unknown";

/** `file.kind` result. */
export interface FileKindOut {
  path: string;
  kind: FileKind;
  /** Lowercase extension without the dot; `""` when there is none. */
  extension: string;
  mime: string | null;
}

// ─────────────────── disk / scan channel (P7-23) ───────────────────
// Storage analysis never walks the filesystem in the WebView: the kernel does it
// on background threads and reports through events. The wire carries byte totals
// and stable reason codes — no percentages, no prose.

/** How deep the delivered tree goes. Deeper directories still contribute their
 *  bytes to the aggregate but arrive as `childCount` instead of children. Mirrors
 *  `SCAN_TREE_DEPTH` (Rust). */
export const SCAN_TREE_DEPTH = 2;

/** Entry ceiling for one scan; past it the remaining directories are reported in
 *  `skipped` as `budget-exceeded`. Mirrors `SCAN_MAX_ENTRIES` (Rust). */
export const SCAN_MAX_ENTRIES = 120000;

/** Hard ceiling on recursion depth. Mirrors `SCAN_MAX_DEPTH` (Rust). */
export const SCAN_MAX_DEPTH = 128;

/** Minimum gap between two `scan:progress` emissions. Mirrors
 *  `SCAN_PROGRESS_INTERVAL_MS` (Rust). */
export const SCAN_PROGRESS_INTERVAL_MS = 80;

/** `sys.disk.list` arguments. The path only decides which volume comes back
 *  first; every visible volume is listed either way. */
export interface DiskListIn {
  path: string;
}

/** One volume's space accounting. Bytes, never percentages. */
export interface DiskVolume {
  /** Mount point / root path as the platform names it (`C:\\`, `/data`). */
  rootPath: string;
  label: string;
  filesystem: string;
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
}

/** `sys.disk.list` answer. */
export interface DiskListOut {
  path: string;
  volumes: DiskVolume[];
}

/** Where a scan is. `queued` is the answer to `sys.scan.start` itself. */
export type ScanState = "queued" | "running" | "completed" | "cancelled" | "failed";

/** `sys.scan.start` arguments. */
export interface ScanIn {
  rootPath: string;
}

/** `sys.scan.start` answer: an id and nothing else. The truth is in the events. */
export interface ScanAck {
  scanId: string;
  state: ScanState;
  rootPath: string;
}

/** Why a directory did not contribute to the aggregate. A stable code, not prose
 *  (same division as `FileFailureReason`). */
export type ScanSkipReason =
  | "not-found"
  | "denied"
  | "invalid-argument"
  | "read-failed"
  | "budget-exceeded"
  | "too-deep"
  | "symlink-skipped"
  | "not-a-directory";

/** One skipped path plus its reason code. */
export interface ScanSkipped {
  path: string;
  reason: ScanSkipReason;
}

/** One node of the delivered aggregate tree. `bytes` is a **subtree total** for a
 *  directory and a file size for a file, so a consumer can rank children of any
 *  level without a second pass. `kinds` splits those bytes by lower-case
 *  extension (no dot). */
export interface ScanNode {
  name: string;
  path: string;
  isDir: boolean;
  bytes: number;
  /** Present on a directory deeper than `SCAN_TREE_DEPTH`: the number of
   *  immediate children, which are *not* in this payload. */
  childCount?: number | null;
  children?: ScanNode[] | null;
  kinds?: Record<string, number> | null;
}

/** `scan:progress` payload — counters only, never a percentage. */
export interface ScanProgressPayload {
  scanId: string;
  /** Directory currently being listed; a display hint, not a cursor. */
  path: string;
  entries: number;
  bytes: number;
  skipped: ScanSkipped[];
  state: ScanState;
}

/** `scan:done` payload. Terminal, and the only place the full tree lands. */
export interface ScanDonePayload {
  scanId: string;
  tree: ScanNode;
  skipped: ScanSkipped[];
  /** `true` → the tree is **partial**: do not present it as a complete
   *  accounting, and do not cache it. */
  cancelled: boolean;
  /** Set when children were cut at this depth. */
  truncatedAtDepth?: number | null;
  elapsedMs: number;
  entries: number;
}

// ─────────────────────────── search channel (P7-28 / P7-29) ───────────────────────────
// The name index lives in its own rebuildable SQLite file and is served by four
// capabilities: read state, query one page, start a job, stop a job. Results are
// paged request/response (`offset` + `hasMore`), so there is no result event —
// the roadmap's `search:results` name was folded into `search.query`.

/** Longest query text the host looks at; longer input is truncated. Mirrors
 *  `SEARCH_MAX_TEXT_CHARS` (Rust). */
export const SEARCH_MAX_TEXT_CHARS = 128;

/** Biggest page one `search.query` may return. Mirrors `SEARCH_MAX_PAGE` (Rust). */
export const SEARCH_MAX_PAGE = 200;

/** Queries shorter than this cannot be answered from the trigram index, so the
 *  host uses a bounded substring scan instead. Mirrors `SEARCH_TRIGRAM_MIN_CHARS`
 *  (Rust). */
export const SEARCH_TRIGRAM_MIN_CHARS = 3;

/** Minimum gap between two `search:index-progress` emissions. Mirrors
 *  `SEARCH_PROGRESS_INTERVAL_MS` (Rust). */
export const SEARCH_PROGRESS_INTERVAL_MS = 120;

/** Deepest directory level the indexer walks. Mirrors `SEARCH_INDEX_MAX_DEPTH`
 *  (Rust): deeper rows are never written, so dev and host index the same set. */
export const SEARCH_INDEX_MAX_DEPTH = 64;

/** What hits are filtered to. Mirrors `SearchScope` (Rust). */
export type SearchScope = "all" | "file" | "dir";

/** Index lifecycle. No percentage on purpose: the entry ceiling means the total
 *  is unknown up front. Mirrors `SearchIndexState` (Rust). */
export type SearchIndexState = "empty" | "indexing" | "ready" | "partial" | "failed";

/** `search.query` arguments. Only `text` is required, so the command palette can
 *  send `{ text }` and get relevance-ordered hits. */
export interface SearchQueryIn {
  text: string;
  /** Only hits inside this directory subtree; omitted = every indexed root. */
  within?: string | null;
  scope?: SearchScope;
  /** Clamped to `SEARCH_MAX_PAGE`. */
  limit?: number | null;
  /** Rows to skip, i.e. the cursor for the next page. */
  offset?: number;
}

/** One hit. There is no `score`: the order the host returns **is** the ranking. */
export interface SearchHit {
  path: string;
  name: string;
  /** Directory the name lives in, so the row can show context without a second
   *  round trip. */
  parent: string;
  isDir: boolean;
  /** `null` for directories, matching `ListEntry.size`. */
  size?: number | null;
  /** `null` for directories too: a hit must read exactly like the listing row. */
  modifiedMs?: number | null;
}

/** `search.query` answer: one page plus enough state to explain itself. */
export interface SearchQueryOut {
  /** The text actually searched, after clamping/truncation. */
  text: string;
  scope: SearchScope;
  tookMs: number;
  /** Matches the index knows about for this query, not just this page. */
  total: number;
  offset: number;
  hasMore: boolean;
  hits: SearchHit[];
  /** The index's own state, so a page can tell "还没有索引" from "没有匹配" from
   *  "索引不完整". Never derived from how many rows this page found. */
  state: SearchIndexState;
}

/** `search.status` answer. */
export interface SearchStatusOut {
  state: SearchIndexState;
  entries: number;
  roots: string[];
  /** Wall-clock length of the last job that reached a terminal state. */
  lastJobMs: number;
  /** Chinese, provider-authored reason for `partial`/`failed`. */
  detail?: string | null;
}

/** `search.index.start` arguments. */
export interface SearchIndexIn {
  /** Absolute directories to walk. Empty = the host's default roots. */
  roots?: string[];
  /** `true` → drop and rebuild; `false` → bring up to date. */
  rebuild?: boolean;
}

/** `search.index.start` answer: an id and the roots it accepted. Progress is in
 *  the events, exactly like `sys.scan.start`. */
export interface SearchIndexAck {
  jobId: string;
  roots: string[];
  state: SearchIndexState;
}

/** `search:index-progress` payload — counters only, never a percentage. */
export interface SearchIndexProgressPayload {
  jobId: string;
  state: SearchIndexState;
  entries: number;
  /** Directory currently being listed; a display hint, not a cursor. */
  currentPath: string;
  elapsedMs: number;
}

/** `search:index-done` payload. Terminal, and separate from progress so a
 *  cancelled job cannot be inferred from a missing tick. */
export interface SearchIndexDonePayload {
  jobId: string;
  state: SearchIndexState;
  entries: number;
  roots: string[];
  elapsedMs: number;
  /** `true` → the index is **partial**: "no results" is not "no matches". */
  cancelled: boolean;
  detail?: string | null;
}

// ─────────────────────── tags store (P7-32, docs/04) ───────────────────────
// The tags store lives in the generic `db` capability as store `tags` — a kv
// row per tag, key = name, value = the JSON record below. That keeps the store
// schema-free on the Rust side: the owner (`plugin-view-tags`) owns the meaning
// of its rows, everyone else reads them through the shapes here (docs/09 §3.4).

/** One member of a tag. `kind` is the same opaque string a `Ref` carries
 *  (`folder` / `file` / a viewer's own kind). Paths stay verbatim — on a
 *  case-sensitive drive two spellings may be two different files. A path
 *  appears at most once per tag: the kind is a refreshed property, not part
 *  of a member's identity. */
export interface TagMember {
  path: string;
  kind: string;
}

/** One tag as stored: `db.tags` kv key = name, value = this record. `seq` is the
 *  creation order — kv rows would otherwise come back sorted by name, and
 *  re-ranking names on rename is not what "creation order" means. */
export interface TagRecord {
  name: string;
  seq: number;
  members: TagMember[];
}

/** Parse raw `db.tags.list` kv rows (`[key, value]` tuples) into records. This is
 *  the read boundary of shared state: junk rows and malformed members are dropped
 *  rather than coerced, a duplicate path inside one tag collapses to its first
 *  entry, and the result is ordered by `seq` (name as tie-break) so every consumer
 *  sees the same order. */
export function parseTagRows(rows: unknown): TagRecord[] {
  if (!Array.isArray(rows)) return [];
  const out: TagRecord[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const rawName = row[0];
    const rawValue = row[1];
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name || !rawValue || typeof rawValue !== "object") continue;
    const rec = rawValue as Record<string, unknown>;
    const seq = typeof rec.seq === "number" && Number.isFinite(rec.seq) ? rec.seq : 0;
    const members: TagMember[] = [];
    const seen = new Set<string>();
    if (Array.isArray(rec.members)) {
      for (const item of rec.members) {
        if (!item || typeof item !== "object") continue;
        const m = item as Record<string, unknown>;
        const path = typeof m.path === "string" ? m.path : "";
        const kind = typeof m.kind === "string" ? m.kind : "";
        if (!path || !kind || seen.has(path)) continue;
        seen.add(path);
        members.push({ path, kind });
      }
    }
    out.push({ name, seq, members });
  }
  out.sort((a, b) => a.seq - b.seq || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

/** The single read path every tag consumer goes through (chips, tag views,
 *  command palette): one keyless `db.tags.list` round trip. The caller's manifest
 *  must list `db.tags.list` in `permissions.capabilities`. */
export async function listTags(host: PluginHost): Promise<TagRecord[]> {
  return parseTagRows(await host.invoke<unknown>("db.tags.list", {}));
}

/** Well-known capability names. Mirrors `fm_contracts::capability::names` (Rust);
 *  the contract test (P3-3) asserts the two sets are identical. */
export const Capabilities = {
  fsHome: "fs.home",
  fsList: "fs.list",
  fsStat: "fs.stat",
  fsReadChunk: "fs.readChunk",
  fsReadText: "fs.readText",
  fsOpenResource: "fs.openResource",
  fsReadResource: "fs.readResource",
  fsCloseResource: "fs.closeResource",
  hashCompute: "hash.compute",
  shellThumbnailRead: "shell.thumbnail.read",
  shellFileOperation: "shell.fileOperation",
  shellCancelFileOperation: "shell.cancelFileOperation",
  shellOpenPath: "shell.openPath",
  shellRevealItem: "shell.revealItemInDir",
  shellPickFile: "shell.pickFile",
  shellPickDirectory: "shell.pickDirectory",
  fileKind: "file.kind",
  sysDiskList: "sys.disk.list",
  sysScanStart: "sys.scan.start",
  sysScanCancel: "sys.scan.cancel",
  searchQuery: "search.query",
  searchStatus: "search.status",
  searchIndexStart: "search.index.start",
  searchIndexCancel: "search.index.cancel",
  watchSubscribe: "watch.subscribe",
} as const;

/** Capabilities the **frontend base itself** serves — no Rust counterpart, so
 *  (like the frontend-only events above) they stay out of `contract:check`.
 *  Plugin enable/disable is base loader state, not a kernel concern: the base
 *  answers these names in-process, still gated by `permissions.capabilities`. */
export const FrontendCapabilities = {
  pluginsList: "plugins.list",
  pluginsSetEnabled: "plugins.setEnabled",
  clipboardWrite: "clipboard.write",
} as const;

/** `clipboard.write` arguments. The base writes the system clipboard from the
 *  WebView, so no Rust counterpart exists (same class as `plugins.list`). */
export interface ClipboardWriteArgs {
  text: string;
}

/** One row of `plugins.list` — what the settings panel renders as a switch. */
export interface PluginInfo {
  name: string;
  displayName?: string;
  version: string;
  description?: string;
  enabled: boolean;
  /** Base-core plugin (region containers, the settings panel itself): switching
   *  it off would remove the shell's own geometry, so the base refuses and the
   *  UI shows it locked. The base decides — a manifest cannot grant itself
   *  immunity. */
  protected: boolean;
}

/** `plugins.setEnabled` arguments. */
export interface PluginSetEnabledArgs {
  name: string;
  enabled: boolean;
}

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
  if (!m.name?.trim()) return "name must be non-empty";
  if (!m.version?.trim()) return "version must be non-empty";
  if (!m.backend && !m.frontend) return "manifest declares neither backend nor frontend";
  if (m.frontend) {
    if (!m.frontend.entry?.trim()) return "frontend.entry must be non-empty";
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
  for (const surface of m.permissions?.contextMenu?.open ?? []) {
    if (!surface?.trim()) return `permissions.contextMenu.open in plugin \`${m.name}\` has empty entry`;
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

// ───────────────────── display formatting (docs/06 P6-21) ─────────────────────

/** What a cell shows when there is no value to format. */
const NO_VALUE = "—";

const isMs = (ms: number | null | undefined): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms > 0;

/**
 * The one size format the whole app uses: binary math with `KiB/MiB/…` labels,
 * at most one decimal. Four plugins each had their own `formatSize`, which is
 * how the same file ended up as `3.4 KB` here and `3.42 KB` there.
 */
export function formatSize(bytes: number | null | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return NO_VALUE;
  return prettyBytes(bytes, { binary: true, maximumFractionDigits: 1 });
}

/** `2026-10-27` — a date only, for dense columns. */
export function formatDate(ms: number | null | undefined, fallback = ""): string {
  return isMs(ms) ? dayjs(ms).format("YYYY-MM-DD") : fallback;
}

/** `2026-10-27 11:33` — local time, minute resolution. */
export function formatDateTime(ms: number | null | undefined, fallback = NO_VALUE): string {
  return isMs(ms) ? dayjs(ms).format("YYYY-MM-DD HH:mm") : fallback;
}

/** `11:33:05` — time of day only, for cache timestamps and log rows. */
export function formatClock(ms: number | null | undefined, fallback = NO_VALUE): string {
  return isMs(ms) ? dayjs(ms).format("HH:mm:ss") : fallback;
}
