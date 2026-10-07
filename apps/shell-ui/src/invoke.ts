/**
 * Capability invocation bridge: routes a `domain.action` capability call to the
 * host's single `invoke_capability` dispatch command. One command (not one per
 * capability) because names like `db.<store>.<op>` are dynamic and cannot be
 * static Rust functions; the host parses and dispatches.
 *
 * Outside Tauri (plain browser dev) it falls back to a small in-memory mock so
 * the shell and plugins remain runnable headless.
 */

type Mock = (args: Record<string, unknown>) => unknown;
const mocks = new Map<string, Mock>();

/** Register a browser-only mock for a capability (used in dev without Tauri). */
export function registerMock(capability: string, fn: Mock): void {
  mocks.set(capability, fn);
}

export async function invokeCapability<T>(
  capability: string,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<T>("invoke_capability", {
      capability,
      args: args ?? {},
    })) as T;
  } catch (err) {
    // Not in Tauri, or the command is unknown: try a registered mock.
    const mock = mocks.get(capability);
    if (mock) return mock(args ?? {}) as T;
    throw new Error(
      `invoke "${capability}" failed (no Tauri runtime and no mock): ${String(err)}`,
    );
  }
}
