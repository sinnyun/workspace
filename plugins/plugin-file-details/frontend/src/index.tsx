/**
 * file-details frontend plugin entry (docs/02 §4). The panel is a NAMED export
 * mounted by the base per manifest `frontend.slots[].export` into
 * `file-sidebar-zone`. `activate` is required by the contract; no imperative
 * setup is needed here, so it just returns.
 */
import type { PluginHost } from "@my-file-manager/plugin-sdk";
import { DetailsPanel } from "./DetailsPanel";

export function activate(_host: PluginHost): void {
  // Components are mounted by the base via named exports; nothing to do here.
}

export { DetailsPanel };
