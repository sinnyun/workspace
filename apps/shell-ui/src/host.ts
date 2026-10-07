/**
 * Constructs the per-plugin PluginHost. This is the enforcement point for the
 * frontend permission model (docs/02 §8): a plugin may only invoke capabilities
 * and subscribe/emit events listed in its manifest. Everything else rejects or
 * is ignored with a warning.
 *
 * The host also owns the plugin's slot registrations and subscriptions so a
 * single `dispose()` tears them all down on unload (docs/02 §4.3).
 */
import type { ComponentType } from "react";
import type {
  PluginHost,
  PluginManifest,
  SlotProps,
} from "@my-file-manager/plugin-sdk";
import { matchesPermission } from "@my-file-manager/plugin-sdk";
import { bus } from "./eventbus";
import { metaSnapshot, useMeta } from "./state";
import { invokeCapability } from "./invoke";
import { slotRegistry } from "./slots";

export interface LoadedPluginHandle {
  manifest: PluginManifest;
  dispose: () => void;
}

export function createHost(
  manifest: PluginManifest,
  onSlotChange: () => void,
): { host: PluginHost; teardowns: Array<() => void> } {
  const teardowns: Array<() => void> = [];
  const caps = manifest.permissions?.capabilities ?? [];
  const subEvents = manifest.permissions?.events?.subscribe ?? [];
  const emitEvents = manifest.permissions?.events?.emit ?? [];

  const host: PluginHost = {
    registerSlot(slotId: string, component: ComponentType<SlotProps>) {
      const off = slotRegistry.register(manifest.name, slotId, component);
      teardowns.push(off);
      onSlotChange();
      return () => {
        off();
        onSlotChange();
      };
    },

    on<T>(event: string, handler: (payload: T) => void) {
      if (!matchesPermission(event, subEvents)) {
        console.warn(
          `[host:${manifest.name}] subscribe to "${event}" denied (not in permissions.events.subscribe)`,
        );
        return () => {};
      }
      const off = bus.on(event, handler as (p: unknown) => void);
      teardowns.push(off);
      return off;
    },

    emit(event: string, payload?: unknown) {
      if (!matchesPermission(event, emitEvents)) {
        console.warn(
          `[host:${manifest.name}] emit "${event}" denied (not in permissions.events.emit)`,
        );
        return;
      }
      bus.emit(event, payload);
    },

    async invoke<T>(capability: string, args?: Record<string, unknown>) {
      if (!matchesPermission(capability, caps)) {
        throw new Error(
          `capability "${capability}" denied for plugin "${manifest.name}" (not in permissions.capabilities)`,
        );
      }
      return invokeCapability<T>(capability, args);
    },

    getState: () => metaSnapshot(),

    onStateChange(cb) {
      const off = useMeta.subscribe((s) => cb({ currentFileId: s.currentFileId }));
      teardowns.push(off);
      return off;
    },
  };

  return { host, teardowns };
}
