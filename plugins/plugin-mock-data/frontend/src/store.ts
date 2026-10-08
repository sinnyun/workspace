/**
 * Tiny external store shared by the two mock-data panels (same plugin bundle).
 * Not a base meta-state concern — it is private, ephemeral dev harness state.
 * Panels read it via useSyncExternalStore.
 */
import type { ListEntry } from "@my-file-manager/plugin-sdk";

export interface StressState {
  n: number;
  rows: ListEntry[];
  fetchMs: number;
  loading: boolean;
  error: string | null;
}

type Listener = () => void;

let state: StressState = { n: 1000, rows: [], fetchMs: 0, loading: false, error: null };
const listeners = new Set<Listener>();

export const stressStore = {
  get(): StressState {
    return state;
  },
  set(patch: Partial<StressState>): void {
    state = { ...state, ...patch };
    for (const l of [...listeners]) l();
  },
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  },
};
