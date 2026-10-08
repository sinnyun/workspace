/**
 * Runtime capture wiring for the devtools-log plugin.
 *
 * install() is called once from `activate()` — before the base's other dev
 * plugins finish loading — so it can observe: console output (base + plugin +
 * error-boundary logs), uncaught errors and unhandled rejections, PerformanceObserver
 * long-task / measure timings, and whitelisted bus events. Everything is funneled
 * into the private store; the panel renders it. The returned function restores
 * global state (docs/02 §4.3 teardown contract).
 */
import type { PluginHost } from "@my-file-manager/plugin-sdk";
import { Events } from "@my-file-manager/plugin-sdk";
import { logStore, type LogLevel } from "./store";

function fmtArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

/** Wrap the console methods, preserving the originals so devtools still prints. */
function wrapConsole(): () => void {
  const map: Record<string, LogLevel> = {
    error: "error",
    warn: "warn",
    info: "info",
    log: "log",
    debug: "log",
  };
  const originals: Partial<Record<keyof Console, Console["log"]>> = {};
  for (const key of Object.keys(map) as Array<keyof Console>) {
    const level = map[key as string];
    const orig = console[key].bind(console);
    originals[key] = console[key];
    (console as any)[key] = (...args: unknown[]) => {
      logStore.add(level, "console", args.map(fmtArg).join(" "));
      (orig as (...a: unknown[]) => void)(...args);
    };
  }
  return () => {
    for (const [key, fn] of Object.entries(originals)) {
      if (fn) (console as unknown as Record<string, Console["log"]>)[key] = fn;
    }
  };
}

/** window.onerror + unhandledrejection. */
function installErrorHandlers(): () => void {
  const onError = (ev: ErrorEvent): void => {
    logStore.add("error", "window", ev.message, ev.error?.stack);
  };
  const onRejection = (ev: PromiseRejectionEvent): void => {
    logStore.add("error", "promise", `未处理的 Promise 拒绝: ${fmtArg(ev.reason)}`);
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

/** PerformanceObserver: main-thread long tasks (jank stalls).
 *  We deliberately do NOT observe "measure": React's dev build emits thousands
 *  of internal Render/Unmount/Commit measures which would swamp the ring buffer
 *  and evict real logs. Long tasks are the signal worth keeping. */
function installPerfObserver(): () => void {
  let observer: PerformanceObserver | null = null;
  try {
    observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        logStore.add(
          e.duration >= 100 ? "warn" : "perf",
          "perf",
          `主线程长任务 ${e.duration.toFixed(0)}ms`,
        );
      }
    });
    observer.observe({ type: "longtask", buffered: true });
  } catch {
    // PerformanceObserver / longtask unsupported — degrade to no perf capture.
  }
  return () => {
    try {
      observer?.disconnect();
    } catch {
      // ignore
    }
  };
}

const TRACED_EVENTS: readonly string[] = [
  Events.fileChanged,
  Events.historyUpdated,
  Events.selectionChanged,
];

/** Log whitelisted bus events through the host (gated by manifest). */
function traceEvents(host: PluginHost): () => void {
  const offs: Array<() => void> = [];
  for (const name of TRACED_EVENTS) {
    offs.push(
      host.on<unknown>(name, (payload) => {
        logStore.add("info", `event:${name}`, fmtArg(payload));
      }),
    );
  }
  return () => {
    for (const off of offs) off();
  };
}

export function install(host: PluginHost): () => void {
  const teardowns: Array<() => void> = [
    wrapConsole(),
    installErrorHandlers(),
    installPerfObserver(),
    traceEvents(host),
  ];

  logStore.add("info", "devtools", "运行时捕获已启动（console / 错误 / 性能 / 事件）");

  return () => {
    for (const fn of [...teardowns].reverse()) {
      try {
        fn();
      } catch {
        // best-effort teardown
      }
    }
  };
}
