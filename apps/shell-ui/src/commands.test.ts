/**
 * Unit tests for the command service (roadmap P6-33): shortcut parsing, the
 * refusal rules (duplicate id, malformed shortcut, already-claimed shortcut),
 * the exclusive palette claim, the busy guard, failure capture, unload
 * cleanup, and the single global keydown dispatcher with its editable-target
 * rule (typing "p" in a text box must never fire a shortcut, Ctrl+chords must).
 */
import type { CommandLauncher } from "@my-file-manager/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandService, parseShortcut } from "./commands";

const usedOwners = new Set<string>();
const owner = (name: string): string => {
  usedOwners.add(name);
  return name;
};

function claim(name: string): CommandLauncher {
  const launcher = commandService.claimProvider(owner(name));
  if (!launcher) throw new Error(`palette claim refused for ${name}`);
  return launcher;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  for (const name of usedOwners) commandService.releasePlugin(name);
  usedOwners.clear();
  vi.restoreAllMocks();
});

describe("parseShortcut", () => {
  it("解析规范形式并归一化大小写", () => {
    expect(parseShortcut("Ctrl+Shift+P")).toEqual({ ctrl: true, shift: true, alt: false, meta: false, key: "p" });
    expect(parseShortcut("ctrl + alt + 5")).toEqual({ ctrl: true, shift: false, alt: true, meta: false, key: "5" });
  });

  it("接受修饰键别名（control/cmd/win/super）", () => {
    const meta = { ctrl: false, shift: false, alt: false, meta: true, key: "k" };
    expect(parseShortcut("Cmd+K")).toEqual(meta);
    expect(parseShortcut("win+k")).toEqual(meta);
    expect(parseShortcut("super+k")).toEqual(meta);
    expect(parseShortcut("Control+L")).toEqual({ ctrl: true, shift: false, alt: false, meta: false, key: "l" });
  });

  it("拒绝无修饰键、多主键与非法键", () => {
    expect(parseShortcut("P")).toBeNull();
    expect(parseShortcut("Ctrl+P+Q")).toBeNull();
    expect(parseShortcut("Ctrl+Enter")).toBeNull();
    expect(parseShortcut("Ctrl+")).toBeNull();
    expect(parseShortcut("")).toBeNull();
  });
});

describe("register 拒绝规则", () => {
  it("拒绝空 id/title、重复 id、格式错误与已被占用的快捷键", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const launcher = claim("observer");

    commandService.register(owner("a"), { id: "file.save", title: "保存", shortcut: "Ctrl+S", run: () => {} });
    expect(launcher.commands().length).toBe(1);

    commandService.register(owner("b"), { id: "file.save", title: "重复", run: () => {} });
    commandService.register(owner("b"), { id: "file.b", title: "  ", run: () => {} });
    commandService.register(owner("b"), {
      id: "file.b",
      title: "b",
      shortcut: "Ctrl+Enter",
      run: () => {},
    });
    commandService.register(owner("b"), {
      id: "file.b",
      title: "b",
      shortcut: "ctrl+s",
      run: () => {},
    });
    expect(launcher.commands().length).toBe(1);

    commandService.register(owner("b"), { id: "file.b", title: "b", run: () => {} });
    expect(launcher.commands().length).toBe(2);

    const off = commandService.register(owner("c"), { id: "file.c", title: "c", run: () => {} });
    expect(launcher.commands().length).toBe(3);
    off();
    expect(launcher.commands().length).toBe(2);
  });
});

describe("命令面板认领", () => {
  it("只有第一个认领者拿到 launcher；释放后旧 launcher 失效、他人可认领", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = claim("palette-a");
    expect(commandService.claimProvider(owner("palette-b"))).toBeNull();

    commandService.register(owner("keeper"), { id: "keeper.keep", title: "K", run: () => {} });

    commandService.releasePlugin(owner("palette-a"));
    const second = claim("palette-b");
    expect(second.commands().map((c) => c.descriptor.id)).toEqual(["keeper.keep"]);

    expect(first.commands()).toEqual([]);
    await expect(first.run({ owner: "keeper", id: "keeper.keep" })).resolves.toBe(false);
    expect(first.executing()).toBeNull();
    expect(first.lastError()).toBeNull();
  });
});

describe("run 与错误捕获", () => {
  it("未注册的命令返回 false", async () => {
    await expect(commandService.run("ghost", "nope")).resolves.toBe(false);
  });

  it("同一时刻只跑一条命令，执行中再触发被拒并给出提示", async () => {
    const launcher = claim("palette");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    commandService.register(owner("slow"), { id: "slow.op", title: "慢操作", run: () => gate });

    const inflight = commandService.run("slow", "slow.op");
    expect(launcher.executing()).not.toBeNull();
    await expect(commandService.run("slow", "slow.op")).resolves.toBe(false);
    expect(launcher.lastError()?.message).toContain("还在执行");

    release();
    await expect(inflight).resolves.toBe(true);
    expect(launcher.executing()).toBeNull();
  });

  it("命令抛错被捕获为 lastError，Error 前缀被剥掉", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const launcher = claim("palette");
    commandService.register(owner("boom"), {
      id: "boom.err",
      title: "炸",
      run: () => {
        throw new Error("磁盘满了");
      },
    });
    await expect(commandService.run("boom", "boom.err")).resolves.toBe(false);
    expect(launcher.lastError()).toEqual({ id: "boom.err", message: "磁盘满了" });

    commandService.register(owner("boom"), {
      id: "boom.str",
      title: "炸2",
      run: () => {
        throw "纯字符串";
      },
    });
    await expect(commandService.run("boom", "boom.str")).resolves.toBe(false);
    expect(launcher.lastError()?.message).toBe("纯字符串");
  });
});

describe("releasePlugin 卸载清理", () => {
  it("清掉该插件的命令；执行中被卸载不会卡住繁忙标记", async () => {
    const launcher = claim("palette");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const leaver = owner("leaver");
    commandService.register(leaver, { id: "leaver.slow", title: "L", run: () => gate });
    commandService.register(owner("keeper"), { id: "keeper.keep", title: "K", run: () => {} });

    const inflight = commandService.run(leaver, "leaver.slow");
    expect(launcher.executing()).not.toBeNull();
    commandService.releasePlugin(leaver);

    expect(launcher.commands().map((c) => c.descriptor.id)).toEqual(["keeper.keep"]);
    expect(launcher.executing()).toBeNull();
    // 繁忙标记被打扫干净：下一个命令可以直接跑
    await expect(commandService.run("keeper", "keeper.keep")).resolves.toBe(true);

    release();
    await inflight;
  });
});

describe("全局快捷键分发", () => {
  it("Ctrl+Shift+P 触发命令；输入框里的无修饰键组合不触发", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    let hits = 0;
    let typedInBox = 0;
    const o = owner("shortcut-owner");
    commandService.register(o, {
      id: "test.hit",
      title: "命中",
      shortcut: "Ctrl+Shift+P",
      run: () => {
        hits++;
      },
    });
    commandService.register(o, {
      id: "test.shift",
      title: "输入",
      shortcut: "Shift+P",
      run: () => {
        typedInBox++;
      },
    });

    const input = document.createElement("input");
    document.body.appendChild(input);

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "P", code: "KeyP", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await flush();
    expect(typedInBox).toBe(0);

    input.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "P",
        code: "KeyP",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await flush();
    expect(hits).toBe(1);

    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "P", code: "KeyP", shiftKey: true, bubbles: true, cancelable: true }),
    );
    await flush();
    expect(typedInBox).toBe(1);

    input.remove();
  });
});
