/**
 * `clipboard.write` — a capability the frontend base serves itself (like
 * `plugins.list`), so it needs no Rust counterpart and stays out of
 * `contract:check`. Writing the system clipboard is a WebView-side operation;
 * routing it through a capability keeps it behind the same manifest
 * permission gate as every other capability call (docs/02 §8).
 */
import { FrontendCapabilities } from "@my-file-manager/plugin-sdk";
import { registerBaseCapability } from "./invoke";

async function writeText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for webviews without the async clipboard API.
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const copied = document.execCommand("copy");
  area.remove();
  if (!copied) throw new Error("clipboard.write: the browser refused the copy");
}

export function registerClipboardCapability(): void {
  registerBaseCapability(FrontendCapabilities.clipboardWrite, (args) => {
    const text = (args as { text?: unknown }).text;
    if (typeof text !== "string") {
      throw new Error("clipboard.write: `text` must be a string");
    }
    return writeText(text);
  });
}
