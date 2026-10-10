/**
 * 命令面板（roadmap P7-30, docs/04 P6-14/P6-19）——命令面与 `command-palette` 槽的
 * 唯一面板提供者。
 *
 * 分工同上下文菜单：基座（`apps/shell-ui/src/commands.ts`）管注册、唯一提供者、
 * 全局快捷键调度、忙碌与失败捕获、卸载清理；本插件只管画面板 —— 取命令清单、
 * 按输入过滤、执行、把失败留在原地显示。插件卸载后其命令由基座即刻移除，
 * 面板只是重画清单，不自己做任何登记簿。
 *
 * 面板同时能跳文件：文件段来自**当前目录**的 `fs.list`（名称子串匹配，不需要索引），
 * 选中后按既有约定发 `sidebar:selection:changed` + `focus:changed` 两个引用事件 ——
 * 目录引用让文件浏览栏导航进去，文件引用落到它的父目录并在 D 区显示该文件。
 * “当前目录”与 plugin-search 同一推法：只从元状态引用推（folder 取 id，file 取父路径），
 * 界面不自己记一份当前目录。
 */

import { Text } from "@mantine/core";
import { createSpotlight, Spotlight, useSpotlight } from "@mantine/spotlight";
import {
  Capabilities,
  type CommandDescriptor,
  type CommandLauncher,
  Events,
  type ListEntry,
  type PluginHost,
  type Ref,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";
import { useEffect, useRef, useState } from "react";

const PALETTE_WIDTH = 620;
const PALETTE_HEIGHT = 420;
const FILE_LIMIT = 8;
/** 会话内的面板 store：与全局 spotlight 实例无关，面板生命周期自己掌握。 */
const [paletteStore, paletteActions] = createSpotlight();

let launcher: CommandLauncher | null = null;

/** 当前浏览的目录只从元状态的引用推；规则与 plugin-search 一致。 */
function currentDirOf(host: PluginHost): string {
  const state = host.getState();
  for (const ref of [state.focusRef, state.sidebarSelection]) {
    if (!ref) continue;
    if (ref.kind === "folder") return ref.id;
    if (ref.kind === "file") return parentOf(ref.id);
  }
  return "";
}

function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return index > 0 ? trimmed.slice(0, index) : "";
}

/** 目录在前，同类按名称；只求可预期。 */
const byName = (a: ListEntry, b: ListEntry): number =>
  a.isDir === b.isDir ? a.name.localeCompare(b.name, "zh") : a.isDir ? -1 : 1;

const styles = {
  error: {
    margin: "0 16px 8px",
    padding: "6px 10px",
    borderRadius: 6,
    background: "var(--mantine-color-red-0)",
    flexShrink: 0,
  },
  listWrap: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  },
  empty: {
    padding: "18px 16px",
    color: "var(--mantine-color-dimmed)",
    fontSize: 13,
  },
} as const;

// ───────────────────────────── 入口 ─────────────────────────────

export function activate(host: PluginHost): void {
  launcher = host.commands?.provide() ?? null;
  // 键盘打开也是一条注册命令：快捷键由基座统一调度，面板插件不自己挂监听。
  host.commands?.register({
    id: "palette.open",
    title: "打开命令面板",
    group: "视图",
    subtitle: "搜索命令，或跳转当前目录里的文件",
    shortcut: "Ctrl+Shift+P",
    run: () => {
      paletteActions.open();
    },
  });
}

// ───────────────────────────── 面板 ─────────────────────────────

export function CommandPalette({ host }: SlotProps) {
  const { opened, query } = useSpotlight(paletteStore);
  const [commands, setCommands] = useState<Array<{ owner: string; descriptor: CommandDescriptor }>>([]);
  const [dir, setDir] = useState("");
  const [files, setFiles] = useState<ListEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef(host);
  hostRef.current = host;

  // 命令清单跟着基座的通知走：插件注册/卸载命令，面板就地重画。
  useEffect(() => {
    const current = launcher;
    if (!current) return;
    setCommands(current.commands());
    return current.onChange(() => setCommands(current.commands()));
  }, []);

  // 每次打开刷新一次当前目录的文件；迟到结果只认最后一次。
  useEffect(() => {
    if (!opened) return;
    setError(null);
    const current = currentDirOf(hostRef.current);
    setDir(current);
    if (!current) {
      setFiles([]);
      return;
    }
    let stale = false;
    hostRef.current
      .invoke<ListEntry[]>(Capabilities.fsList, { path: current })
      .then((entries) => {
        if (!stale) setFiles(entries.slice().sort(byName));
      })
      .catch(() => {
        if (!stale) setFiles([]);
      });
    return () => {
      stale = true;
    };
  }, [opened]);

  const trimmed = query.trim().toLowerCase();
  const matchedCommands = commands.filter(
    ({ descriptor }) =>
      !trimmed ||
      `${descriptor.title} ${descriptor.subtitle ?? ""} ${descriptor.group ?? ""} ${descriptor.id}`
        .toLowerCase()
        .includes(trimmed),
  );
  const matchedFiles = trimmed ? files.filter((e) => e.name.toLowerCase().includes(trimmed)).slice(0, FILE_LIMIT) : [];

  const runCommand = async (owner: string, id: string): Promise<void> => {
    const current = launcher;
    if (!current) return;
    const ok = await current.run({ owner, id });
    if (ok) paletteActions.close();
    else setError(current.lastError()?.message ?? "命令未能完成。");
  };

  const jumpTo = (entry: ListEntry): void => {
    const ref: Ref = {
      kind: entry.isDir ? "folder" : "file",
      id: entry.path,
      sourcePlugin: hostRef.current.name,
    };
    hostRef.current.emit(Events.sidebarSelectionChanged, ref);
    hostRef.current.emit(Events.focusChanged, ref);
    paletteActions.close();
  };

  const empty = matchedCommands.length === 0 && matchedFiles.length === 0;
  const noDir = trimmed.length > 0 && dir === "";

  return (
    <Spotlight.Root
      store={paletteStore}
      shortcut={null}
      size={PALETTE_WIDTH}
      yOffset={80}
      closeOnActionTrigger={false}
      className="fm-command-palette"
      data-testid="command-palette"
      styles={{
        content: {
          height: PALETTE_HEIGHT,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        },
        body: { display: "flex", flexDirection: "column", height: "100%", padding: 0 },
      }}
    >
      <Spotlight.Search placeholder="输入命令名或文件名…" data-testid="command-palette-search" />
      {error && (
        <Text size="xs" c="red" style={styles.error} data-testid="command-palette-error">
          {error}
        </Text>
      )}
      <div style={styles.listWrap}>
        {/*
          库里的 `.mantine-Spotlight-actionsList` 自带 `max-height: calc(100% - 3.125rem)`，
          那是给"搜索框+列表"连体布局留的 50px；本面板的搜索框在列表之外，内联
          `maxHeight: 100%` 把它覆盖掉，列表才真正吃满剩余高度、内部自己滚动。
        */}
        <Spotlight.ActionsList data-testid="command-palette-list" style={{ flex: 1, minHeight: 0, maxHeight: "100%" }}>
          {matchedCommands.length > 0 && (
            <Spotlight.ActionsGroup label="命令">
              {matchedCommands.map(({ owner, descriptor }) => (
                <Spotlight.Action
                  key={descriptor.id}
                  label={descriptor.title}
                  description={descriptor.subtitle ?? descriptor.group}
                  rightSection={
                    descriptor.shortcut ? (
                      <Text size="xs" c="dimmed">
                        {descriptor.shortcut}
                      </Text>
                    ) : undefined
                  }
                  data-action-kind="command"
                  data-command-id={descriptor.id}
                  onClick={() => void runCommand(owner, descriptor.id)}
                />
              ))}
            </Spotlight.ActionsGroup>
          )}
          {matchedFiles.length > 0 && (
            <Spotlight.ActionsGroup label="当前目录">
              {matchedFiles.map((entry) => (
                <Spotlight.Action
                  key={entry.path}
                  label={entry.name}
                  description={`${entry.isDir ? "目录" : "文件"} · ${dir}`}
                  data-action-kind="file"
                  onClick={() => jumpTo(entry)}
                />
              ))}
            </Spotlight.ActionsGroup>
          )}
          {noDir && (
            <div style={styles.empty} data-testid="command-palette-nodir">
              尚未定位到当前目录：先在左侧选择或打开一个文件夹，再按名称跳文件。
            </div>
          )}
          {empty && !noDir && (
            <div style={styles.empty} data-testid="command-palette-empty">
              没有匹配的命令或文件。
            </div>
          )}
        </Spotlight.ActionsList>
      </div>
    </Spotlight.Root>
  );
}
