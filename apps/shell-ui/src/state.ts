/**
 * Base meta-state. The base holds NO business state (red line 2) — only
 * cross-plugin UI coordination. Today that is the current selection; when it
 * changes we broadcast `selection:changed` on the bus.
 */
import { create } from "zustand";
import type { HostMetaState } from "@my-file-manager/plugin-sdk";
import { Events, type SelectionChangedArgs } from "@my-file-manager/plugin-sdk";
import { bus } from "./eventbus";

interface MetaStore extends HostMetaState {
  setCurrentFile: (fileId: string | null) => void;
}

export const useMeta = create<MetaStore>((set, get) => ({
  currentFileId: null,
  setCurrentFile: (fileId) => {
    if (get().currentFileId === fileId) return;
    set({ currentFileId: fileId });
    const payload: SelectionChangedArgs = { fileId };
    bus.emit(Events.selectionChanged, payload);
  },
}));

/** Snapshot for PluginHost.getState() — a plain read-only view. */
export function metaSnapshot(): HostMetaState {
  const { currentFileId } = useMeta.getState();
  return { currentFileId };
}
