/**
 * Render tests for `<PluginSlot>` → `PluginErrorBoundary` (roadmap P6-33,
 * covering P5-1: one plugin's render error must degrade to a placeholder
 * WITHOUT unmounting its siblings or the rest of the shell).
 */
import type { PluginHost, SlotProps } from "@my-file-manager/plugin-sdk";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginSlot } from "./PluginSlot";
import { slotRegistry } from "./slots";

// The boundary never touches the host; the gated host is exercised by loader
// tests, not here.
const fakeHost = {} as PluginHost;

const Boom = () => {
  throw new Error("炸了");
};
const Survivor = () => <span>幸存的内容</span>;
const NeighbourSlotContent = () => <span>邻栏内容</span>;

const usedPlugins = new Set<string>();

function register(plugin: string, slotId: string, component: ComponentType<SlotProps>): () => void {
  usedPlugins.add(plugin);
  return slotRegistry.add({ plugin, slotId, component, host: fakeHost });
}

afterEach(() => {
  cleanup();
  for (const plugin of usedPlugins) slotRegistry.releasePlugin(plugin);
  usedPlugins.clear();
  vi.restoreAllMocks();
});

describe("PluginSlot", () => {
  it("一个插件抛错只降级该贡献，同槽其它插件与邻槽照常渲染", () => {
    // React itself logs every caught error; silence it, the boundary has its own log line.
    vi.spyOn(console, "error").mockImplementation(() => {});
    register("bad-plugin", "slot:test", Boom);
    register("good-plugin", "slot:test", Survivor);
    register("neighbour-plugin", "slot:test-neighbour", NeighbourSlotContent);

    render(
      <>
        <PluginSlot slotId="slot:test" />
        <PluginSlot slotId="slot:test-neighbour" />
      </>,
    );

    expect(screen.getByText(/插件 bad-plugin 渲染出错：炸了/)).toBeTruthy();
    expect(screen.getByText("幸存的内容")).toBeTruthy();
    expect(screen.getByText("邻栏内容")).toBeTruthy();
  });

  it("无注册的槽渲染为空", () => {
    const { container } = render(<PluginSlot slotId="slot:empty" />);
    expect(container.innerHTML).toBe("");
  });

  it("卸载贡献后（如插件被关闭）其内容从槽中消失", () => {
    const off = register("toggle-plugin", "slot:toggle", Survivor);
    render(<PluginSlot slotId="slot:toggle" />);
    expect(screen.getByText("幸存的内容")).toBeTruthy();

    act(() => off());
    expect(screen.queryByText("幸存的内容")).toBeNull();
  });

  it("出错插件被关闭后，占位符随贡献一起消失", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const off = register("bad-plugin", "slot:recover", Boom);
    render(<PluginSlot slotId="slot:recover" />);
    expect(screen.getByText(/渲染出错/)).toBeTruthy();

    act(() => off());
    expect(screen.queryByText(/渲染出错/)).toBeNull();
  });
});
