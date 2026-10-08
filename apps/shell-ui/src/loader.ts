/** Frontend plugin loader + the plugin enable/disable runtime (roadmap P2-4,
 *  nested-slot gating P6-45, plugin management P6-64).
 *
 * Flow: ask the host for the plugin index (manifest list) -> for each frontend
 * plugin the user has not switched off, `import()` its entry over the `plugin://`
 * protocol -> build a permission-gated host -> call `activate(host)` -> mount named
 * slot exports declared in manifest.frontend.slots -> keep a teardown for unload.
 *
 * Mounting a declared slot goes through the plugin's OWN host
 * (`host.contributeToSlot`), so the manifest slot whitelist is enforced for the
 * declarative path exactly as for the imperative one (docs/02 §8), and the
 * rendered component receives its gated host instead of a base host.
 *
 * **This file is the owner of plugin enable/disable**, and the only place that
 * decides which plugins are core: the state is base runtime state (persisted under
 * `fm.plugins.disabled.v1`), the settings panel reaches it through the base-served
 * `plugins.list` / `plugins.setEnabled` capabilities — still gated by each
 * manifest's `permissions.capabilities` like any other capability (docs/01 §6 red
 * line 2: the base holds this runtime fact, no plugin may). Switching a plugin
 * takes effect immediately: disable runs its teardown (which releases its slot
 * contributions and its provided outlets), enable imports and mounts it again.
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
  PluginInfo,
  PluginManifest,
  PluginModule,
  SlotProps,
} from "@my-file-manager/plugin-sdk";
import {
  FrontendCapabilities,
  slotPrefix,
  validateManifest,
} from "@my-file-manager/plugin-sdk";
import { createHost, type LoadedPluginHandle } from "./host";
import { slotRegistry } from "./slots";
import { invokeCapability, registerBaseCapability } from "./invoke";

export interface LoadedPlugin extends LoadedPluginHandle {
  manifest: PluginManifest;
}

/** User-switched-off plugin names, remembered across restarts. */
const DISABLED_KEY = "fm.plugins.disabled.v1";

/** Region containers and the settings panel itself. Without them the shell has no
 *  geometry — or no way back, since the switch lives inside that panel — so the
 *  base refuses to disable them. Base policy, never manifest-supplied: a plugin
 *  cannot grant itself immunity. */
const CORE_PLUGINS = new Set([
  "plugin-layout-panes",
  "plugin-layout-views",
  "plugin-inspector",
  "plugin-settings",
]);

/** Discovered index (all plugins, enabled or not) and the nested-slot prefixes it
 *  provides — computed once, because a disabled container's prefix must still
 *  resolve for the batch. */
let index: PluginManifest[] = [];
let nestedPrefixes: ReadonlySet<string> = new Set();
const handles = new Map<string, LoadedPlugin>();

function readDisabled(): Set<string> {
  try {
    const raw = localStorage.getItem(DISABLED_KEY);
    const names = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(
      Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : [],
    );
  } catch {
    return new Set();
  }
}

let disabled = readDisabled();
let slotsChanged: () => void = () => {};

function persistDisabled(): void {
  try {
    localStorage.setItem(DISABLED_KEY, JSON.stringify([...disabled]));
  } catch {
    // storage unavailable: the switch simply resets next start
  }
}

const isFrontend = (m: PluginManifest): boolean => Boolean(m.frontend?.entry);
const isDisabled = (name: string): boolean => disabled.has(name) && !CORE_PLUGINS.has(name);

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
 *  some manifest in this index provides their prefix (docs/02 §8). */
function targetKnown(slotId: string): boolean {
  return slotRegistry.isBaseSlot(slotId) || nestedPrefixes.has(slotPrefix(slotId));
}

/** Import, activate and mount one plugin. Never throws: a failure is logged and
 *  the plugin is skipped (docs/02 §4.3). Registers its handle so the disable
 *  switch can tear exactly this plugin down. */
async function loadOne(manifest: PluginManifest): Promise<void> {
  // Schema gate first: a malformed manifest is skipped, never fatal (P3-2).
  const invalid = validateManifest(manifest);
  if (invalid) {
    console.error(`[loader] skipping invalid manifest "${manifest.name ?? "?"}": ${invalid}`);
    return;
  }
  try {
    const mod = (await import(/* @vite-ignore */ entryUrl(manifest))) as PluginModule;
    const { host, teardowns } = createHost(manifest, slotsChanged);

    // activate() first; its return (if any) is the teardown hook.
    const activateTeardown = mod.activate?.(host);
    if (typeof activateTeardown === "function") teardowns.push(activateTeardown);

    // Mount named slot exports declared in the manifest, through the plugin's
    // own gated host so permissions.slots.contribute is enforced here too.
    for (const slot of manifest.frontend?.slots ?? []) {
      const comp = mod[slot.export] as ComponentType<SlotProps> | undefined;
      if (!comp) {
        console.warn(`[loader:${manifest.name}] slot export "${slot.export}" missing from entry`);
        continue;
      }
      if (!targetKnown(slot.id)) {
        console.warn(
          `[loader:${manifest.name}] skipping slot "${slot.id}": not a base slot and no ` +
            `plugin in the index provides prefix "${slotPrefix(slot.id)}"`,
        );
        continue;
      }
      host.contributeToSlot(slot.id, comp); // teardown + whitelist handled by the host
    }
    slotsChanged();

    const handle: LoadedPlugin = {
      manifest,
      dispose: () => {
        handles.delete(manifest.name);
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
        slotsChanged();
      },
    };
    handles.set(manifest.name, handle);
    console.info(`[loader] loaded frontend plugin "${manifest.name}"`);
  } catch (err) {
    // Per-plugin isolation: skip and continue.
    console.error(`[loader] failed to load "${manifest.name}":`, err);
  }
}

/** The management list: every frontend plugin in the index, with the base's
 *  verdict on whether it may be switched off. */
function pluginInfos(): PluginInfo[] {
  return index.filter(isFrontend).map((m) => ({
    name: m.name,
    displayName: m.displayName ?? m.name,
    version: m.version,
    description: m.description,
    enabled: !isDisabled(m.name),
    protected: CORE_PLUGINS.has(m.name),
  }));
}

/** Switch one plugin on or off, applying it immediately. Rejects for names the
 *  index does not know and for core plugins — the UI cannot bypass the base by
 *  hiding a switch. Returns the fresh list so the caller stays in sync. */
export async function setPluginEnabled(name: string, enabled: boolean): Promise<PluginInfo[]> {
  const manifest = index.find((m) => m.name === name && isFrontend(m));
  if (!manifest) throw new Error(`未知插件「${name}」`);
  if (CORE_PLUGINS.has(name)) throw new Error("基础插件不可关闭");
  if (enabled) {
    disabled.delete(name);
    if (!handles.has(name)) await loadOne(manifest);
  } else {
    disabled.add(name);
    handles.get(name)?.dispose();
  }
  persistDisabled();
  return pluginInfos();
}

function registerPluginCapabilities(): void {
  registerBaseCapability(FrontendCapabilities.pluginsList, () => pluginInfos());
  registerBaseCapability(FrontendCapabilities.pluginsSetEnabled, (args) =>
    setPluginEnabled(String(args.name ?? ""), Boolean(args.enabled)),
  );
}

export async function loadPlugins(onSlotChange: () => void): Promise<LoadedPlugin[]> {
  slotsChanged = onSlotChange;
  registerPluginCapabilities();
  index = await listPlugins();
  nestedPrefixes = new Set(index.flatMap((m) => m.frontend?.provides ?? []));

  for (const manifest of index) {
    if (!isFrontend(manifest) || isDisabled(manifest.name)) continue;
    await loadOne(manifest);
  }
  return [...handles.values()];
}
