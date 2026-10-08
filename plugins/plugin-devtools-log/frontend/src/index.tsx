/**
 * devtools-log plugin entry (docs/02 §4).
 *
 * `activate` installs the runtime capture (console / errors / perf / events) and
 * returns its teardown so unload restores globals. `LogPanel` is a named export
 * the base mounts into `bottom-drawer`. This plugin must be listed FIRST in the
 * dev plugin index so its global hooks are in place before other plugins load.
 */
import type { PluginHost } from "@my-file-manager/plugin-sdk";
import { install } from "./capture";
import { LogPanel } from "./LogPanel";

export function activate(host: PluginHost): () => void {
  return install(host);
}

export { LogPanel };
