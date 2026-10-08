/**
 * file-nav frontend plugin entry (docs/02 §4). The panel is a NAMED export
 * mounted by the base into `nav-zone`. `activate` is required by the contract;
 * this plugin needs no imperative setup.
 */
import type { PluginHost } from "@my-file-manager/plugin-sdk";
import { QuickNavPanel } from "./QuickNavPanel";

export function activate(_host: PluginHost): void {
  // Components are mounted by the base via named exports; nothing to do here.
}

export { QuickNavPanel };
