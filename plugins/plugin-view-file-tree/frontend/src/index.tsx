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

import { Events, errorMessage, type ListEntry, type Ref, type SlotProps } from "@my-file-manager/plugin-sdk";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, FolderTree } from "lucide-react";
import type { CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { type NodeRendererProps, Tree } from "react-arborist";

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
      className="fm-rail-button"
      aria-label="目录树"
      aria-pressed={active === VIEW_ID}
      title="目录树"
      onClick={() => host.emit(Events.sidebarViewChanged, { viewId: VIEW_ID })}
      style={railButtonStyle(active === VIEW_ID)}
    >
      <FolderTree size={19} />
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
    const ro = new ResizeObserver(() => setSize({ w: Math.max(80, el.clientWidth), h: Math.max(80, el.clientHeight) }));
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
    <div
      className="fm-nav-panel fm-tree"
      style={{ display: "flex", flexDirection: "column", gap: 4, height: "100%", minHeight: 0 }}
    >
      <div className="fm-nav-heading">目录树</div>
      {rootError && <div style={{ color: "var(--mantine-color-red-6)", fontSize: 12 }}>{rootError}</div>}
      <div ref={box} style={{ flex: 1, minHeight: 0 }}>
        {tree.length > 0 && (
          <Tree
            data={tree}
            width={size.w}
            height={size.h}
            indent={14}
            rowHeight={32}
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
          >
            {TreeRow}
          </Tree>
        )}
      </div>
    </div>
  );
}

/** Keep the tree library's selection/keyboard behavior; customize its visuals. */
function TreeRow({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  return (
    <div
      ref={dragHandle}
      style={{ ...style, display: "flex", alignItems: "center", gap: 6, height: "100%", paddingRight: 6 }}
    >
      {node.isLeaf ? (
        <span style={{ width: 18, flexShrink: 0 }} />
      ) : (
        <button
          type="button"
          tabIndex={-1}
          className="fm-tree-toggle"
          aria-label={`${node.isOpen ? "折叠" : "展开"}${node.data.name}`}
          onClick={(e) => {
            e.stopPropagation();
            node.toggle();
          }}
        >
          {node.isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
      )}
      {node.data.isDir ? (
        node.isOpen ? (
          <FolderOpen size={16} color="var(--mantine-color-yellow-6)" />
        ) : (
          <Folder size={16} color="var(--mantine-color-yellow-6)" />
        )
      ) : (
        <FileText size={15} color="var(--mantine-color-dimmed)" />
      )}
      {node.isEditing ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: 行内重命名输入框由用户显式进入编辑态时才挂载，挂载即需键盘焦点（并非页面加载抢焦点）
          autoFocus
          defaultValue={node.data.name}
          onBlur={() => node.reset()}
          onKeyDown={(e) => {
            if (e.key === "Escape") node.reset();
            if (e.key === "Enter") node.submit(e.currentTarget.value);
          }}
        />
      ) : (
        <span title={node.data.path} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.data.name}
        </span>
      )}
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
  width: 40,
  height: 40,
  margin: "2px auto",
  fontSize: 16,
  cursor: "pointer",
  borderRadius: "var(--mantine-radius-md)",
  border: "none",
  background: active ? "var(--mantine-color-blue-light)" : "transparent",
});
