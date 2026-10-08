/** Frontend plugin loader (roadmap P2-4, nested-slot gating P6-45).
 *
 * Flow: ask the host for the plugin index (manifest list) -> for each enabled
 * frontend plugin, `import()` its entry over the `plugin://` protocol -> build a
 * permission-gated host -> call `activate(host)` -> mount named slot exports
 * declared in manifest.frontend.slots -> keep a teardown for unload.
 *
 * Mounting a declared slot goes through the plugin's OWN host
 * (`host.contributeToSlot`), so the manifest slot whitelist is enforced for the
 * declarative path exactly as for the imperative one (docs/02 §8), and the
 * rendered component receives its gated host instead of a base host.
 *
 * Failure is per-plugin isolated: a plugin that throws during import/activate is
 * logged and skipped; its slots degrade to empty and the base keeps running
 * (docs/02 §4.3, roadmap P2-4/P5-1).
 *
 * Outside Tauri (browser dev) `listPlugins` returns [], so the shell runs with
 * no plugins rather than crashing.
 */
import type { ComponentType } from "react";
import type {
  PluginManifest,
  PluginModule,
  SlotProps,
} from "@my-file-manager/plugin-sdk";
import { slotPrefix, validateManifest } from "@my-file-manager/plugin-sdk";
import { createHost, type LoadedPluginHandle } from "./host";
import { slotRegistry } from "./slots";
import { invokeCapability } from "./invoke";

export interface LoadedPlugin extends LoadedPluginHandle {
  manifest: PluginManifest;
}

/** Ask the host for the discovered frontend plugin manifests. Routes through
 *  `invokeCapability` so a browser-dev mock can supply them outside Tauri. */
async function listPlugins(): Promise<PluginManifest[]> {
  try {
    return await invokeCapability<PluginManifest[]>("plugins_list_frontend");
  } catch {
    return [];
  }
}

/** Resolve a plugin entry to an importable URL. Inside Tauri the host serves
 *  plugin files over `plugin://plugin/<name>/<relpath>`; in browser dev a rooted
 *  or absolute URL (e.g. `/dev-plugins/...`) is used verbatim. */
function entryUrl(manifest: PluginManifest): string {
  const entry = manifest.frontend?.entry ?? "frontend/dist/index.js";
  if (entry.startsWith("/") || entry.startsWith("http")) return entry;
  // entry is relative to the plugin root; strip the leading dir convention.
  const rel = entry.replace(/^\.?\//, "");
  return `plugin://plugin/${manifest.name}/${rel}`;
}

/** Does the slot target exist? Base outer slots always do; nested slots exist if
 *  some manifest in this load batch provides their prefix (docs/02 §8). */
function targetKnown(slotId: string, nestedPrefixes: ReadonlySet<string>): boolean {
  return slotRegistry.isBaseSlot(slotId) || nestedPrefixes.has(slotPrefix(slotId));
}

export async function loadPlugins(onSlotChange: () => void): Promise<LoadedPlugin[]> {
  const manifests = await listPlugins();
  const loaded: LoadedPlugin[] = [];
  const nestedPrefixes = new Set<string>(
    manifests.flatMap((m) => m.frontend?.provides ?? []),
  );

  for (const manifest of manifests) {
    // Schema gate first: a malformed manifest is skipped, never fatal (P3-2).
    const invalid = validateManifest(manifest);
    if (invalid) {
      console.error(`[loader] skipping invalid manifest "${manifest.name ?? "?"}": ${invalid}`);
      continue;
    }
    if (!manifest.frontend?.entry) continue; // backend-only plugin
    try {
      const mod = (await import(/* @vite-ignore */ entryUrl(manifest))) as PluginModule;
      const { host, teardowns } = createHost(manifest, onSlotChange);

      // activate() first; its return (if any) is the teardown hook.
      const activateTeardown = mod.activate?.(host);
      if (typeof activateTeardown === "function") teardowns.push(activateTeardown);

      // Mount named slot exports declared in the manifest, through the plugin's
      // own gated host so permissions.slots.contribute is enforced here too.
      for (const slot of manifest.frontend.slots ?? []) {
        const comp = mod[slot.export] as ComponentType<SlotProps> | undefined;
        if (!comp) {
          console.warn(
            `[loader:${manifest.name}] slot export "${slot.export}" missing from entry`,
          );
          continue;
        }
        if (!targetKnown(slot.id, nestedPrefixes)) {
          console.warn(
            `[loader:${manifest.name}] skipping slot "${slot.id}": not a base slot and no ` +
              `plugin in this batch provides prefix "${slotPrefix(slot.id)}"`,
          );
          continue;
        }
        host.contributeToSlot(slot.id, comp); // teardown + whitelist handled by the host
      }
      onSlotChange();

      loaded.push({
        manifest,
        dispose: () => {
          for (const t of [...teardowns].reverse()) {
            try {
              t();
            } catch (err) {
              console.error(`[loader:${manifest.name}] teardown error:`, err);
            }
          }
          // Belt and braces: drop anything this plugin still holds in the runtime
          // (including nested slots whose outlet React never got to unmount).
          slotRegistry.releasePlugin(manifest.name);
          onSlotChange();
        },
      });
      console.info(`[loader] loaded frontend plugin "${manifest.name}"`);
    } catch (err) {
      // Per-plugin isolation: skip and continue.
      console.error(`[loader] failed to load "${manifest.name}":`, err);
    }
  }
  return loaded;
}
