/**
 * `plugin-view-tags` — sidebar view and the tags store's owner (P7-32).
 *
 * Contributes an A icon and a `nav-panel:tags` panel (exclusion is
 * `plugin-layout-views`' job). Tags and members live in the generic `db.tags`
 * store — this plugin is its ONLY writer; other plugins read through the SDK
 * contract (`listTags` / `parseTagRows`) and follow `tags:updated` (docs/09
 * §3.4). Every successful write emits that event; a failed write says so and
 * reloads the store's truth. The legacy localStorage key (`fm.view-tags.v1`) is
 * imported once into an empty store, then removed.
 *
 * What the panel guarantees (docs/plugin-functional/plugin-view-tags.md):
 * create / rename / delete tags and add / remove members; names trimmed and unique
 * case-insensitively; one path at most per tag (the kind is a refreshed property,
 * not part of a member's identity); renaming keeps the member list, the expansion
 * state and the selection; deleting asks first, then offers a short undo, and
 * never touches files; empty store and empty tag get different wording; every
 * action is reachable by keyboard.
 *
 * Cascade role both ways: clicking a tag publishes
 * `sidebar:selection:changed { kind: "tag" }` (B → C — `plugin-file-browser`
 * opens its tag view from it), and clicking a member publishes `focus:changed`,
 * which is what drives region D.
 *
 * `focusRef` is read ONLY to offer "添加当前项" — a focus change never touches the
 * member lists by itself.
 *
 * P7-12: tag rows and member rows request the shared context-menu panel
 * (surfaces `tags.tag` / `tags.member`) and register 重命名标签 / 删除标签 /
 * 打开 / 从标签移除 — all reusing the flows below; no menu is drawn here.
 */

import { ActionIcon, Badge, Button, Group, Stack, Text, TextInput, Tooltip, UnstyledButton } from "@mantine/core";
import {
  type ContextMenuContext,
  Events,
  errorMessage,
  listTags,
  type PluginHost,
  type Ref,
  type SlotProps,
  type TagMember,
  type TagRecord,
} from "@my-file-manager/plugin-sdk";
import { ChevronDown, ChevronRight, FileText, Folder, Pencil, Plus, RotateCcw, Tags, X } from "lucide-react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useRef, useState } from "react";

const VIEW_ID = "tags";
/** Legacy (pre-P7-32) localStorage key — imported once into an empty store. */
const LEGACY_LS_KEY = "fm.view-tags.v1";

/** Where the shared menu panel should anchor, and how it was triggered. */
interface MenuAnchor {
  x: number;
  y: number;
}

/** How long the "撤销删除" window stays open, and how long a light hint shows. */
const UNDO_MS = 8000;
const NOTICE_MS = 4200;

const basename = (p: string): string => {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx >= 0 && idx < p.length - 1 ? p.slice(idx + 1) : p;
};

/** The JSON value stored under a tag's key: `{seq, members}` — the key is the name. */
const recordValue = (rec: TagRecord): { seq: number; members: TagMember[] } => ({
  seq: rec.seq,
  members: rec.members,
});

/** Creation order = one past the highest existing seq (records keep their seq on rename). */
const nextSeq = (tags: TagRecord[]): number => (tags.length ? Math.max(...tags.map((t) => t.seq)) + 1 : 0);

/** Validate + normalize the legacy localStorage shape (`Record<name, {path,kind}[]>`):
 *  names trimmed, case-insensitive duplicates merged (keeping the first spelling and
 *  its position), junk discarded, one entry per path inside a tag. Returns null when
 *  the value is not a store-shaped object at all. */
function normalizeLegacy(raw: unknown): { records: TagRecord[]; repaired: boolean } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  let repaired = false;
  const records: TagRecord[] = [];
  const byFoldedName = new Map<string, TagRecord>();
  for (const [rawName, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name) {
      repaired = true;
      continue;
    }
    const members: TagMember[] = [];
    const seen = new Set<string>();
    if (Array.isArray(value)) {
      for (const item of value) {
        if (!item || typeof item !== "object") {
          repaired = true;
          continue;
        }
        const rec = item as Record<string, unknown>;
        const path = typeof rec.path === "string" ? rec.path.trim() : "";
        const kind = typeof rec.kind === "string" ? rec.kind.trim().toLocaleLowerCase() : "";
        if (!path || !kind || seen.has(path)) {
          repaired = true;
          continue;
        }
        seen.add(path);
        members.push({ path, kind });
      }
    } else {
      repaired = true;
    }
    const f = name.toLocaleLowerCase();
    const existing = byFoldedName.get(f);
    if (existing) {
      // Same tag written twice with different spelling: merge, keep the first name.
      repaired = true;
      for (const m of members) {
        if (existing.members.some((x) => x.path === m.path)) continue;
        existing.members.push(m);
      }
      continue;
    }
    const record: TagRecord = { name, seq: records.length, members };
    byFoldedName.set(f, record);
    records.push(record);
  }
  return { records, repaired };
}

/** One-time migration (P7-32): import the legacy localStorage store into an empty
 *  `db.tags` store, then remove the old key. Any failed write rolls back the rows
 *  already written, so a half-import can never masquerade as the truth. Returns
 *  null when there is nothing to import; otherwise the imported records plus the
 *  hint to show (a corrupt legacy value is reported, not deleted). */
async function importLegacy(host: PluginHost): Promise<{ records: TagRecord[]; hint: string } | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LEGACY_LS_KEY);
  } catch {
    return null;
  }
  if (raw === null || raw === "") return null;
  let parsed: { records: TagRecord[]; repaired: boolean } | null = null;
  try {
    parsed = normalizeLegacy(JSON.parse(raw) as unknown);
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return { records: [], hint: "旧版本的本地标签记录无法读取，未导入。文件与文件夹均未受影响。" };
  }
  const written: string[] = [];
  try {
    for (const rec of parsed.records) {
      await host.invoke("db.tags.put", { key: rec.name, value: recordValue(rec) });
      written.push(rec.name);
    }
  } catch (err) {
    for (const name of written) {
      try {
        await host.invoke("db.tags.delete", { key: name });
      } catch {
        /* the store is already failing; the reload below surfaces it */
      }
    }
    throw err;
  }
  try {
    localStorage.removeItem(LEGACY_LS_KEY);
  } catch {
    /* key kept, db is the truth now */
  }
  return {
    records: parsed.records,
    hint: parsed.repaired
      ? "旧版本地标签已导入；其中无效或重复的内容已自动清理。文件与文件夹均未受影响。"
      : "已将旧版本的本地标签导入新的存储。",
  };
}

/** The tag currently selected in region B, or null when the selection is not ours. */
const selectedTagOf = (ref: Ref | null): string | null => (ref && ref.kind === "tag" ? ref.id : null);

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
  const [tags, setTags] = useState<TagRecord[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  /** Raw failure text for hover only — the visible copy stays Chinese. */
  const [loadErrorDetail, setLoadErrorDetail] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);
  const [recoveryHint, setRecoveryHint] = useState<string | null>(null);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  /** Tag whose row is in rename mode, plus the text being typed and why it failed. */
  const [renaming, setRenaming] = useState<{ from: string; value: string } | null>(null);
  const [renameProblem, setRenameProblem] = useState<string | null>(null);
  /** Tag awaiting delete confirmation (destructive action — docs/09 §3.1). */
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [undoable, setUndoable] = useState<{ record: TagRecord } | null>(null);
  /** Whole seconds left in the undo window — the countdown text is what makes the
   *  hint feel temporary rather than a second modal. */
  const [undoLeft, setUndoLeft] = useState(0);
  const [notice, setNotice] = useState<{ text: string; warn: boolean; hover?: string } | null>(null);

  const [focus, setFocus] = useState<Ref | null>(host.getState().focusRef);
  const [selectedTag, setSelectedTag] = useState<string | null>(selectedTagOf(host.getState().sidebarSelection));

  const noticeTimer = useRef<number | null>(null);
  const renameInput = useRef<HTMLInputElement | null>(null);
  const focusedRename = useRef<string | null>(null);
  const rowButtons = useRef<Map<string, HTMLButtonElement>>(new Map());
  /** Row that should take focus once the list re-renders (rename/delete move it). */
  const [pendingFocus, setPendingFocus] = useState<string | null>(null);

  // Boot (and retry): read the store; an empty store may import the legacy key once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: retrySeq 只是重试信号——递增它就是为了让本效果重跑
  useEffect(() => {
    let cancelled = false;
    setStatus("loading");
    void (async () => {
      try {
        const records = await listTags(host);
        if (cancelled) return;
        const legacy = records.length === 0 ? await importLegacy(host) : null;
        if (cancelled) return;
        if (legacy) {
          setTags(legacy.records);
          setRecoveryHint(legacy.hint);
          if (legacy.records.length) host.emit(Events.tagsUpdated);
        } else {
          setTags(records);
        }
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setLoadErrorDetail(errorMessage(err));
        setStatus("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [host, retrySeq]);

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

  const showNotice = (text: string, opts?: { warn?: boolean; hover?: string }): void => {
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    setNotice({ text, warn: opts?.warn ?? false, hover: opts?.hover });
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NOTICE_MS);
  };

  /** A write failed: say so, then re-read the store's truth (the attempt may have
   *  half-applied). The event fires because the store may have changed under the
   *  failed attempt — consumers must re-query just in case. */
  const writeFailed = async (err: unknown): Promise<void> => {
    showNotice("保存失败：标签存储暂时不可用，已重新载入最新数据。", { warn: true, hover: errorMessage(err) });
    host.emit(Events.tagsUpdated);
    try {
      setTags(await listTags(host));
      setStatus("ready");
    } catch (reloadErr) {
      setLoadErrorDetail(errorMessage(reloadErr));
      setStatus("error");
    }
  };

  /** Empty after trimming / case-insensitive duplicate → Chinese reason, else null. */
  const nameProblem = (candidate: string, except?: string): string | null => {
    const name = candidate.trim();
    if (!name) return "标签名不能为空（去掉首尾空格后没有内容）。";
    const f = name.toLocaleLowerCase();
    for (const t of tags) {
      if (t.name === except) continue;
      if (t.name.toLocaleLowerCase() === f) {
        return `已存在同名标签「${t.name}」，标签名不区分大小写。`;
      }
    }
    return null;
  };

  const addTag = async (): Promise<void> => {
    if (status !== "ready") return;
    const name = draft.trim();
    const problem = nameProblem(draft);
    if (problem) {
      setDraftError(problem);
      return;
    }
    const rec: TagRecord = { name, seq: nextSeq(tags), members: [] };
    try {
      await host.invoke("db.tags.put", { key: rec.name, value: recordValue(rec) });
    } catch (err) {
      await writeFailed(err);
      return;
    }
    setTags([...tags, rec]);
    setDraft("");
    setDraftError(null);
    setExpanded((prev) => new Set(prev).add(name));
    host.emit(Events.tagsUpdated);
    showNotice(`已创建标签「${name}」。`);
  };

  /** Rename keeps members, the expansion state, the seq and (if selected) the B cascade. */
  const commitRename = async (): Promise<void> => {
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
    const rec = tags.find((t) => t.name === from);
    if (!rec) {
      setRenaming(null);
      return;
    }
    try {
      await host.invoke("db.tags.put", { key: name, value: recordValue(rec) });
    } catch (err) {
      await writeFailed(err);
      return;
    }
    try {
      await host.invoke("db.tags.delete", { key: from });
    } catch (err) {
      // The new key landed but the old one did not go away: roll the new key back
      // so the store never quietly holds both names; a failed rollback stays
      // visible through the reload.
      try {
        await host.invoke("db.tags.delete", { key: name });
      } catch {
        /* writeFailed's reload shows the truth either way */
      }
      await writeFailed(err);
      return;
    }
    setTags(tags.map((t) => (t.name === from ? { ...t, name } : t)));
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
    host.emit(Events.tagsUpdated);
    showNotice(`标签已重命名为「${name}」，${rec.members.length} 个成员保持不变。`);
  };

  const addFocusToTag = async (tagName: string): Promise<void> => {
    if (!focus) return;
    const path = focus.id.trim();
    const kind = focus.kind.trim().toLocaleLowerCase();
    if (!path || !kind) {
      showNotice("当前选中项无法加入标签。");
      return;
    }
    const rec = tags.find((t) => t.name === tagName);
    if (!rec) return;
    if (rec.members.some((m) => m.path === path)) {
      // A path may appear only once per tag: hint, no second record.
      showNotice(`「${basename(path)}」已在此标签中，未重复添加。`);
      return;
    }
    const next: TagRecord = { ...rec, members: [...rec.members, { path, kind }] };
    try {
      await host.invoke("db.tags.put", { key: next.name, value: recordValue(next) });
    } catch (err) {
      await writeFailed(err);
      return;
    }
    setTags(tags.map((t) => (t.name === tagName ? next : t)));
    host.emit(Events.tagsUpdated);
  };

  const removeMember = async (tagName: string, target: TagMember): Promise<void> => {
    const rec = tags.find((t) => t.name === tagName);
    if (!rec) return;
    const next: TagRecord = { ...rec, members: rec.members.filter((m) => m.path !== target.path) };
    try {
      await host.invoke("db.tags.put", { key: next.name, value: recordValue(next) });
    } catch (err) {
      await writeFailed(err);
      return;
    }
    setTags(tags.map((t) => (t.name === tagName ? next : t)));
    host.emit(Events.tagsUpdated);
  };

  const deleteTag = async (tagName: string): Promise<void> => {
    const rec = tags.find((t) => t.name === tagName);
    if (!rec) return;
    try {
      await host.invoke("db.tags.delete", { key: tagName });
    } catch (err) {
      await writeFailed(err);
      return;
    }
    setTags(tags.filter((t) => t.name !== tagName));
    setPendingDelete(null);
    setRenaming((prev) => (prev?.from === tagName ? null : prev));
    setExpanded((prev) => {
      if (!prev.has(tagName)) return prev;
      const settled = new Set(prev);
      settled.delete(tagName);
      return settled;
    });
    const names = tags.map((t) => t.name);
    const at = names.indexOf(tagName);
    setPendingFocus(names[at + 1] ?? names[at - 1] ?? null);
    if (selectedTag === tagName) {
      host.emit(Events.sidebarSelectionChanged, null);
    }
    host.emit(Events.tagsUpdated);
    setUndoable({ record: rec });
  };

  const undoDelete = async (): Promise<void> => {
    if (!undoable) return;
    const rec = undoable.record;
    if (tags.some((t) => t.name === rec.name)) {
      // A same-named tag appeared inside the undo window: restoring would clobber it.
      setUndoable(null);
      showNotice(`未能撤销：已存在同名标签「${rec.name}」。`);
      return;
    }
    try {
      await host.invoke("db.tags.put", { key: rec.name, value: recordValue(rec) });
    } catch (err) {
      await writeFailed(err);
      return;
    }
    setTags([...tags, rec].sort((a, b) => a.seq - b.seq));
    setExpanded((prev) => new Set(prev).add(rec.name));
    setPendingFocus(rec.name);
    setUndoable(null);
    host.emit(Events.tagsUpdated);
    showNotice(`已恢复标签「${rec.name}」及其成员关联。`);
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
  const openMember = (m: TagMember): void => {
    host.emit(Events.focusChanged, {
      kind: m.kind,
      id: m.path,
      sourcePlugin: host.name,
    } satisfies Ref);
  };

  // —— 右键菜单（P7-12）：项只随挂载注册一次，动作永远读最新状态 ——
  /** The freshest handler bundle + tags for the menu's `execute` callbacks:
   *  a menu action must never act on the snapshot captured at registration. */
  const latest = useRef({ tags, startRename, requestDelete, openMember, removeMember });
  latest.current = { tags, startRename, requestDelete, openMember, removeMember };

  /** The panel context carries only the member Ref; the same path can live in
   *  several tags, so a `tags.member` menu records the tag it was opened from. */
  const memberMenuTag = useRef<{ tag: string; path: string } | null>(null);

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

  const openMemberMenu = (tag: string, m: TagMember, anchor: MenuAnchor, trigger: "pointer" | "keyboard"): void => {
    const cm = host.contextMenu;
    if (!cm) return;
    const ref: Ref = { kind: m.kind, id: m.path, sourcePlugin: host.name };
    if (focus?.id !== m.path || focus?.kind !== m.kind) openMember(m);
    memberMenuTag.current = { tag, path: m.path };
    cm.open(menuContext("tags.member", m.kind, ref, anchor, trigger));
  };

  useEffect(() => {
    const cm = host.contextMenu;
    if (!cm) return;
    const tagFromContext = (ctx: ContextMenuContext): string => {
      const name = ctx.targetRef?.id ?? "";
      return latest.current.tags.some((t) => t.name === name) ? name : "";
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
          const member: TagMember = { path: ref.id, kind: ref.kind };
          const origin = memberMenuTag.current;
          const tag =
            origin && origin.path === member.path
              ? origin.tag
              : (latest.current.tags.find((t) => t.members.some((x) => x.path === member.path))?.name ?? "");
          if (tag) void latest.current.removeMember(tag, member);
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
    const names = tags.map((t) => t.name);
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

  const focusName = focus ? basename(focus.id) : null;

  return (
    <Stack gap={6} className="fm-nav-panel">
      <Group gap={6} className="fm-nav-heading" justify="space-between" wrap="nowrap">
        <Text span size="xs" fw={650} title="存储：db.tags">
          标签
        </Text>
        <Text span size="xs" c="dimmed">
          共 {tags.length} 个
        </Text>
      </Group>

      {recoveryHint && (
        <Group gap={4} wrap="nowrap">
          <Text size="xs" c="orange" style={{ flex: 1, minWidth: 0 }}>
            {recoveryHint}
          </Text>
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
        </Group>
      )}

      <Group gap={4} wrap="nowrap">
        <TextInput
          size="xs"
          aria-label="新标签名"
          placeholder="新标签名"
          value={draft}
          disabled={status !== "ready"}
          error={draftError ?? undefined}
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => {
            setDraft(e.target.value);
            if (draftError) setDraftError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addTag();
            }
            if (e.key === "Escape") {
              setDraft("");
              setDraftError(null);
            }
          }}
        />
        <Button
          size="xs"
          variant="light"
          leftSection={<Plus size={13} />}
          disabled={status !== "ready"}
          onClick={() => void addTag()}
        >
          新建
        </Button>
      </Group>

      {status === "loading" && (
        <Text size="xs" c="dimmed">
          正在载入标签…
        </Text>
      )}

      {status === "error" && (
        <Stack gap={4} style={calloutStyle}>
          <Text size="xs" c="red" title={loadErrorDetail ?? undefined}>
            标签存储暂时不可用：无法读取或保存标签，请稍后重试。
          </Text>
          <Group gap={4}>
            <Button size="xs" variant="light" onClick={() => setRetrySeq((n) => n + 1)}>
              重试
            </Button>
          </Group>
        </Stack>
      )}

      {status === "ready" && !tags.length && (
        <Text size="xs" c="dimmed">
          还没有任何标签。在上方输入名称后按回车即可创建第一个标签。
        </Text>
      )}

      {status === "ready" &&
        tags.map((rec) => {
          const name = rec.name;
          const members = rec.members;
          const isOpen = expanded.has(name);
          const isSelected = selectedTag === name;
          const isRenaming = renaming?.from === name;
          return (
            // biome-ignore lint/a11y/noStaticElementInteractions: 标签行容器只把右键转发给共享菜单面板；行内已有真实按钮与输入控件
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
                          void commitRename();
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setRenaming(null);
                          setRenameProblem(null);
                          setPendingFocus(name);
                        }
                      }}
                    />
                    <Button size="xs" variant="light" onClick={() => void commitRename()}>
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
                    <Button size="xs" variant="light" color="red" onClick={() => void deleteTag(name)}>
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
                      onClick={() => void addFocusToTag(name)}
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
                      key={m.path}
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
                        onClick={() => void removeMember(name, m)}
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
            已删除标签「{undoable.record.name}」，只移除了 {undoable.record.members.length}{" "}
            条成员关联，任何文件或文件夹都未被删除。{undoLeft > 0 && `（${undoLeft} 秒内可撤销）`}
          </Text>
          <Button size="xs" variant="light" leftSection={<RotateCcw size={12} />} onClick={() => void undoDelete()}>
            撤销
          </Button>
        </Group>
      )}

      {notice && (
        <Text size="xs" c={notice.warn ? "orange" : "blue"} title={notice.hover}>
          {notice.text}
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
