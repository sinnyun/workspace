/**
 * mock-data dev plugin entry (docs/02 §4). Dev-only: served through the browser
 * mock index (dev-mocks.ts) and pulls data from the `mock.stress` dev capability.
 *
 * Two named exports mount into different regions to showcase per-region styling
 * under large data: `MockControls` (topbar-zone) and `MockStressList` (nav-zone).
 * `activate` is required by the contract; state is held in a module store shared
 * by both panels, so no imperative setup is needed here.
 */
import type { PluginHost } from "@my-file-manager/plugin-sdk";
import { MockControls } from "./MockControls";
import { MockStressList } from "./MockStressList";

export function activate(_host: PluginHost): void {
  // Panels are mounted by the base via named exports; state lives in the store.
}

export { MockControls, MockStressList };
