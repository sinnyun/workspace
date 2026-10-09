/**
 * Slot renderers.
 *
 * `<PluginSlot slotId>` renders every component registered for that slot, in
 * registration order, each with **its own** gated host (P6-45) — never a shared
 * base host. Degrades to nothing when no plugin has mounted there (docs/02 §4.2).
 *
 * `<SlotOutlet>` is the nested-slot half: a container plugin renders the component
 * it got from `host.provideSlot('pane-slot:0')`; mounting it announces
 * `slot:registered`, unmounting `slot:disposed` (docs/02 §4.5).
 *
 * No Shadow DOM: Mantine overlays portal to document.body and would lose styles
 * inside a shadow root; shared visual tokens come from the Mantine theme instead
 * (docs/01 §7).
 */
import {
  Component,
  useEffect,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import { slotPrefix, type SlotOutletProps, type SlotProps } from "@my-file-manager/plugin-sdk";
import { slotRegistry } from "./slots";

interface Props {
  slotId: string;
}

/** Per-plugin render isolation (roadmap P5-1): a component that throws during
 *  render degrades to a placeholder instead of unmounting the whole shell. */
class PluginErrorBoundary extends Component<
  { plugin: string; children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[slot] plugin "${this.props.plugin}" render error:`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 8, color: "var(--mantine-color-red-6)", fontSize: 12 }}>
          插件 {this.props.plugin} 渲染出错：{this.state.error.message}
        </div>
      );
    }
    return this.props.children;
  }
}

export function PluginSlot({ slotId }: Props) {
  const version = useSyncExternalStore(
    (cb) => slotRegistry.subscribe(cb),
    () => slotRegistry.getVersion(),
    () => 0,
  );

  // Read after subscribing so the render reflects the current version.
  void version;
  const registrations = slotRegistry.get(slotId);
  if (registrations.length === 0) return null;

  return (
    <>
      {registrations.map((reg, i) => {
        const C = reg.component as ComponentType<SlotProps>;
        const slotProps: SlotProps = { host: reg.host, slotId };
        return (
          <PluginErrorBoundary key={`${reg.plugin}-${i}`} plugin={reg.plugin}>
            <C {...slotProps} />
          </PluginErrorBoundary>
        );
      })}
    </>
  );
}

/** One live nested slot: registers on mount, disposes on unmount, renders what
 *  other plugins contributed to it. */
export function SlotOutlet({ slotId, provider }: { slotId: string; provider: string }) {
  useEffect(() => {
    slotRegistry.provide(provider, slotId);
    return () => slotRegistry.unprovide(provider, slotId);
  }, [provider, slotId]);
  return <PluginSlot slotId={slotId} />;
}

/** Build the outlet component a container gets from `host.provideSlot(id)`.
 *  Identity-stable per (provider, id) — the host caches these, so a container
 *  re-rendering never churns the outlet into an unmount/remount cycle.
 *
 *  A runtime `id` may re-target the outlet only WITHIN the authorized prefix
 *  (`pane-slot:0` -> `pane-slot:7`); anything else falls back to the bound id, so
 *  a container can never render a base slot or another plugin's nested slot
 *  through an outlet it was only granted for its own prefix (docs/02 §8). */
export function makeSlotOutlet(
  provider: string,
  slotId: string,
): ComponentType<SlotOutletProps> {
  const boundPrefix = slotPrefix(slotId);
  const Outlet = ({ id }: SlotOutletProps) => {
    const target = id && slotPrefix(id) === boundPrefix ? id : slotId;
    return <SlotOutlet slotId={target} provider={provider} />;
  };
  Outlet.displayName = `SlotOutlet(${slotId})`;
  return Outlet;
}
