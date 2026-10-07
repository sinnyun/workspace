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

/** Read-only base meta-state. The base holds NO business state (red line 2) —
 *  only cross-plugin UI coordination like the current selection. */
export interface HostMetaState {
  /** Currently selected file path, or null. Drives `selection:changed`. */
  currentFileId: string | null;
}

// ─────────────────────────── slot props ───────────────────────────

/** Props handed to every component mounted into a {@link PluginSlot}. */
export interface SlotProps {
  host: PluginHost;
}

// ─────────────────────────── plugin host ───────────────────────────

/** The base-injected capability surface. A plugin touches the outside world
 *  ONLY through this object (docs/02 §4.2). */
export interface PluginHost {
  // —— UI ——
  /** Mount a component into a named slot. Returns an unmount function. */
  registerSlot(slotId: string, component: ComponentType<SlotProps>): () => void;

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
    slots?: Array<{ id: string; export: string }>;
  };
  permissions: {
    capabilities: string[];
    events: {
      subscribe: string[];
      emit: string[];
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

/** `selection:changed` — emitted by the frontend base on meta-state change. */
export interface SelectionChangedArgs {
  fileId: string | null;
}

/** Well-known event names (single source for string literals). */
export const Events = {
  fileChanged: "file:changed",
  historyUpdated: "history:updated",
  selectionChanged: "selection:changed",
} as const;

// ─────────────────────────── capability DTOs ───────────────────────────
// Keep in lockstep with fm-contracts::capability (Rust).

export interface ListEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number | null;
}

export interface StatOut {
  path: string;
  isDir: boolean;
  size: number;
  modifiedMs: number | null;
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
    }
  }
  return null;
}

/** Match a `domain.action` name against manifest permission patterns, which
 *  support a trailing `.*` (prefix match incl. the dot) and a bare `*` (all).
 *  e.g. `db.history.*` matches `db.history.list`. Used by the base's PluginHost
 *  to enforce `permissions.capabilities` / `permissions.events`. */
export function matchesPermission(name: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === "*") return true;
    if (p.endsWith(".*")) return name.startsWith(p.slice(0, -1));
    return p === name;
  });
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
