/**
 * Context-menu service (roadmap P7-10, docs/plugin-functional/plugin-context-menu.md).
 *
 * The base owns the *plumbing*; a framework plugin owns the *panel*. Item
 * registration, provider ownership, busy state, failure capture and unload
 * cleanup all live here so the invariants hold structurally instead of relying
 * on every plugin to tidy up after itself:
 *
 *  - exactly one provider may claim the panel (first claim wins, the rest are
 *    rejected — a menu cannot be hijacked by a second claimant);
 *  - item ids are unique app-wide, duplicates are refused;
 *  - disabling or unloading a plugin removes its items, aborts its in-flight
 *    action and closes a menu it opened, with no plugin-side bookkeeping;
 *  - switching session closes a stale menu (the context belongs to the old tab).
 *
 * Nothing here interprets a context: the framework plugin filters `when`/`order`
 * and draws; each contributor's `execute` runs with its own permissions.
 */
import type {
  ContextMenuContext,
  ContextMenuHost,
  ContextMenuItemDescriptor,
  ContextMenuProvider,
  ContextMenuRequest,
  PluginManifest,
} from "@my-file-manager/plugin-sdk";
import { useMeta } from "./state";

interface Registration {
  owner: string;
  descriptor: ContextMenuItemDescriptor;
  /** Aborted when the owning plugin unloads mid-action. */
  controller: AbortController | null;
}

class ContextMenuService {
  private registrations: Registration[] = [];
  private provider: string | null = null;
  private request: ContextMenuRequest | null = null;
  private executing: { owner: string; id: string } | null = null;
  private error: { id: string; message: string } | null = null;
  private listeners = new Set<() => void>();
  private seq = 0;
  private watchingSession = false;

  notify(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        console.error("[context-menu] listener error:", err);
      }
    }
  }

  /** A menu is bound to the session it opened in; a session switch drops it. */
  private watchSessions(): void {
    if (this.watchingSession) return;
    this.watchingSession = true;
    useMeta.subscribe((s) => {
      if (this.request && this.request.context.sessionId !== s.activeTabId) this.close();
    });
  }

  /** Register one action on behalf of `owner`. Rejects a blank or duplicate id. */
  registerItem(owner: string, descriptor: ContextMenuItemDescriptor): () => void {
    const id = descriptor.id?.trim();
    const label = descriptor.label?.trim();
    if (!id || !label) {
      console.warn(`[context-menu:${owner}] item needs a non-empty id and label — refused`);
      return () => {};
    }
    if (this.registrations.some((r) => r.descriptor.id === id)) {
      console.warn(`[context-menu:${owner}] item id "${id}" already registered — refused`);
      return () => {};
    }
    const reg: Registration = { owner, descriptor: { ...descriptor, id, label }, controller: null };
    this.registrations.push(reg);
    this.notify();
    return () => {
      const idx = this.registrations.indexOf(reg);
      if (idx >= 0) this.registrations.splice(idx, 1);
      this.notify();
    };
  }

  private requestOwner: string | null = null;

  /** Claim the panel. Only one plugin ever gets a provider back. */
  claimProvider(owner: string): ContextMenuProvider | null {
    if (this.provider && this.provider !== owner) {
      console.warn(`[context-menu] panel already provided by "${this.provider}" — "${owner}" refused`);
      return null;
    }
    this.provider = owner;
    this.watchSessions();
    const isOwner = (): boolean => this.provider === owner;
    return {
      current: () => (isOwner() ? this.request : null),
      items: () => (isOwner() ? this.registrations.map((r) => ({ owner: r.owner, descriptor: r.descriptor })) : []),
      onChange: (cb) => {
        if (!isOwner()) return () => {};
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
      },
      close: () => {
        if (isOwner()) this.close();
      },
      run: (target) => {
        if (isOwner()) this.run(target.owner, target.id);
      },
      executing: () => (isOwner() ? this.executing : null),
      lastError: () => (isOwner() ? this.error : null),
    };
  }

  releaseProvider(owner: string): void {
    if (this.provider === owner) this.provider = null;
  }

  open(owner: string, context: ContextMenuContext): void {
    if (!this.provider) {
      console.warn(`[context-menu:${owner}] no plugin provides a panel — request dropped`);
      return;
    }
    this.request = { seq: ++this.seq, context };
    this.requestOwner = owner;
    this.error = null;
    this.notify();
  }

  close(): void {
    if (!this.request) return;
    this.request = null;
    this.requestOwner = null;
    this.notify();
  }

  /** Run the owning plugin's action. Busy-flagged, re-entry blocked, failures
   *  captured for the panel to summarise — the panel never has to. */
  run(owner: string, id: string): void {
    const reg = this.registrations.find((r) => r.owner === owner && r.descriptor.id === id);
    const context = this.request?.context;
    if (!reg || !context || this.executing) return;
    if (reg.descriptor.enabled && !reg.descriptor.enabled(context)) return;
    this.executing = { owner, id };
    if (reg.descriptor.closeOnExecute !== false) this.close();
    const controller = new AbortController();
    reg.controller = controller;
    this.notify();
    const done = (err?: unknown): void => {
      reg.controller = null;
      this.executing = null;
      if (err !== undefined) {
        this.error = {
          id,
          message: err instanceof Error ? err.message.replace(/^Error:\s*/, "") : String(err),
        };
        console.error(`[context-menu:${owner}] action "${id}" failed:`, err);
      }
      this.notify();
    };
    try {
      const result = reg.descriptor.execute(context, controller.signal);
      if (result && typeof result.then === "function") {
        result.then(
          () => done(),
          (err) => done(err),
        );
      } else {
        done();
      }
    } catch (err) {
      done(err);
    }
  }

  /** Disable/unload cleanup: items gone, in-flight aborted, menus it opened closed. */
  releasePlugin(owner: string): void {
    for (const reg of this.registrations.filter((r) => r.owner === owner)) {
      reg.controller?.abort();
    }
    this.registrations = this.registrations.filter((r) => r.owner !== owner);
    if (this.provider === owner) this.provider = null;
    if (this.requestOwner === owner) this.close();
    this.notify();
  }
}

export const contextMenuService = new ContextMenuService();

/** Build the gated `host.contextMenu` face for one plugin, or undefined when its
 *  manifest grants none. Every returned handle is also registered in the host's
 *  teardown list, so unloading a plugin cannot leak items or listeners. */
export function createContextMenuHost(
  manifest: PluginManifest,
  teardowns: Array<() => void>,
  warn: (what: string) => void,
): ContextMenuHost | undefined {
  const grant = manifest.permissions?.contextMenu;
  if (!grant) return undefined;
  const surfaces = grant.open ?? [];
  const service = contextMenuService;
  const name = manifest.name;

  const host: ContextMenuHost = {
    provide() {
      if (!grant.provide) {
        warn("contextMenu.provide (permissions.contextMenu.provide not set)");
        return null;
      }
      const provider = service.claimProvider(name);
      if (!provider) return null;
      teardowns.push(() => service.releaseProvider(name));
      return provider;
    },
    registerItem(descriptor) {
      if (!grant.contribute) {
        warn(`contextMenu.registerItem("${descriptor.id}") (permissions.contextMenu.contribute not set)`);
        return () => {};
      }
      const off = service.registerItem(name, descriptor);
      teardowns.push(off);
      return off;
    },
    open(context) {
      if (!grant.open) {
        warn(`contextMenu.open("${context.surfaceId}") (no permissions.contextMenu.open surfaces)`);
        return;
      }
      if (!surfaces.includes(context.surfaceId)) {
        warn(`contextMenu.open("${context.surfaceId}") (surface not in permissions.contextMenu.open)`);
        return;
      }
      service.open(name, context);
    },
  };
  return host;
}
