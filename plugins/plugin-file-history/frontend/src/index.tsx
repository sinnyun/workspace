/**
 * file-history frontend plugin entry (docs/02 §4).
 *
 * The component is a NAMED export mounted by the base per manifest
 * `frontend.slots[].export` into `file-sidebar-zone`. `activate` is required by
 * the contract; this plugin needs no imperative setup, so it just returns.
 */
import type { PluginHost } from "@my-file-manager/plugin-sdk";
import { HistoryPanel } from "./HistoryPanel";

export function activate(_host: PluginHost): void {
  // Components are mounted by the base via named exports; nothing to do here.
}

export { HistoryPanel };
