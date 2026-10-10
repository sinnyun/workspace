/** Plugin-local navigation snapshots. No file state is transferred to the shell. */
export function createToolbarStore<T>() {
  const sessions = new Map<string, Map<string, { value: T; visible: boolean }>>();
  const active = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(session: string, pane: string, value: T, visible: boolean) {
      const entries = sessions.get(session) ?? new Map();
      entries.set(pane, { value, visible });
      sessions.set(session, entries);
      notify();
    },
    claim(session: string, pane: string) {
      active.set(session, pane);
      notify();
    },
    remove(session: string, pane: string) {
      const entries = sessions.get(session);
      entries?.delete(pane);
      if (!entries?.size) {
        sessions.delete(session);
        active.delete(session);
      }
      notify();
    },
    get(session: string): T | null {
      const entries = sessions.get(session);
      const selected = entries?.get(active.get(session) ?? "");
      if (selected?.visible) return selected.value;
      for (const entry of entries?.values() ?? []) if (entry.visible) return entry.value;
      return null;
    },
  };
}
