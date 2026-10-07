/**
 * <PluginSlot slotId="..."> — renders every component registered for that slot,
 * in registration order. Degrades to nothing when no plugin has mounted there
 * (docs/02 §4.2, roadmap P2-2). Each child gets the same host-bound SlotProps.
 *
 * No Shadow DOM: Mantine overlays portal to document.body and would lose styles
 * inside a shadow root; isolation is Mantine CSS vars + CSS Modules instead
 * (docs/01 §7).
 */
import { Component, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { SlotProps } from "@my-file-manager/plugin-sdk";
import { slotRegistry } from "./slots";

interface Props {
  slotId: string;
  /** Props passed to each mounted plugin component (includes its host). */
  slotProps: SlotProps;
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

export function PluginSlot({ slotId, slotProps }: Props) {
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
        return (
          <PluginErrorBoundary key={`${reg.plugin}-${i}`} plugin={reg.plugin}>
            <C {...slotProps} />
          </PluginErrorBoundary>
        );
      })}
    </>
  );
}
