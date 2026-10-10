/**
 * `plugin-file-ops` — the app's only in-app file *write* entry point
 * (docs/plugin-functional/plugin-file-ops.md, roadmap P7-18).
 *
 * The division of labour is the whole design: this plugin collects intent
 * (which items, which new name, which target folder) and draws the result; the
 * Windows Shell performs every mutation through `shell.fileOperation`. There is
 * no copy/move/delete loop in this file and there must never be one — the Shell
 * owns recursion, conflict resolution, the recycle bin, cross-volume moves and
 * the system progress dialog, and its answer is the only truth we report.
 *
 * Because `shell.fileOperation` only *acks*, the state machine is spread over
 * three pieces of state rather than one enum, and every transition is driven by
 * what actually arrived:
 *   idle → editing (a modal holds the parameters) → submitting (validating on the
 *   host) → live (`queued`/`running`/`cancelling` from `shell:operation:progress`)
 *   → last (the terminal `shell:operation:done`, which is the only place
 *   `completed` / `partial-failure` / `failed` / `cancelled` is decided).
 * Progress is shown **indeterminate on purpose**: `IFileOperation` hands the host
 * no trustworthy percentage, and the contract states that rather than hiding it
 * (`FileOperationOut.indeterminate` is true by construction).
 *
 * The status bar is a base slot with exactly one instance, which is also where
 * the context-menu items are registered — same trick `plugin-file-browser` uses
 * for its toolbar-owned actions: a component that mounts once owns the items
 * that must exist once.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActionIcon,
  Button,
  Group,
  Loader,
  Modal,
  ScrollArea,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import type {
  ContextMenuContext,
  FileConflictPolicy,
  FileOperationIn,
  FileOperationItem,
  FileOperationOut,
  FileOperationProgress,
  FileOperationResult,
  FileOperationState,
  PickOut,
  PluginHost,
  Ref,
  SlotProps,
} from "@my-file-manager/plugin-sdk";
import { Capabilities, Events, FrontendCapabilities } from "@my-file-manager/plugin-sdk";

const FILE = "file";
const FOLDER = "folder";

/** Only the browser's own surfaces address a path the user is looking at.
 *  Favorites and tags carry file refs too, but renaming/deleting from there has
 *  no cross-plugin invalidation contract yet — the entry would silently point at
 *  a path that no longer exists, so those surfaces keep their own actions only. */
const SURFACE_ITEM = new Set(["browser.list.item", "browser.grid.item"]);
const SURFACE_EMPTY = "browser.empty";

/** Windows refuses these in a name; catching them here is not duplicate work —
 *  the host also rejects them, and a modal that never opens an invalid dialog is
 *  the point (the Shell's own error dialog arrives after real IO). */
const ILLEGAL_NAME = /[<>:"/\\|?*]/;

type Pending =
  | { kind: "rename"; path: string; name: string; error: string | null }
  | { kind: "transfer"; op: "copy" | "move"; sources: string[]; destination: string; conflict: FileConflictPolicy; error: string | null }
  | { kind: "create"; dir: string; name: string; error: string | null }
  | { kind: "delete"; sources: string[]; error: string | null };

interface Live {
  id: string;
  label: string;
  total: number;
  state: FileOperationState;
  current: string | null;
}

interface LastRun {
  label: string;
  result: FileOperationResult;
}

const errorMessage = (err: unknown): string =>
  err instanceof Error ? err.message.replace(/^Error:\s*/, "") : String(err);

/** Both separators: dev paths are `/`-joined, a real Windows path is `\`-joined,
 *  and a mixed path is exactly what a user pastes into an address bar. */
const sepOf = (path: string): number => Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
const nameOf = (path: string): string => path.slice(sepOf(path) + 1);
const parentOf = (path: string): string => {
  const i = sepOf(path);
  return i > 0 ? path.slice(0, i) : "";
};

const isAddressable = (ref: Ref | null): ref is Ref =>
  !!ref && (ref.kind === FILE || ref.kind === FOLDER);

/** The items an action applies to: the right-clicked target plus the multi-select
 *  siblings the browser already folded into the context (P7-12 selection rules). */
function targetsOf(context: ContextMenuContext): Ref[] {
  const out: Ref[] = [];
  const seen = new Set<string>();
  for (const ref of [context.targetRef, ...context.selectedRefs]) {
    if (!isAddressable(ref) || seen.has(ref.id)) continue;
    seen.add(ref.id);
    out.push(ref);
  }
  return out;
}

function validateName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "名称不能为空";
  if (name === "." || name === "..") return "名称不能是 . 或 ..";
  if (ILLEGAL_NAME.test(name)) return '名称不能包含 \\ / : * ? " < > |';
  if (/[.]$/.test(name)) return "名称结尾不能是点";
  return null;
}

const OP_LABELS: Record<FileOperationIn["op"], string> = {
  copy: "复制",
  move: "移动",
  rename: "重命名",
  create: "新建文件夹",
  delete: "移到回收站",
};

const CONFLICT_LABELS: { value: FileConflictPolicy; label: string }[] = [
  { value: "rename", label: "同名时保留两者" },
  { value: "overwrite", label: "覆盖同名项" },
  { value: "fail", label: "同名时停止" },
];

/** Status-bar wording per terminal state — 部分成功必须看得见，
 *  因为 Shell 的批量操作不是事务，已完成的项不会回滚。 */
function summaryOf(last: LastRun): { text: string; tone: string } {
  const { result, label } = last;
  const done = result.items.filter((i) => i.outcome === "completed" || i.outcome === "renamed").length;
  const failed = result.items.filter((i) => i.outcome === "failed").length;
  const cancelled = result.items.filter((i) => i.outcome === "cancelled").length;
  const autoRenamed = result.items.filter((i) => i.outcome === "renamed").length;
  const cross = result.crossVolumeMove ? "（跨卷移动：Shell 按复制后删除完成）" : "";
  switch (result.state) {
    case "completed":
      return {
        text: `${label}完成：${done} 项${autoRenamed ? `，其中 ${autoRenamed} 项自动改名` : ""}${cross}`,
        tone: "dimmed",
      };
    case "partial-failure":
      return { text: `${label}部分完成：成功 ${done} 项，失败 ${failed} 项${cross}`, tone: "red" };
    case "cancelled":
      return { text: `${label}已取消：完成 ${done} 项，取消 ${cancelled} 项`, tone: "yellow" };
    default:
      return { text: `${label}失败：${result.items.length} 项未完成`, tone: "red" };
  }
}

/** Paths a successful item touched. `file:changed` names **the item**, not its
 *  directory — the same spelling the watcher uses — so every listener decides for
 *  itself whether that item lives in what it is showing. This is the plugin's own
 *  contribution to the event: the watcher keeps publishing it for changes made
 *  outside the app, and an operation the app just performed should not wait for
 *  notify's debounce to become visible. */
function affectedPaths(items: FileOperationItem[]): string[] {
  const paths = new Set<string>();
  for (const item of items) {
    if (item.outcome !== "completed" && item.outcome !== "renamed") continue;
    if (item.source) paths.add(item.source);
    if (item.destination) paths.add(item.destination);
  }
  return [...paths];
}

export function activate(_host: PluginHost): void {
  // Everything happens on mount: the panel and its items belong to the status bar.
}

export function OperationStatus({ host }: SlotProps) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [last, setLast] = useState<LastRun | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [details, setDetails] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  /** Menu `enabled` runs outside React's render, so it reads the live operation
   *  through a ref: one in-flight batch at a time keeps the status line truthful. */
  const liveRef = useRef<Live | null>(null);
  liveRef.current = live;
  const pendingRef = useRef<Pending | null>(null);
  pendingRef.current = pending;

  const flash = useCallback((text: string): void => {
    setNotice(text);
    window.setTimeout(() => setNotice((cur) => (cur === text ? null : cur)), 5000);
  }, []);

  const submit = useCallback(
    async (req: FileOperationIn, label: string): Promise<void> => {
      setSubmitting(true);
      try {
        const ack = await host.invoke<FileOperationOut>(
          Capabilities.shellFileOperation,
          req as unknown as Record<string, unknown>,
        );
        // The ack is only a queue receipt; the truth arrives as events.
        setLive({
          id: ack.operationId,
          label,
          total: ack.total,
          state: ack.state,
          current: null,
        });
        setLast(null);
        setPending(null);
      } catch (err) {
        // Validation failures land back in the open modal — the parameters the
        // user typed must not disappear on a rejection.
        const message = `无法开始操作：${errorMessage(err)}`;
        setPending((cur) => (cur ? { ...cur, error: message } : cur));
      } finally {
        setSubmitting(false);
      }
    },
    [host],
  );

  // —— terminal results —
  // Subscribed on mount, not per operation: an answer can arrive after the modal
  // is gone, and a result for an id we no longer track must still be reported.
  useEffect(() => {
    const offProgress = host.on<FileOperationProgress>(Events.shellOperationProgress, (payload) => {
      setLive((cur) =>
        cur && cur.id === payload.operationId
          ? { ...cur, state: payload.state, current: payload.currentName ?? null }
          : cur,
      );
    });
    const offDone = host.on<FileOperationResult>(Events.shellOperationDone, (payload) => {
      // The label came from the request we queued; a result for an id we no
      // longer track (plugin reloaded, or the modal was replaced) still gets
      // reported, just under a generic name.
      const running = liveRef.current;
      const label = running && running.id === payload.operationId ? running.label : "文件操作";
      setLive((cur) => (cur && cur.id === payload.operationId ? null : cur));
      setLast({ label, result: payload });
      for (const path of affectedPaths(payload.items)) {
        host.emit(Events.fileChanged, { path, kind: "modify" });
      }
    });
    return () => {
      offProgress();
      offDone();
    };
  }, [host]);

  const cancelLive = useCallback((): void => {
    const current = liveRef.current;
    if (!current) return;
    void host
      .invoke<boolean>(Capabilities.shellCancelFileOperation, { operationId: current.id })
      .then((accepted) => {
        if (!accepted) flash("这项操作已经结束了，无法取消");
      })
      .catch((err) => flash(`取消失败：${errorMessage(err)}`));
  }, [host, flash]);

  const openItem = useCallback(
    async (path: string): Promise<void> => {
      try {
        await host.invoke<boolean>(Capabilities.shellOpenPath, { path });
        flash(`已交给系统默认程序打开：${nameOf(path)}`);
      } catch (err) {
        flash(`打开失败：${errorMessage(err)}`);
      }
    },
    [host, flash],
  );

  const revealItem = useCallback(
    async (paths: string[]): Promise<void> => {
      try {
        await host.invoke<boolean>(Capabilities.shellRevealItem, { path: paths[0] ?? "" });
      } catch (err) {
        flash(`在资源管理器中显示失败：${errorMessage(err)}`);
      }
    },
    [host, flash],
  );

  const pickDestination = useCallback(async (): Promise<void> => {
    const form = pendingRef.current;
    if (!form || form.kind !== "transfer") return;
    try {
      const picked = await host.invoke<PickOut>(Capabilities.shellPickDirectory, {
        title: "选择目标文件夹",
        initialDir: form.destination || parentOf(form.sources[0] ?? "") || null,
        filters: [],
        multiple: false,
      });
      if (picked.cancelled) return;
      const dir = picked.paths[0];
      if (!dir) return;
      setPending((cur) =>
        cur && cur.kind === "transfer" ? { ...cur, destination: dir, error: null } : cur,
      );
    } catch (err) {
      setPending((cur) =>
        cur && cur.kind === "transfer" ? { ...cur, error: `选择文件夹失败：${errorMessage(err)}` } : cur,
      );
    }
  }, [host]);

  const copyReport = useCallback(async (): Promise<void> => {
    if (!last) return;
    // The report is user-visible text (it gets pasted into bug reports), so it
    // spells outcomes and reasons in Chinese — the wire vocabulary stays internal.
    const text = [
      summaryOf(last).text,
      ...last.result.items.map((i) => {
        const to = i.destination && i.destination !== i.source ? ` → ${i.destination}` : "";
        const why = i.reason ? `（${REASON_LABELS[i.reason]}）` : "";
        return `${OUTCOME_LABELS[i.outcome]}：${i.source}${to}${why}`;
      }),
    ].join("\n");
    try {
      await host.invoke<void>(FrontendCapabilities.clipboardWrite, { text });
      flash("失败清单已复制到剪贴板");
    } catch (err) {
      flash(`复制失败：${errorMessage(err)}`);
    }
  }, [host, last, flash]);

  // —— context menu: this plugin contributes the actions, the panel only draws them ——
  useEffect(() => {
    const menu = host.contextMenu;
    if (!menu) return;
    const busy = (): boolean => liveRef.current !== null;
    const single = (context: ContextMenuContext): boolean =>
      SURFACE_ITEM.has(context.surfaceId) && targetsOf(context).length === 1 && !busy();
    const many = (surface: (context: ContextMenuContext) => boolean) => (context: ContextMenuContext): boolean =>
      surface(context) && targetsOf(context).length > 0 && !busy();

    const offOpen = menu.registerItem({
      id: "fileOps.open",
      label: "打开",
      order: 10,
      when: single,
      execute: (context) => {
        const target = context.targetRef;
        if (isAddressable(target)) void openItem(target.id);
      },
    });
    const offReveal = menu.registerItem({
      id: "fileOps.reveal",
      label: "在资源管理器中显示",
      order: 11,
      when: many((c) => SURFACE_ITEM.has(c.surfaceId)),
      execute: (context) => {
        void revealItem(targetsOf(context).map((r) => r.id));
      },
    });
    const offRename = menu.registerItem({
      id: "fileOps.rename",
      label: "重命名",
      order: 20,
      group: "collect",
      when: single,
      execute: (context) => {
        const target = context.targetRef;
        if (!isAddressable(target)) return;
        setPending({ kind: "rename", path: target.id, name: nameOf(target.id), error: null });
      },
    });
    const offCopy = menu.registerItem({
      id: "fileOps.copy",
      label: "复制到文件夹",
      order: 21,
      group: "collect",
      when: many((c) => SURFACE_ITEM.has(c.surfaceId)),
      execute: (context) => {
        const sources = targetsOf(context).map((r) => r.id);
        setPending({
          kind: "transfer",
          op: "copy",
          sources,
          destination: parentOf(sources[0] ?? ""),
          conflict: "rename",
          error: null,
        });
      },
    });
    const offMove = menu.registerItem({
      id: "fileOps.move",
      label: "移动到文件夹",
      order: 22,
      group: "collect",
      when: many((c) => SURFACE_ITEM.has(c.surfaceId)),
      execute: (context) => {
        const sources = targetsOf(context).map((r) => r.id);
        setPending({
          kind: "transfer",
          op: "move",
          sources,
          destination: parentOf(sources[0] ?? ""),
          conflict: "rename",
          error: null,
        });
      },
    });
    // 空白区的目标目录由浏览器作为 surface 目标交出来（targetRef.kind=folder），
    // 所以这里不需要任何"当前目录"的全局状态。
    const offCreate = menu.registerItem({
      id: "fileOps.createFolder",
      label: "新建文件夹",
      order: 30,
      group: "collect",
      when: (context) =>
        context.surfaceId === SURFACE_EMPTY && context.targetRef?.kind === FOLDER && !busy(),
      execute: (context) => {
        const dir = context.targetRef?.id ?? "";
        if (dir) setPending({ kind: "create", dir, name: "新建文件夹", error: null });
      },
    });
    const offDelete = menu.registerItem({
      id: "fileOps.delete",
      label: "移到回收站",
      order: 40,
      group: "danger",
      when: many((c) => SURFACE_ITEM.has(c.surfaceId)),
      execute: (context) => {
        setPending({ kind: "delete", sources: targetsOf(context).map((r) => r.id), error: null });
      },
    });
    return () => {
      offOpen();
      offReveal();
      offRename();
      offCopy();
      offMove();
      offCreate();
      offDelete();
    };
  }, [host, openItem, revealItem]);

  const confirmPending = useCallback(async (): Promise<void> => {
    const form = pendingRef.current;
    if (!form) return;
    if (form.kind === "rename") {
      const invalid = validateName(form.name);
      if (invalid) {
        setPending({ ...form, error: invalid });
        return;
      }
      const current = nameOf(form.path);
      if (current === form.name.trim()) {
        setPending(null);
        return;
      }
      await submit(
        {
          op: "rename",
          sources: [form.path],
          newName: form.name.trim(),
          toRecycleBin: true,
          conflict: "fail",
        },
        `重命名 ${current}`,
      );
      return;
    }
    if (form.kind === "create") {
      const invalid = validateName(form.name);
      if (invalid) {
        setPending({ ...form, error: invalid });
        return;
      }
      await submit(
        {
          op: "create",
          sources: [form.dir],
          destination: form.dir,
          newName: form.name.trim(),
          toRecycleBin: true,
          conflict: "rename",
        },
        `新建文件夹 ${form.name.trim()}`,
      );
      return;
    }
    if (form.kind === "transfer") {
      const destination = form.destination.trim();
      if (!destination) {
        setPending({ ...form, error: "请选择目标文件夹" });
        return;
      }
      if (form.op === "move" && form.sources.some((s) => parentOf(s) === destination)) {
        setPending({ ...form, error: "目标文件夹和当前位置相同" });
        return;
      }
      await submit(
        {
          op: form.op,
          sources: form.sources,
          destination,
          toRecycleBin: true,
          conflict: form.conflict,
        },
        `${OP_LABELS[form.op]} ${form.sources.length} 项`,
      );
      return;
    }
    await submit(
      {
        op: "delete",
        sources: form.sources,
        toRecycleBin: true,
        conflict: "fail",
      },
      `移到回收站 ${form.sources.length} 项`,
    );
  }, [submit]);

  const error = pending?.error ?? null;

  return (
    <>
      <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }} data-testid="file-ops-status">
        {live ? (
          <>
            <Loader size={12} />
            <Text size="xs" truncate title={`operationId: ${live.id}`}>
              {LIVE_TEXT(live)}
            </Text>
            <Button size="compact-xs" variant="subtle" onClick={cancelLive}
              data-testid="file-ops-cancel">
              取消
            </Button>
          </>
        ) : last ? (
          <>
            <Text size="xs" c={summaryOf(last).tone} truncate>
              {summaryOf(last).text}
            </Text>
            {last.result.items.some((i) => i.outcome === "failed") && (
              <Button size="compact-xs" variant="subtle" onClick={() => setDetails(true)}
                data-testid="file-ops-details">
                详情
              </Button>
            )}
            <ActionIcon size="xs" variant="subtle" color="gray" title="清除结果" aria-label="清除结果"
              onClick={() => setLast(null)}>
              ×
            </ActionIcon>
          </>
        ) : notice ? (
          <Text size="xs" c="dimmed" truncate>
            {notice}
          </Text>
        ) : null}
      </Group>

      <Modal
        opened={!!pending && pending.kind !== "delete"}
        onClose={() => setPending(null)}
        title={MODAL_TITLE(pending)}
        size="md"
        centered
      >
        {pending && pending.kind === "rename" && (
          <Stack gap="sm">
            <TextInput
              label="新名称"
              data-testid="file-ops-name"
              value={pending.name}
              onChange={(e) => setPending({ ...pending, name: e.currentTarget.value, error: null })}
              autoFocus
              miw={0}
            />
            <Text size="xs" c="dimmed">
              位置不变，只改名称：{parentOf(pending.path)}
            </Text>
          </Stack>
        )}
        {pending && pending.kind === "create" && (
          <Stack gap="sm">
            <TextInput
              label="文件夹名称"
              data-testid="file-ops-name"
              value={pending.name}
              onChange={(e) => setPending({ ...pending, name: e.currentTarget.value, error: null })}
              autoFocus
              miw={0}
            />
            <Text size="xs" c="dimmed">
              创建在：{pending.dir}
            </Text>
          </Stack>
        )}
        {pending && pending.kind === "transfer" && (
          <Stack gap="sm">
            <Text size="xs" c="dimmed">
              {`${pending.sources.length} 项 · ${pending.sources.map(nameOf).slice(0, 3).join("、")}${pending.sources.length > 3 ? " …" : ""}`}
            </Text>
            <Group gap={4} wrap="nowrap" align="flex-end">
              <TextInput
                flex={1}
                label="目标文件夹"
                data-testid="file-ops-destination"
                value={pending.destination}
                onChange={(e) =>
                  setPending({ ...pending, destination: e.currentTarget.value, error: null })
                }
                miw={0}
              />
              <Button variant="light" onClick={() => void pickDestination()}
                data-testid="file-ops-pick">
                浏览
              </Button>
            </Group>
            <SegmentedControl
              data={CONFLICT_LABELS.map((c) => ({ label: c.label, value: c.value }))}
              value={pending.conflict}
              onChange={(value) =>
                setPending({ ...pending, conflict: value as FileConflictPolicy, error: null })
              }
              fullWidth
            />
            <Text size="xs" c="dimmed">
              同名冲突与进度提示由 Windows 处理，本应用不重复实现。
            </Text>
          </Stack>
        )}
        {error && (
          <Text size="xs" c="red" mt="xs" data-testid="file-ops-form-error">
            {error}
          </Text>
        )}
        <Group justify="flex-end" mt="md">
          <Button variant="subtle" onClick={() => setPending(null)}>
            取消
          </Button>
          <Button
            onClick={() => void confirmPending()}
            loading={submitting}
            data-testid="file-ops-confirm"
          >
            {pending?.kind === "transfer" ? OP_LABELS[pending.op] : pending?.kind === "create" ? "创建" : "重命名"}
          </Button>
        </Group>
      </Modal>

      <Modal
        opened={!!pending && pending.kind === "delete"}
        onClose={() => setPending(null)}
        title={`移到回收站 ${pending?.kind === "delete" ? pending.sources.length : 0} 项`}
        size="md"
        centered
      >
        <ScrollArea styles={{ viewport: { maxHeight: 160 } }}>
          <Stack gap={2}>
            {pending?.kind === "delete" &&
              pending.sources.map((path) => (
                <Text key={path} size="xs" truncate title={path}>
                  {nameOf(path)}
                </Text>
              ))}
          </Stack>
        </ScrollArea>
        <Text size="xs" c="dimmed" mt="sm">
          项目将移入回收站，可从系统回收站还原。批量操作不是事务：已完成的项不会因后面的失败而回滚。
        </Text>
        {error && (
          <Text size="xs" c="red" mt="xs" data-testid="file-ops-form-error">
            {error}
          </Text>
        )}
        <Group justify="flex-end" mt="md">
          <Button variant="subtle" onClick={() => setPending(null)}>
            取消
          </Button>
          <Button color="red" onClick={() => void confirmPending()} loading={submitting}
            data-testid="file-ops-confirm">
            移到回收站
          </Button>
        </Group>
      </Modal>

      <Modal opened={details} onClose={() => setDetails(false)} title="操作结果明细" size="lg" centered>
        {last && (
          <>
            <ScrollArea h={260}>
              <Stack gap={2}>
                {last.result.items.map((item, index) => (
                  <Group key={`${item.source}-${index}`} gap={6} wrap="nowrap">
                    <Text size="xs" w={72} c={item.outcome === "failed" ? "red" : "dimmed"} inline>
                      {OUTCOME_LABELS[item.outcome]}
                    </Text>
                    <Text size="xs" truncate title={item.source}>
                      {nameOf(item.source)}
                      {item.destination ? ` → ${nameOf(item.destination)}` : ""}
                    </Text>
                    <Text size="xs" c="dimmed" truncate title={item.message ?? ""}>
                      {item.reason ? REASON_LABELS[item.reason] : ""}
                    </Text>
                  </Group>
                ))}
              </Stack>
            </ScrollArea>
            <Group justify="flex-end" mt="md">
              <Button variant="light" onClick={() => void copyReport()}>
                复制清单
              </Button>
              <Button variant="subtle" onClick={() => setDetails(false)}>
                关闭
              </Button>
            </Group>
          </>
        )}
      </Modal>
    </>
  );
}

const LIVE_TEXT = (live: Live): string => {
  if (live.state === "cancelling") return `正在取消：${live.label}`;
  return `${live.label}中…（共 ${live.total} 项${live.current ? `，当前 ${live.current}` : ""}）`;
};

const MODAL_TITLE = (pending: Pending | null): string => {
  switch (pending?.kind) {
    case "rename":
      return `重命名 ${nameOf(pending.path)}`;
    case "create":
      return `在 ${pending.dir} 中新建文件夹`;
    case "transfer":
      return `${OP_LABELS[pending.op]} ${pending.sources.length} 项`;
    default:
      return "";
  }
};

const OUTCOME_LABELS: Record<FileOperationItem["outcome"], string> = {
  completed: "完成",
  renamed: "已改名",
  skipped: "已跳过",
  failed: "失败",
  cancelled: "已取消",
};

const REASON_LABELS: Record<NonNullable<FileOperationItem["reason"]>, string> = {
  "not-found": "找不到项目",
  denied: "没有权限",
  exists: "目标已存在",
  "read-only": "只读",
  "disk-full": "磁盘已满",
  "cancelled-by-shell": "由系统取消",
  unsupported: "系统不支持",
  other: "其他错误",
};
