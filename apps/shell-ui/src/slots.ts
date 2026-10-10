/**
 * Slot runtime (roadmap P6-45, docs/02 §4.5).
 *
 * Two kinds of render target:
 *  - **base outer slots** (`BASE_SLOT_IDS`, docs/08 §2) — always available, the
 *    base's region grid renders them;
 *  - **nested slots** (`<prefix>:<instance>`, e.g. `pane-slot:0`) — provided at
 *    runtime by a container plugin, via the outlet component it gets from
 *    `host.provideSlot`.
 *
 * Every registration carries the **contributing plugin's own gated host**, so
 * rendering an outlet can never hand a plugin the ungated base host (docs/02 §4.3:
 * a plugin touches the world only through its own host).
 *
 * Slot lifecycle on the bus (docs/02 §4.5): an outlet mounting broadcasts
 * `slot:registered`, unmounting broadcasts `slot:disposed`. Contributions are NOT
 * force-dropped on dispose — the outlet is gone so nothing renders, and each plugin
 * owns its own unsubscribe (a plugin that wants to leave on dispose subscribes to
 * `slot:disposed`). This keeps dev StrictMode mount/unmount cycles lossless.
 */

import { BASE_SLOT_IDS, Events, type PluginHost, type SlotProps, slotPrefix } from "@my-file-manager/plugin-sdk";
import type { ComponentType } from "react";
import { bus } from "./eventbus";

export interface SlotRegistration {
  plugin: string;
  slotId: string;
  component: ComponentType<SlotProps>;
  /** The contributing plugin's permission-gated host. */
  host: PluginHost;
  /** Display label from the contributor's manifest (`frontend.slots[].label`). */
  label?: string;
  /** Registry-assigned monotonic id. Slots render with this as the React key, so
   *  unregistering one contribution never remounts its siblings — with index-based
   *  keys the siblings shift and lose their state (an open settings popover, a
   *  half-typed rename) just because another plugin was switched off. */
  seq: number;
}

class SlotRegistry {
  private bySlot = new Map<string, SlotRegistration[]>();
  /** Live nested slots: slotId -> providing plugin. */
  private providers = new Map<string, string>();
  private listeners = new Set<() => void>();
  private version = 0;
  private seqCounter = 0;

  isBaseSlot(slotId: string): boolean {
    return (BASE_SLOT_IDS as readonly string[]).includes(slotId);
  }

  /** Which plugin currently provides this nested slot (undefined for base slots). */
  providerOf(slotId: string): string | undefined {
    return this.providers.get(slotId);
  }

  get(slotId: string): SlotRegistration[] {
    return this.bySlot.get(slotId) ?? [];
  }

  /** Display label declared by a contributor for this slot id (first one that
   *  has one). Containers use it to label tabs in the contributor's own words. */
  labelOf(slotId: string): string | undefined {
    for (const reg of this.bySlot.get(slotId) ?? []) {
      if (reg.label) return reg.label;
    }
    return undefined;
  }

  /** Slot ids that currently hold content, in first-registration order. Containers
   *  use this (via `host.contributedSlots`) to build tab strips from what content
   *  plugins actually injected — addresses only, never components or data. */
  contributedSlots(prefix?: string): string[] {
    const out: string[] = [];
    for (const [slotId, regs] of this.bySlot) {
      if (regs.length === 0) continue;
      if (prefix !== undefined && slotPrefix(slotId) !== prefix) continue;
      out.push(slotId);
    }
    return out;
  }

  /** Nested slot ids whose outlet is currently mounted, optionally by prefix. */
  providedSlots(prefix?: string): string[] {
    const out: string[] = [];
    for (const slotId of this.providers.keys()) {
      if (prefix !== undefined && slotPrefix(slotId) !== prefix) continue;
      out.push(slotId);
    }
    return out;
  }

  /** Add one contribution. Returns the unsubscribe used by host teardowns. */
  add(reg: Omit<SlotRegistration, "seq">): () => void {
    const stored: SlotRegistration = { ...reg, seq: ++this.seqCounter };
    const list = this.bySlot.get(stored.slotId) ?? [];
    list.push(stored);
    this.bySlot.set(stored.slotId, list);
    this.bump();
    return () => {
      const cur = this.bySlot.get(stored.slotId);
      if (!cur) return;
      const idx = cur.indexOf(stored);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) this.bySlot.delete(stored.slotId);
      this.bump();
    };
  }

  /** A container outlet mounted: the nested slot now exists for contributors. */
  provide(plugin: string, slotId: string): void {
    if (this.providers.get(slotId) === plugin) return;
    this.providers.set(slotId, plugin);
    this.bump();
    bus.emit(Events.slotRegistered, { slotId });
  }

  /** The outlet unmounted: the nested slot is gone. */
  unprovide(plugin: string, slotId: string): void {
    if (this.providers.get(slotId) !== plugin) return;
    this.providers.delete(slotId);
    this.bump();
    bus.emit(Events.slotDisposed, { slotId });
  }

  /** Whole-plugin unload: drop its contributions and its provided outlets. */
  releasePlugin(plugin: string): void {
    for (const [slotId, regs] of [...this.bySlot]) {
      const kept = regs.filter((r) => r.plugin !== plugin);
      if (kept.length === regs.length) continue;
      if (kept.length === 0) this.bySlot.delete(slotId);
      else this.bySlot.set(slotId, kept);
      this.bump();
    }
    for (const [slotId, provider] of [...this.providers]) {
      if (provider === plugin) this.unprovide(plugin, slotId);
    }
  }

  getVersion(): number {
    return this.version;
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private bump(): void {
    this.version++;
    for (const cb of this.listeners) cb();
  }
}

export const slotRegistry = new SlotRegistry();
