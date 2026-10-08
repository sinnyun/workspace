/**
 * Constructs the per-plugin PluginHost. This is the enforcement point for the
 * frontend permission model (docs/02 §8): a plugin may only invoke capabilities,
 * subscribe/emit events and inject/provide slots that its manifest allows.
 * Everything else rejects or is ignored with a warning.
 *
 * The host also owns the plugin's slot registrations and subscriptions so a
 * single `dispose()` tears them all down on unload (docs/02 §4.3).
 */
import type { ComponentType } from "react";
import type {
  PluginHost,
  PluginManifest,
  SlotOutletProps,
  SlotProps,
} from "@my-file-manager/plugin-sdk";
import { matchesPermission, slotPrefix } from "@my-file-manager/plugin-sdk";
import { bus } from "./eventbus";
import { metaSnapshot, useMeta } from "./state";
import { invokeCapability } from "./invoke";
import { slotRegistry } from "./slots";
import { makeSlotOutlet } from "./PluginSlot";

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
  const contributePatterns = manifest.permissions?.slots?.contribute ?? [];
  const provides = manifest.frontend?.provides ?? [];
  /** Outlet identity cache: one component instance per provided slot id. */
  const outlets = new Map<string, ComponentType<SlotOutletProps>>();

  const deny = (what: string): void =>
    console.warn(`[host:${manifest.name}] ${what} denied (not in manifest permissions)`);

  const contributes = manifest.frontend?.slots ?? [];
  /** The label this plugin declared for a slot id, if any — looked up from its own
   *  manifest so the declarative and imperative paths carry the same metadata. */
  const declaredLabel = (slotId: string): string | undefined =>
    contributes.find((s) => s.id === slotId)?.label;

  const inject = (
    slotId: string,
    component: ComponentType<SlotProps>,
    source: string,
  ): (() => void) => {
    if (!matchesPermission(slotId, contributePatterns)) {
      deny(`${source} into "${slotId}" (add it to permissions.slots.contribute)`);
      return () => {};
    }
    const off = slotRegistry.add({
      plugin: manifest.name,
      slotId,
      component,
      host,
      label: declaredLabel(slotId),
    });
    teardowns.push(off);
    onSlotChange();
    return () => {
      off();
      onSlotChange();
    };
  };

  const host: PluginHost = {
    name: manifest.name,

    registerSlot(slotId: string, component: ComponentType<SlotProps>) {
      if (!slotRegistry.isBaseSlot(slotId)) {
        console.warn(
          `[host:${manifest.name}] registerSlot("${slotId}") is for base outer slots; ` +
            `use contributeToSlot for nested slots`,
        );
        return () => {};
      }
      return inject(slotId, component, "registerSlot");
    },

    contributeToSlot(slotId: string, component: ComponentType<SlotProps>) {
      return inject(slotId, component, "contributeToSlot");
    },

    provideSlot(id: string): ComponentType<SlotOutletProps> {
      const cached = outlets.get(id);
      if (cached) return cached;
      if (!matchesPermission(slotPrefix(id), provides)) {
        deny(`provideSlot("${id}") (prefix "${slotPrefix(id)}" not in frontend.provides)`);
        return () => null;
      }
      const outlet = makeSlotOutlet(manifest.name, id);
      outlets.set(id, outlet);
      return outlet;
    },

    contributedSlots(prefix?: string) {
      return slotRegistry.contributedSlots(prefix);
    },

    providedSlots(prefix?: string) {
      return slotRegistry.providedSlots(prefix);
    },

    slotLabel(slotId: string) {
      return slotRegistry.labelOf(slotId);
    },

    onSlotsChange(cb: () => void) {
      const off = slotRegistry.subscribe(cb);
      teardowns.push(off);
      return off;
    },

    on<T>(event: string, handler: (payload: T) => void) {
      if (!matchesPermission(event, subEvents)) {
        console.warn(
          `[host:${manifest.name}] subscribe to "${event}" denied (not in permissions.events.subscribe)`,
        );
        return () => {};
      }
      const off = bus.on(event, handler);
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
      const off = useMeta.subscribe(() => cb(metaSnapshot()));
      teardowns.push(off);
      return off;
    },
  };

  return { host, teardowns };
}
