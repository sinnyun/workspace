/**
 * `plugin-view-tags` — sidebar view (roadmap P6-48, completed by P7-2).
 *
 * Contributes an A icon and a `nav-panel:tags` panel (exclusion is
 * `plugin-layout-views`' job). Tags and their members are this plugin's own data in
 * localStorage (`fm.view-tags.v1`, owned here — no other plugin may read it); the
 * base holds none.
 *
 * What the panel guarantees (docs/plugin-functional/plugin-view-tags.md):
 * create / rename / delete tags and add / remove members; names trimmed and unique
 * case-insensitively; one `{kind,path}` at most per tag; renaming keeps the member
 * list, the expansion state and the selection; deleting asks first, then offers a
 * short undo, and never touches files; empty store and empty tag get different
 * wording; every action reachable by keyboard.
 *
 * Cascade role both ways: clicking a tag publishes
 * `sidebar:selection:changed { kind: "tag" }` (B → C — a pane that understands tags
 * can react; `plugin-file-browser` deliberately ignores kinds it does not own, since
 * only plugins interpret `Ref.kind`), and clicking a member publishes
 * `focus:changed`, which is what drives region D.
 *
 * `focusRef` is read ONLY to offer "添加当前项" — a focus change never touches the
 * member lists by itself.
 *
 * P7-12: tag rows and member rows request the shared context-menu panel
 * (surfaces `tags.tag` / `tags.member`) and register 重命名标签 / 删除标签 /
 * 打开 / 从标签移除 — all reusing the flows below; no menu is drawn here.
 */
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  Pencil,
  Plus,
  RotateCcw,
  Tags,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import {
  Events,
  type ContextMenuContext,
  type Ref,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";

const VIEW_ID = "tags";
const LS_KEY = "fm.view-tags.v1";

interface Member {
  path: string;
  kind: string;
}

/** Where the shared menu panel should anchor, and how it was triggered. */
interface MenuAnchor {
  x: number;
  y: number;
}

type TagStore = Record<string, Member[]>;

/** How long the "撤销删除" window stays open, and how long a light hint shows. */
const UNDO_MS = 8000;
const NOTICE_MS = 4200;

const basename = (p: string): string => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 && idx < p.length - 1 ? p.slice(idx + 1) : p;
};

/** Uniqueness key of a member inside ONE tag: `{kind,path}` (paths stay verbatim —
 *  folding them would merge two genuinely different files on case-sensitive drives). */
const memberKey = (m: Member): string => `${m.kind}\u0000${m.path}`;

const sameMember = (a: Member, b: Member): boolean =>
  a.kind === b.kind && a.path === b.path;

/** Drop blank/non-object entries and duplicate `{kind,path}` pairs. */
function normalizeMembers(raw: unknown): { members: Member[]; repaired: boolean } {
  const members: Member[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(raw)) return { members, repaired: true };
  let repaired = false;
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      repaired = true;
      continue;
    }
    const rec = item as Record<string, unknown>;
    const path = typeof rec.path === "string" ? rec.path.trim() : "";
    const kind = typeof rec.kind === "string" ? rec.kind.trim().toLocaleLowerCase() : "";
    if (!path || !kind) {
      repaired = true;
      continue;
    }
    const key = memberKey({ path, kind });
    if (seen.has(key)) {
      repaired = true;
      continue;
    }
    seen.add(key);
    members.push({ path, kind });
  }
  return { members, repaired };
}

/** Validate + normalize a whole store: names trimmed, case-insensitive duplicates
 *  merged (keeping the first spelling and its position), junk entries discarded. */
function normalizeStore(raw: unknown): { store: TagStore; repaired: boolean } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { store: {}, repaired: true };
  }
  let repaired = false;
  const entries: Array<[string, Member[]]> = [];
  const byFoldedName = new Map<string, number>();
  for (const [rawName, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim();
    const { members, repaired: memberRepaired } = normalizeMembers(value);
    if (!name) {
      repaired = true;
      continue;
    }
    if (memberRepaired) repaired = true;
    const f = name.toLocaleLowerCase();
    const existing = byFoldedName.get(f);
    if (existing !== undefined) {
      // Same tag written twice with different spelling: merge, keep the first name.
      repaired = true;
      const target = entries[existing][1];
      const keys = new Set(target.map(memberKey));
      for (const m of members) {
        if (keys.has(memberKey(m))) continue;
        keys.add(memberKey(m));
        target.push(m);
      }
      continue;
    }
    byFoldedName.set(f, entries.length);
    entries.push([name, members]);
  }
  return { store: Object.fromEntries(entries), repaired };
}

interface Loaded {
  store: TagStore;
  /** The stored JSON could not be read at all: the user gets a recovery hint. */
  corrupt: boolean;
  /** Structure validated but entries had to be cleaned up. */
  repaired: boolean;
  /** `localStorage` is not reachable this session (private mode / quota): the panel
   *  still works, it just cannot remember anything. */
  storageBlocked: boolean;
}

function loadStore(): Loaded {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_KEY);
  } catch {
    return { store: {}, corrupt: false, repaired: false, storageBlocked: true };
  }
  if (raw === null || raw === "") {
    return { store: {}, corrupt: false, repaired: false, storageBlocked: false };
  }
  try {
    const { store, repaired } = normalizeStore(JSON.parse(raw) as unknown);
    return { store, corrupt: false, repaired, storageBlocked: false };
  } catch {
    return { store: {}, corrupt: true, repaired: false, storageBlocked: false };
  }
}

/** The tag currently selected in region B, or null when the selection is not ours. */
const selectedTagOf = (ref: Ref | null): string | null =>
  ref && ref.kind === "tag" ? ref.id : null;

export function RailIcon({ host }: SlotProps) {
  const [active, setActive] = useState(host.getState().activeSidebarView);
  useEffect(() => host.onStateChange((s) => setActive(s.activeSidebarView)), [host]);
  return (
    <button
      type="button"
      className="fm-rail-button"
      aria-label="标签"
      aria-pressed={active === VIEW_ID}
      title="标签"
      onClick={() => host.emit(Events.sidebarViewChanged, { viewId: VIEW_ID })}
      style={railButtonStyle(active === VIEW_ID)}
    >
      <Tags size={19} />
    </button>
  );
}

export function TagsPanel({ host }: SlotProps) {
  const [boot] = useState<Loaded>(loadStore);
  const [store, setStore] = useState<TagStore>(boot.store);
  const [recoveryHint, setRecoveryHint] = useState<string | null>(
    boot.corrupt
      ? "原有的标签记录无法读取，已按空列表恢复。文件与文件夹均未受影响。"
      : boot.repaired
        ? "原有的标签记录含无效或重复内容，已自动清理后加载。文件与文件夹均未受影响。"
        : null,
  );
  const [storageBlocked, setStorageBlocked] = useState(boot.storageBlocked);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  /** Tag whose row is in rename mode, plus the text being typed and why it failed. */
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  /** Tag awaiting delete confirmation (destructive action — docs/09 §3.1). */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<{ tag: string; snapshot: TagStore } | null>(null);
  /** Whole seconds left in the undo window — the countdown text is what makes the
   *  hint feel temporary rather than a second modal. */
  const [undoLeft, setUndoLeft] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  const [focus, setFocus] = useState<Ref | null>(host.getState().focusRef);
  const [selectedTag, setSelectedTag] = useState<string | null>(
    selectedTagOf(host.getState().sidebarSelection),
  );

  const noticeTimer = useRef<number | null>(null);
  const renameInput = useRef<HTMLInputElement | null>(null);
  const focusedRename = useRef<string | null>(null);
  const rowButtons = useRef<Map<string, HTMLButtonElement>>(new Map());
  /** Row that should take focus once the list re-renders (rename/delete move it). */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  useEffect(() => {
    if (!pendingFocus) return;
    rowButtons.current.get(pendingFocus)?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  useEffect(
    () =>
      host.onStateChange((s) => {
        setFocus(s.focusRef);
        setSelectedTag(selectedTagOf(s.sidebarSelection));
      }),
    [host],
  );

  // Focus (and select the text of) the rename input once per tag entering rename mode.
  useEffect(() => {
    if (!renaming) {
      focusedRename.current = null;
      return;
    }
    if (focusedRename.current === renaming.from) return;
    focusedRename.current = renaming.from;
    renameInput.current?.focus();
    renameInput.current?.select();
  }, [renaming]);

  // The undo window ticks down here; deleting again simply restarts it.
  useEffect(() => {
    if (!undoable) {
      setUndoLeft(0);
      return;
    }
    const startedAt = Date.now();
    setUndoLeft(Math.round(UNDO_MS / 1000));
    const id = window.setInterval(() => {
      const leftMs = Math.max(0, UNDO_MS - (Date.now() - startedAt));
      setUndoLeft(Math.ceil(leftMs / 1000));
      if (leftMs === 0) {
        window.clearInterval(id);
        setUndoable(null);
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [undoable]);

  // Timers must not outlive the panel.
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );

  const showNotice = (text: string): void => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice(text);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NOTICE_MS);
  };

  const persist = (next: TagStore): void => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
      setStorageBlocked(false);
    } catch {
      // Storage unavailable: the session stays fully usable, nothing is remembered.
      setStorageBlocked(true);
    }
  };

  const commit = (next: TagStore): void => {
    setStore(next);
    persist(next);
  };

  /** Empty after trimming / case-insensitive duplicate → Chinese reason, else null. */
  const nameProblem = (candidate: string, except?: string): string | null => {
    const name = candidate.trim();
    if (!name) return "标签名不能为空（去掉首尾空格后没有内容）。";
    const f = name.toLocaleLowerCase();
    for (const existing of Object.keys(store)) {
      if (existing === except) continue;
      if (existing.toLocaleLowerCase() === f) {
        return `已存在同名标签「${existing}」，标签名不区分大小写。`;
      }
    }
    return null;
  };

  const addTag = (): void => {
    const name = draft.trim();
    const problem = nameProblem(draft);
    if (problem) {
      setDraftError(problem);
      return;
    }
    commit({ ...store, [name]: [] });
    setDraft("");
    setDraftError(null);
    setExpanded((prev) => new Set(prev).add(name));
    showNotice(`已创建标签「${name}」。`);
  };

  /** Rename keeps members, the expansion state and (if selected) the B cascade. */
  const commitRename = (): void => {
    if (!renaming) return;
    const from = renaming.from;
    const name = renaming.value.trim();
    const problem = nameProblem(renaming.value, from);
    if (problem) {
      setRenameProblem(problem);
      return;
    }
    if (name === from) {
      setRenaming(null);
      setRenameProblem(null);
      return;
    }
    const next: TagStore = {};
    for (const [tag, members] of Object.entries(store)) {
      next[tag === from ? name : tag] = members;
    }
    commit(next);
    setExpanded((prev) => {
      if (!prev.has(from)) return prev;
      const settled = new Set(prev);
      settled.delete(from);
      settled.add(name);
      return settled;
    });
    setPendingDelete((prev) => (prev === from ? name : prev));
    setRenaming(null);
    setRenameProblem(null);
    setPendingFocus(name);
    if (selectedTag === from) {
      host.emit(Events.sidebarSelectionChanged, {
        kind: "tag",
        id: name,
        sourcePlugin: host.name,
      } satisfies Ref);
    }
    showNotice(`标签已重命名为「${name}」，${(store[from] ?? []).length} 个成员保持不变。`);
  };

  const addFocusToTag = (tag: string): void => {
    if (!focus) return;
    const path = focus.id.trim();
    const kind = focus.kind.trim().toLocaleLowerCase();
    if (!path || !kind) {
      showNotice("当前选中项无法加入标签。");
      return;
    }
    const members = store[tag] ?? [];
    const candidate: Member = { path, kind };
    if (members.some((m) => sameMember(m, candidate))) {
      // Same {kind,path} may appear only once per tag: hint, no second record.
      showNotice(`「${basename(path)}」已在此标签中，未重复添加。`);
      return;
    }
    commit({ ...store, [tag]: [...members, candidate] });
  };

  const removeMember = (tag: string, target: Member): void => {
    const next = { ...store, [tag]: (store[tag] ?? []).filter((m) => !sameMember(m, target)) };
    commit(next);
  };

  const deleteTag = (tag: string): void => {
    const snapshot = store;
    const next = { ...store };
    delete next[tag];
    commit(next);
    setPendingDelete(null);
    setRenaming((prev) => (prev?.from === tag ? null : prev));
    setExpanded((prev) => {
      if (!prev.has(tag)) return prev;
      const settled = new Set(prev);
      settled.delete(tag);
      return settled;
    });
    const names = Object.keys(store);
    const at = names.indexOf(tag);
    setPendingFocus(names[at + 1] ?? names[at - 1] ?? null);
    if (selectedTag === tag) {
      host.emit(Events.sidebarSelectionChanged, null);
    }
    setUndoable({ tag, snapshot });
  };

  const undoDelete = (): void => {
    if (!undoable) return;
    commit(undoable.snapshot);
    setExpanded((prev) => new Set(prev).add(undoable.tag));
    setPendingFocus(undoable.tag);
    setUndoable(null);
    showNotice(`已恢复标签「${undoable.tag}」及其成员关联。`);
  };

  const toggleTag = (tag: string): void => {
    const opening = !expanded.has(tag);
    setExpanded((prev) => {
      const settled = new Set(prev);
      if (opening) settled.add(tag);
      else settled.delete(tag);
      return settled;
    });
    host.emit(Events.sidebarSelectionChanged, {
      kind: "tag",
      id: tag,
      sourcePlugin: host.name,
    } satisfies Ref);
  };

  /** 行内重命名入口：铅笔按钮、F2 与右键菜单项共用同一条路径（校验留在原处）。 */
  const startRename = (tag: string): void => {
    setRenaming({ from: tag, value: tag });
    setRenameProblem(null);
  };

  /** 删除入口：只打开既有确认区，确认/撤销逻辑不变。 */
  const requestDelete = (tag: string): void => {
    setPendingDelete(tag);
  };

  /** 成员行左键 = 发布焦点；右键收敛与「打开」菜单项走同一条路径。 */
  const openMember = (m: Member): void => {
    host.emit(Events.focusChanged, {
      kind: m.kind,
      id: m.path,
      sourcePlugin: host.name,
    } satisfies Ref);
  };

  // —— 右键菜单（P7-12）：项只随挂载注册一次，动作永远读最新状态 ——
  /** The freshest handler bundle + store for the menu's `execute` callbacks:
   *  a menu action must never act on the snapshot captured at registration. */
  const latest = useRef({ store, startRename, requestDelete, openMember, removeMember });
  latest.current = { store, startRename, requestDelete, openMember, removeMember };

  /** The panel context carries only the member Ref; the same member can live in
   *  several tags, so a `tags.member` menu records the tag it was opened from. */
  const memberMenuTag = useRef<{ tag: string; path: string; kind: string } | null>(null);

  const menuContext = (
    surfaceId: string,
    targetKind: string | null,
    targetRef: Ref | null,
    anchor: MenuAnchor,
    trigger: "pointer" | "keyboard",
  ): ContextMenuContext => ({
    surfaceId,
    targetKind,
    targetRef,
    selectedRefs: targetRef ? [targetRef] : [],
    sessionId: host.getState().activeTabId,
    anchor,
    trigger,
  });

  const openTagMenu = (name: string, anchor: MenuAnchor, trigger: "pointer" | "keyboard"): void => {
    const cm = host.contextMenu;
    if (!cm) return;
    const ref: Ref = { kind: "tag", id: name, sourcePlugin: host.name };
    // 目标不是当前选中标签时，先按左键的协调事件把它收敛为选中项（不切换展开态）。
    if (selectedTag !== name) host.emit(Events.sidebarSelectionChanged, ref);
    cm.open(menuContext("tags.tag", "tag", ref, anchor, trigger));
  };

  const openMemberMenu = (
    tag: string,
    m: Member,
    anchor: MenuAnchor,
    trigger: "pointer" | "keyboard",
  ): void => {
    const cm = host.contextMenu;
    if (!cm) return;
    const ref: Ref = { kind: m.kind, id: m.path, sourcePlugin: host.name };
    if (focus?.id !== m.path || focus?.kind !== m.kind) openMember(m);
    memberMenuTag.current = { tag, path: m.path, kind: m.kind };
    cm.open(menuContext("tags.member", m.kind, ref, anchor, trigger));
  };

  useEffect(() => {
    const cm = host.contextMenu;
    if (!cm) return;
    const tagFromContext = (ctx: ContextMenuContext): string => {
      const name = ctx.targetRef?.id ?? "";
      return Object.prototype.hasOwnProperty.call(latest.current.store, name) ? name : "";
    };
    const unregisters = [
      cm.registerItem({
        id: "tags.rename",
        label: "重命名标签",
        order: 10,
        shortcut: "F2",
        when: (ctx) => ctx.surfaceId === "tags.tag",
        execute: (ctx) => {
          const name = tagFromContext(ctx);
          if (name) latest.current.startRename(name);
        },
      }),
      cm.registerItem({
        id: "tags.delete",
        label: "删除标签",
        order: 20,
        shortcut: "Delete",
        when: (ctx) => ctx.surfaceId === "tags.tag",
        execute: (ctx) => {
          const name = tagFromContext(ctx);
          if (name) latest.current.requestDelete(name);
        },
      }),
      cm.registerItem({
        id: "tags.openMember",
        label: "打开",
        order: 10,
        when: (ctx) => ctx.surfaceId === "tags.member",
        execute: (ctx) => {
          const ref = ctx.targetRef;
          if (!ref) return;
          latest.current.openMember({ path: ref.id, kind: ref.kind });
        },
      }),
      cm.registerItem({
        id: "tags.removeMember",
        label: "从标签移除",
        order: 20,
        when: (ctx) => ctx.surfaceId === "tags.member",
        execute: (ctx) => {
          const ref = ctx.targetRef;
          if (!ref) return;
          const member: Member = { path: ref.id, kind: ref.kind };
          const origin = memberMenuTag.current;
          const tag =
            origin && origin.path === member.path && origin.kind === member.kind
              ? origin.tag
              : (Object.keys(latest.current.store).find((t) =>
                  (latest.current.store[t] ?? []).some((x) => sameMember(x, member)),
                ) ?? "");
          if (tag) latest.current.removeMember(tag, member);
        },
      }),
    ];
    return () => {
      for (const off of unregisters) off();
    };
  }, [host]);

  /** Keyboard: Enter/Space toggles + selects (native button), arrows move between
   *  rows, F2 renames, Delete asks for deletion, menu key/Shift+F10 opens the
   *  shared context menu on the focused row. */
  const onRowKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tag: string): void => {
    const names = Object.keys(store);
    const at = names.indexOf(tag);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!names.length) return;
      const step = event.key === "ArrowDown" ? 1 : names.length - 1;
      const neighbour = names[(at + step) % names.length];
      rowButtons.current.get(neighbour)?.focus();
      return;
    }
    if (event.key === "F2") {
      event.preventDefault();
      startRename(tag);
      return;
    }
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      if (!host.contextMenu) return;
      const rect = event.currentTarget.getBoundingClientRect();
      openTagMenu(tag, { x: rect.left + 12, y: rect.bottom }, "keyboard");
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      requestDelete(tag);
      return;
    }
    if (event.key === "Escape" && pendingDelete === tag) {
      event.preventDefault();
      setPendingDelete(null);
    }
  };

  const names = Object.keys(store);
  const focusName = focus ? basename(focus.id) : null;

  return (
    <Stack gap={6} className="fm-nav-panel">
      <Group gap={6} className="fm-nav-heading" justify="space-between" wrap="nowrap">
        <Text span size="xs" fw={650} title={LS_KEY}>
          标签
        </Text>
        <Text span size="xs" c="dimmed">
          共 {names.length} 个
        </Text>
      </Group>

      {(recoveryHint || storageBlocked) && (
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="orange" style={{ flex: 1, minWidth: 0 }}>
            {recoveryHint ?? "本地存储不可用：本次会话仍可正常操作标签，但不会记住。"}
          </Text>
          {recoveryHint && (
            <ActionIcon
              size="xs"
              variant="subtle"
              color="gray"
              aria-label="关闭提示"
              title="关闭提示"
              onClick={() => setRecoveryHint(null)}
            >
              <X size={12} />
            </ActionIcon>
          )}
        </Group>
      )}

      <Group gap={4} wrap="nowrap">
        <TextInput
          size="xs"
          aria-label="新标签名"
          placeholder="新标签名"
          value={draft}
          error={draftError ?? undefined}
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => {
            setDraft(e.target.value);
            if (draftError) setDraftError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
            if (e.key === "Escape") {
              setDraft("");
              setDraftError(null);
            }
          }}
        />
        <Button size="xs" variant="light" leftSection={<Plus size={13} />} onClick={addTag}>
          新建
        </Button>
      </Group>

      {!names.length && (
        <Text size="xs" c="dimmed">
          还没有任何标签。在上方输入名称后按回车即可创建第一个标签。
        </Text>
      )}

      {names.map((name) => {
        const members = store[name] ?? [];
        const isOpen = expanded.has(name);
        const isSelected = selectedTag === name;
        const isRenaming = renaming?.from === name;
        return (
          <div
            key={name}
            onContextMenu={(event) => {
              // 标签行区域（含行内重命名）：右键只请共享面板，成员行会自行拦截。
              if (!host.contextMenu) return;
              event.preventDefault();
              openTagMenu(name, { x: event.clientX, y: event.clientY }, "pointer");
            }}
          >
            {renaming?.from === name ? (
              <Stack gap={2}>
                <Group gap={4} wrap="nowrap">
                  <TextInput
                    size="xs"
                    aria-label="重命名标签"
                    ref={renameInput}
                    style={{ flex: 1, minWidth: 0 }}
                    value={renaming.value}
                    error={renameProblem ?? undefined}
                    onChange={(e) => {
                      setRenaming({ from: name, value: e.target.value });
                      setRenameProblem(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitRename();
                      }
                      if (e.key === "Escape") {
                        e.preventDefault();
                        setRenaming(null);
                        setRenameProblem(null);
                        setPendingFocus(name);
                      }
                    }}
                  />
                  <Button size="xs" variant="light" onClick={commitRename}>
                    保存
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => {
                      setRenaming(null);
                      setRenameProblem(null);
                      setPendingFocus(name);
                    }}
                  >
                    取消
                  </Button>
                </Group>
              </Stack>
            ) : (
              <Group gap={2} className="fm-nav-row" wrap="nowrap">
                <UnstyledButton
                  aria-label={`标签 ${name}`}
                  aria-expanded={isOpen}
                  aria-pressed={isSelected}
                  title={isOpen ? `标签「${name}」· 点击收起` : `标签「${name}」· 点击展开并选中`}
                  aria-controls={`tag-members-${safeId(name)}`}
                  onKeyDown={(e) => onRowKeyDown(e, name)}
                  onClick={() => toggleTag(name)}
                  ref={(node) => {
                    if (node) rowButtons.current.set(name, node);
                    else rowButtons.current.delete(name);
                  }}
                  style={{
                    ...rowButtonStyle,
                    color: isSelected ? "var(--mantine-primary-color-filled)" : undefined,
                    background: isSelected ? "var(--mantine-color-default-hover)" : undefined,
                    fontWeight: isSelected ? 650 : undefined,
                  }}
                >
                  {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <Text span truncate style={{ flex: 1, minWidth: 0 }}>
                    {name}
                  </Text>
                  <Badge size="xs" variant="light" color={members.length ? "blue" : "gray"}>
                    {members.length}
                  </Badge>
                </UnstyledButton>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  aria-label="重命名标签"
                  title="重命名标签"
                  onClick={() => startRename(name)}
                >
                  <Pencil size={12} />
                </ActionIcon>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="red"
                  aria-label="删除标签"
                  title="删除标签（只删关联，不删文件）"
                  onClick={() => requestDelete(name)}
                >
                  <X size={12} />
                </ActionIcon>
              </Group>
            )}

            {pendingDelete === name && (
              <Stack gap={4} style={calloutStyle}>
                <Text size="xs">
                  删除标签「{name}」只会移除它的 {members.length} 条成员关联，不会删除任何文件或文件夹。
                </Text>
                <Group gap={4}>
                  <Button size="xs" variant="light" color="red" onClick={() => deleteTag(name)}>
                    确认删除
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    autoFocus
                    onClick={() => {
                      setPendingDelete(null);
                      setPendingFocus(name);
                    }}
                  >
                    取消
                  </Button>
                </Group>
              </Stack>
            )}

            {isOpen && !isRenaming && (
              <Stack gap={2} id={`tag-members-${safeId(name)}`} pl="md">
                <Tooltip
                  label={focusName ? `把当前选中的「${focusName}」加入此标签` : "先在主视图选中文件或文件夹"}
                  withArrow
                  openDelay={300}
                >
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<Plus size={12} />}
                    disabled={!focus}
                    title={focusName ?? "暂无选中项"}
                    onClick={() => addFocusToTag(name)}
                  >
                    添加当前项
                  </Button>
                </Tooltip>

                {!members.length && (
                  <Text size="xs" c="dimmed">
                    此标签还没有成员。在主视图选中文件或文件夹后点「添加当前项」。
                  </Text>
                )}

                {members.map((m) => (
                  <Group
                    key={memberKey(m)}
                    gap={2}
                    className="fm-nav-row"
                    wrap="nowrap"
                    onContextMenu={(event) => {
                      // 成员行：拦截标签行的冒泡处理，改为 tags.member 上下文。
                      if (!host.contextMenu) return;
                      event.preventDefault();
                      event.stopPropagation();
                      openMemberMenu(name, m, { x: event.clientX, y: event.clientY }, "pointer");
                    }}
                  >
                    <Tooltip label={basename(m.path)} withArrow openDelay={300}>
                      <UnstyledButton
                        aria-label={`打开成员 ${basename(m.path)}`}
                        title={m.path}
                        style={rowButtonStyle}
                        onClick={() => openMember(m)}
                        onKeyDown={(event) => {
                          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                            event.preventDefault();
                            if (!host.contextMenu) return;
                            const rect = event.currentTarget.getBoundingClientRect();
                            openMemberMenu(name, m, { x: rect.left + 12, y: rect.bottom }, "keyboard");
                          }
                        }}
                      >
                        {m.kind === "folder" ? <Folder size={13} /> : <FileText size={13} />}
                        <Text span truncate style={{ flex: 1, minWidth: 0 }}>
                          {basename(m.path)}
                        </Text>
                      </UnstyledButton>
                    </Tooltip>
                    <ActionIcon
                      size="xs"
                      variant="subtle"
                      color="gray"
                      aria-label="从标签移出"
                      title="从当前标签移出（不删除文件）"
                      onClick={() => removeMember(name, m)}
                    >
                      <X size={12} />
                    </ActionIcon>
                  </Group>
                ))}
              </Stack>
            )}
          </div>
        );
      })}

      {undoable && (
        <Group gap={4} wrap="nowrap" style={calloutStyle}>
          <Text size="xs" style={{ flex: 1, minWidth: 0 }}>
            已删除标签「{undoable.tag}」，只移除了 {(undoable.snapshot[undoable.tag] ?? []).length}{" "}
            条成员关联，任何文件或文件夹都未被删除。{undoLeft > 0 && `（${undoLeft} 秒内可撤销）`}
          </Text>
          <Button
            size="xs"
            variant="light"
            leftSection={<RotateCcw size={12} />}
            onClick={undoDelete}
          >
            撤销
          </Button>
        </Group>
      )}

      {notice && (
        <Text size="xs" c="blue">
          {notice}
        </Text>
      )}
    </Stack>
  );
}

/** `aria-controls` needs an id-safe slug; the real name stays in the visible text. */
const safeId = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

const railButtonStyle = (active: boolean): CSSProperties => ({
  display: "block",
  width: 40,
  height: 40,
  margin: "2px auto",
  fontSize: 16,
  cursor: "pointer",
  borderRadius: "var(--mantine-radius-md)",
  border: "none",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
});

const rowButtonStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 6,
  textAlign: "left",
  fontSize: 12,
  padding: "6px 6px",
  cursor: "pointer",
};

const calloutStyle: CSSProperties = {
  border: "1px solid var(--mantine-color-default-border)",
  borderRadius: "var(--mantine-radius-md)",
  background: "var(--mantine-color-default-hover)",
  padding: "6px 8px",
  fontSize: 12,
};
