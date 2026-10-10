/**
 * Command service (roadmap P7-30, docs/04 P6-14).
 *
 * The base owns the *plumbing*; the palette plugin owns the *panel*. Command
 * registration, the single-provider claim, the global keyboard dispatcher,
 * busy state, failure capture and unload cleanup all live here so the
 * invariants hold structurally instead of relying on every plugin to tidy up
 * after itself:
 *
 *  - exactly one provider may claim the palette (first claim wins);
 *  - command ids are unique app-wide, duplicates are refused;
 *  - a shortcut maps to exactly one command: the first registration wins and a
 *    duplicate or malformed shortcut refuses the whole command at load time —
 *    a silently never-firing shortcut is worse than a loud refusal;
 *  - disabling or unloading a plugin removes its commands, drops a command it
 *    was mid-run on, and unregisters its shortcuts, with no plugin-side
 *    bookkeeping;
 *  - the base installs ONE window keydown listener (lazily, on the first
 *    shortcut) rather than letting every plugin add its own.
 *
 * Keys fired from an editable target only dispatch when the chord carries
 * ctrl/alt/meta — so typing "p" in a text box can never fire a bare-letter
 * shortcut, while Ctrl+Shift+P still works from the address bar.
 */
import type { CommandDescriptor, CommandHost, CommandLauncher, PluginManifest } from "@my-file-manager/plugin-sdk";

interface Registration {
  owner: string;
  descriptor: CommandDescriptor;
  shortcut: ParsedShortcut | null;
}

interface ParsedShortcut {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  /** Lower-case letter or digit of the canonical string. */
  key: string;
}

const MODIFIER_NAMES: Record<string, keyof Omit<ParsedShortcut, "key">> = {
  ctrl: "ctrl",
  control: "ctrl",
  shift: "shift",
  alt: "alt",
  meta: "meta",
  cmd: "meta",
  win: "meta",
  super: "meta",
};

/** Parse the canonical `Ctrl+Shift+P` form. Returns null on anything else —
 *  the caller refuses the command rather than registering a dead shortcut. */
export function parseShortcut(text: string): ParsedShortcut | null {
  const parts = text
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const parsed: ParsedShortcut = { ctrl: false, shift: false, alt: false, meta: false, key: "" };
  for (const part of parts) {
    const modifier = MODIFIER_NAMES[part.toLowerCase()];
    if (modifier) {
      parsed[modifier] = true;
      continue;
    }
    if (parsed.key || !/^[a-z0-9]$/i.test(part)) return null;
    parsed.key = part.toLowerCase();
  }
  return parsed.key ? parsed : null;
}

/** Physical-key code for a parsed key, layout-independent (`p` -> `KeyP`). */
const codeOf = (key: string): string => (/[0-9]/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`);

function matchesEvent(shortcut: ParsedShortcut, event: KeyboardEvent): boolean {
  if (
    shortcut.ctrl !== event.ctrlKey ||
    shortcut.shift !== event.shiftKey ||
    shortcut.alt !== event.altKey ||
    shortcut.meta !== event.metaKey
  ) {
    return false;
  }
  return event.code === codeOf(shortcut.key) || event.key.toLowerCase() === shortcut.key;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

class CommandService {
  private registrations: Registration[] = [];
  private provider: string | null = null;
  private executing: { owner: string; id: string } | null = null;
  private error: { id: string; message: string } | null = null;
  private listeners = new Set<() => void>();
  private dispatching = false;

  notify(): void {
    for (const cb of [...this.listeners]) {
      try {
        cb();
      } catch (err) {
        console.error("[commands] listener error:", err);
      }
    }
  }

  /** The single window-level dispatcher; installed on the first shortcut. */
  private ensureDispatcher(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    window.addEventListener(
      "keydown",
      (event) => {
        for (const reg of this.registrations) {
          const shortcut = reg.shortcut;
          if (!shortcut || !matchesEvent(shortcut, event)) continue;
          if (isEditableTarget(event.target) && !shortcut.ctrl && !shortcut.alt && !shortcut.meta) {
            continue;
          }
          event.preventDefault();
          console.info(`[commands] shortcut "${reg.descriptor.shortcut}" -> "${reg.descriptor.id}"`);
          void this.run(reg.owner, reg.descriptor.id);
          return;
        }
      },
      { capture: true },
    );
  }

  /** Register one command on behalf of `owner`. Rejects a blank or duplicate id,
   *  a malformed shortcut, and a shortcut already claimed by another command. */
  register(owner: string, descriptor: CommandDescriptor): () => void {
    const id = descriptor.id?.trim();
    const title = descriptor.title?.trim();
    if (!id || !title) {
      console.warn(`[commands:${owner}] command needs a non-empty id and title — refused`);
      return () => {};
    }
    if (this.registrations.some((r) => r.descriptor.id === id)) {
      console.warn(`[commands:${owner}] command id "${id}" already registered — refused`);
      return () => {};
    }
    let shortcut: ParsedShortcut | null = null;
    if (descriptor.shortcut !== undefined) {
      shortcut = parseShortcut(descriptor.shortcut);
      if (!shortcut) {
        console.warn(
          `[commands:${owner}] command "${id}" has malformed shortcut ` +
            `"${descriptor.shortcut}" (canonical form: Ctrl+Shift+P) — refused`,
        );
        return () => {};
      }
      const claimed = this.registrations.find(
        (r) => r.descriptor.shortcut?.toLowerCase() === descriptor.shortcut?.toLowerCase(),
      );
      if (claimed) {
        console.warn(
          `[commands:${owner}] shortcut "${descriptor.shortcut}" for "${id}" already ` +
            `claimed by "${claimed.descriptor.id}" — refused`,
        );
        return () => {};
      }
    }
    const reg: Registration = { owner, descriptor: { ...descriptor, id, title }, shortcut };
    this.registrations.push(reg);
    if (shortcut) this.ensureDispatcher();
    this.notify();
    return () => {
      const idx = this.registrations.indexOf(reg);
      if (idx >= 0) this.registrations.splice(idx, 1);
      this.notify();
    };
  }

  /** Claim the palette. Only one plugin ever gets a launcher back. */
  claimProvider(owner: string): CommandLauncher | null {
    if (this.provider && this.provider !== owner) {
      console.warn(`[commands] palette already provided by "${this.provider}" — "${owner}" refused`);
      return null;
    }
    this.provider = owner;
    const isOwner = (): boolean => this.provider === owner;
    return {
      commands: () => (isOwner() ? this.registrations.map((r) => ({ owner: r.owner, descriptor: r.descriptor })) : []),
      onChange: (cb) => {
        if (!isOwner()) return () => {};
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
      },
      run: async (target) => {
        if (!isOwner()) return false;
        return this.run(target.owner, target.id);
      },
      executing: () => (isOwner() ? this.executing : null),
      lastError: () => (isOwner() ? this.error : null),
    };
  }

  releaseProvider(owner: string): void {
    if (this.provider === owner) this.provider = null;
  }

  /** Run one command. Busy-flagged, re-entry blocked, failures captured for
   *  the invoking surface. Resolves true when the command completed. */
  async run(owner: string, id: string): Promise<boolean> {
    const reg = this.registrations.find((r) => r.owner === owner && r.descriptor.id === id);
    if (!reg) return false;
    if (this.executing) {
      this.error = { id, message: "上一条命令还在执行，请稍候。" };
      this.notify();
      return false;
    }
    this.executing = { owner, id };
    this.error = null;
    this.notify();
    try {
      await reg.descriptor.run();
      return true;
    } catch (err) {
      this.error = {
        id,
        message: err instanceof Error ? err.message.replace(/^Error:\s*/, "") : String(err),
      };
      console.error(`[commands:${owner}] command "${id}" failed:`, err);
      return false;
    } finally {
      this.executing = null;
      this.notify();
    }
  }

  /** Disable/unload cleanup: commands gone, shortcuts unregistered, a command
   *  the plugin was mid-run on dropped so it cannot wedge the busy guard. */
  releasePlugin(owner: string): void {
    this.registrations = this.registrations.filter((r) => r.owner !== owner);
    if (this.provider === owner) this.provider = null;
    if (this.executing?.owner === owner) this.executing = null;
    this.notify();
  }
}

export const commandService = new CommandService();

/** Build the gated `host.commands` face for one plugin, or undefined when its
 *  manifest grants none. Every returned handle is also registered in the host's
 *  teardown list, so unloading a plugin cannot leak commands or listeners. */
export function createCommandHost(
  manifest: PluginManifest,
  teardowns: Array<() => void>,
  warn: (what: string) => void,
): CommandHost | undefined {
  const grant = manifest.permissions?.commands;
  if (!grant) return undefined;
  const service = commandService;
  const name = manifest.name;

  const host: CommandHost = {
    provide() {
      if (!grant.provide) {
        warn("commands.provide (permissions.commands.provide not set)");
        return null;
      }
      const launcher = service.claimProvider(name);
      if (!launcher) return null;
      teardowns.push(() => service.releaseProvider(name));
      return launcher;
    },
    register(descriptor) {
      if (!grant.register) {
        warn(`commands.register("${descriptor.id}") (permissions.commands.register not set)`);
        return () => {};
      }
      const off = service.register(name, descriptor);
      teardowns.push(off);
      return off;
    },
  };
  return host;
}
