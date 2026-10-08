/**
 * Frontend event bus. Local pub/sub, plus a bridge that mirrors backend events
 * (emitted from cordis `ctx.emit` -> Tauri `emit`) onto the same bus under the
 * identical `domain:action` name (docs/02 §6.3).
 *
 * The bus is intentionally framework-free so plugins never import it directly;
 * they go through the injected PluginHost, which wraps `on`/`emit` here and
 * enforces the manifest event whitelist.
 */

type Handler = (payload: unknown) => void;

class EventBus {
  private handlers = new Map<string, Set<Handler>>();
  private unlistenTauri: Array<() => void> = [];
  private bridged = false;

  on<T = unknown>(event: string, handler: (payload: T) => void): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const h = handler as Handler;
    set.add(h);
    return () => {
      set!.delete(h);
    };
  }

  emit(event: string, payload?: unknown): void {
    const set = this.handlers.get(event);
    if (!set) return;
    // Copy so a handler that unsubscribes during dispatch cannot skip others.
    for (const h of [...set]) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[eventbus] handler for "${event}" threw:`, err);
      }
    }
  }

  /**
   * Subscribe to backend events forwarded over Tauri and re-broadcast them on
   * the local bus under the same name. Idempotent. No-ops outside Tauri (plain
   * browser dev) so the shell still runs headless.
   */
  async bridgeBackend(events: string[]): Promise<void> {
    if (this.bridged) return;
    this.bridged = true;
    let listen: typeof import("@tauri-apps/api/event").listen;
    try {
      ({ listen } = await import("@tauri-apps/api/event"));
    } catch {
      // Not running inside Tauri (e.g. `vite dev` in a browser): no backend bridge.
      return;
    }
    for (const name of events) {
      try {
        const un = await listen<unknown>(name, (e) => this.emit(name, e.payload));
        this.unlistenTauri.push(un);
      } catch {
        // The module loaded but the Tauri IPC runtime is absent (plain browser):
        // `listen` rejects on `window.__TAURI_INTERNALS__`. Degrade to local-only.
        return;
      }
    }
  }

  dispose(): void {
    for (const un of this.unlistenTauri) un();
    this.unlistenTauri = [];
    this.handlers.clear();
    this.bridged = false;
  }
}

export const bus = new EventBus();
