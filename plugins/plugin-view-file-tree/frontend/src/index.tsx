/**
 * `plugin-view-file-tree` — sidebar view (roadmap P6-48, docs/01 §9.1 A+B).
 *
 * Contributes an A activity-rail icon and one B panel; the virtualized tree is
 * `react-arborist` (docs/06). It has no lazy loader, so the first time a directory
 * is opened its children are fetched with a single `fs.list` and spliced into the
 * controlled `data` tree — never a recursive walk.
 *
 * View convention (docs/08 §2): this plugin owns an A icon and one
 * `nav-panel:file-tree` panel; `plugin-layout-views` renders exactly one panel, so
 * no self-hide check lives here. Cascade role: publishes
 * `sidebar:selection:changed` (B → C).
 */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Tree } from "react-arborist";
import {
  Events,
  errorMessage,
  type ListEntry,
  type Ref,
  type SlotProps,
} from "@my-file-manager/plugin-sdk";

const VIEW_ID = "file-tree";
const PLUGIN_NAME = "plugin-view-file-tree";
/** Marks the synthetic "(空目录)/(载入失败)" row, which is not a real entry. */
const EMPTY_SUFFIX = "::__empty__";

interface TreeNode {
  /** Node id = the entry path (unique within a tree). */
  id: string;
  name: string;
  path: string;
  isDir: boolean;
  /** Present (possibly empty) = expandable directory; absent = leaf. */
  children?: TreeNode[];
}

export function RailIcon({ host }: SlotProps) {
  const [active, setActive] = useState(host.getState().activeSidebarView);
  useEffect(() => host.onStateChange((s) => setActive(s.activeSidebarView)), [host]);
  return (
    <button
      type="button"
      title="目录树"
      onClick={() => host.emit(Events.sidebarViewChanged, { viewId: VIEW_ID })}
      style={railButtonStyle(active === VIEW_ID)}
    >
      🌳
    </button>
  );
}

export function TreePanel({ host }: SlotProps) {
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [rootError, setRootError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 240, h: 320 });
  const loaded = useRef(new Set<string>());
  /** `onToggle` fires on open AND close; this is what tells the two apart. */
  const opened = useRef(new Set<string>());
  const box = useRef<HTMLDivElement | null>(null);

  // react-arborist needs numeric width/height: track the panel's box.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() =>
      setSize({ w: Math.max(80, el.clientWidth), h: Math.max(80, el.clientHeight) }),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (tree.length > 0 || rootError) return;
    host
      .invoke<string>("fs.home")
      .then((home) => host.invoke<ListEntry[]>("fs.list", { path: home }))
      .then((entries) => setTree(entries.map(toNode)))
      .catch((err) => setRootError(errorMessage(err)));
  }, [host, tree.length, rootError]);

  const loadDir = (path: string): void => {
    if (loaded.current.has(path)) return;
    loaded.current.add(path);
    const placeholder = (label: string): TreeNode => ({
      id: `${path}${EMPTY_SUFFIX}`,
      name: label,
      path,
      isDir: false,
    });
    host
      .invoke<ListEntry[]>("fs.list", { path })
      .then((entries) => {
        const children = entries.map(toNode);
        // A loaded-but-empty dir must look different from an unopened one, and the
        // row is also the retry affordance (docs/02 §4.3: failures stay recoverable).
        setTree((prev) => attach(prev, path, children.length ? children : [placeholder("(空目录)")]));
      })
      .catch(() => {
        loaded.current.delete(path);
        setTree((prev) => attach(prev, path, [placeholder("(载入失败，重新展开重试)")]));
      });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, height: "100%", minHeight: 0 }}>
      <div style={{ fontSize: 12, color: "var(--mantine-color-dimmed)" }}>目录树</div>
      {rootError && <div style={{ color: "var(--mantine-color-red-6)", fontSize: 12 }}>{rootError}</div>}
      <div ref={box} style={{ flex: 1, minHeight: 0 }}>
        {tree.length > 0 && (
          <Tree
            data={tree}
            width={size.w}
            height={size.h}
            indent={14}
            rowHeight={22}
            openByDefault={false}
            disableDrag
            disableDrop
            disableMultiSelection
            onToggle={(id) => {
              // onToggle fires for open AND close, and for a leaf whose row was
              // clicked; only a newly opened DIRECTORY has children to fetch.
              const path = String(id);
              if (!findNode(tree, path)?.isDir) return;
              if (opened.current.has(path)) {
                opened.current.delete(path);
                return;
              }
              opened.current.add(path);
              loadDir(path);
            }}
            onSelect={(nodes) => {
              const n = nodes[0]?.data;
              if (!n || n.id.endsWith(EMPTY_SUFFIX)) return;
              host.emit(Events.sidebarSelectionChanged, {
                kind: n.isDir ? "folder" : "file",
                id: n.path,
                sourcePlugin: PLUGIN_NAME,
              } satisfies Ref);
            }}
          />
        )}
      </div>
    </div>
  );
}

/** react-arborist renders the expand arrow from the **presence** of a `children`
 *  array, so unopened directories carry `children: []` and leaves carry no
 *  `children` key at all. `loadDir` fills the array on first open (one `fs.list`,
 *  never a recursive walk). */
function toNode(e: ListEntry): TreeNode {
  return e.isDir
    ? { id: e.path, name: e.name, path: e.path, isDir: true, children: [] }
    : { id: e.path, name: e.name, path: e.path, isDir: false };
}

/** Immutably set `children` on the directory whose id matches, so React sees a new
 *  tree. A leaf never gains children — its row must stay non-expandable. */
function attach(nodes: TreeNode[], path: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((n) => {
    if (n.id === path) return n.isDir ? { ...n, children } : n;
    if (n.children) {
      const nextChildren = attach(n.children, path, children);
      if (nextChildren !== n.children) return { ...n, children: nextChildren };
    }
    return n;
  });
}

function findNode(nodes: TreeNode[], id: string): TreeNode | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    if (n.children) {
      const found = findNode(n.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

const railButtonStyle = (active: boolean): CSSProperties => ({
  display: "block",
  width: 36,
  height: 36,
  margin: "2px auto",
  fontSize: 16,
  cursor: "pointer",
  borderRadius: 6,
  border: "none",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
});
