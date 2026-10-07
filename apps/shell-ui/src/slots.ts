/**
 * Slot registry: maps slotId -> registered components (from any plugin).
 * Framework-free so <PluginSlot> can read it and the loader/host can write it.
 * A version counter lets React subscribe for re-render on change.
 */
import type { ComponentType } from "react";
import type { SlotProps } from "@my-file-manager/plugin-sdk";

interface Registration {
  plugin: string;
  component: ComponentType<SlotProps>;
}

class SlotRegistry {
  private slots = new Map<string, Registration[]>();
  private listeners = new Set<() => void>();
  private version = 0;

  register(
    plugin: string,
    slotId: string,
    component: ComponentType<SlotProps>,
  ): () => void {
    const list = this.slots.get(slotId) ?? [];
    const reg: Registration = { plugin, component };
    list.push(reg);
    this.slots.set(slotId, list);
    this.bump();
    return () => {
      const cur = this.slots.get(slotId);
      if (!cur) return;
      const idx = cur.indexOf(reg);
      if (idx >= 0) cur.splice(idx, 1);
      if (cur.length === 0) this.slots.delete(slotId);
      this.bump();
    };
  }

  get(slotId: string): Registration[] {
    return this.slots.get(slotId) ?? [];
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
