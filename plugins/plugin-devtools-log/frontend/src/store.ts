/**
 * In-memory capture store for the devtools-log plugin: a bounded ring buffer of
 * runtime records (logs / errors / perf) plus a tiny subscribe API the panel
 * reads via useSyncExternalStore. Nothing here reaches the base or other plugins
 * — it is this plugin's private debug harness.
 */
export type LogLevel = "error" | "warn" | "info" | "log" | "perf";

export interface LogRecord {
  id: number;
  at: number;
  level: LogLevel;
  source: string;
  message: string;
  detail?: string;
}

const CAP = 5000;

type Listener = () => void;

class LogStore {
  private records: LogRecord[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;

  getSnapshot = (): LogRecord[] => this.records;

  subscribe = (cb: Listener): (() => void) => {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  };

  add(level: LogLevel, source: string, message: string, detail?: string): void {
    this.records = [...this.records, { id: this.nextId++, at: Date.now(), level, source, message, detail }];
    if (this.records.length > CAP) {
      this.records = this.records.slice(this.records.length - CAP);
    }
    this.emit();
  }

  clear(): void {
    this.records = [];
    this.emit();
  }

  counts(): Record<LogLevel, number> {
    const c: Record<LogLevel, number> = { error: 0, warn: 0, info: 0, log: 0, perf: 0 };
    for (const r of this.records) c[r.level]++;
    return c;
  }

  private emit(): void {
    for (const l of [...this.listeners]) l();
  }
}

export const logStore = new LogStore();
