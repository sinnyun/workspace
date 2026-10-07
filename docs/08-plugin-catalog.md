# 08 · 插件目录与库分布规划

> 本文把 [06-open-source-stack.md](06-open-source-stack.md) 选型的开源库**分布到具体的插件与层**里,并给出每个业务插件的职责边界、占用插槽、依赖能力/事件与 manifest 草案。它是 [04-roadmap.md](04-roadmap.md) **Phase 6** 的"按插件视角"展开:**Phase 6 的 P6-* 任务 = 本目录里各插件的落地项**。
>
> 状态图例沿用 04:🔵 已决定未实现 / ⚪ 待评估 / ✅ 已实现。**本目录是规划,不是现状**——现状事实源仍是 04 与代码。

---

## 1. 库该装在哪:归属分层规则(先定这条,再谈清单)

一个库只可能落在下列五个位置之一。规则来自 [01-architecture.md](01-architecture.md) §6 解耦红线:

| 落位 | 是什么 | 判定标准 | 例子 |
|---|---|---|---|
| **A. 基座(Host)** | 不含业务的最小运行框架 + OS 集成 | 跨一切插件都要用、或属"应用外壳"行为 | React、Mantine(core/hooks/notifications/spotlight)、i18next、Tauri 窗口/单实例/通知、事件总线、`PluginHost` |
| **B. 能力层(kernel/capabilities)** | 原子 Rust 能力,对外只经 `domain.action` 契约 | 重第三方库、可被多插件复用、无业务策略 | rusqlite、notify、blake3/sha2、`ignore`+`rayon`、`trash`、`fs_extra`、`image`+`fast_image_resize`、`infer`、`sysinfo`、`tantivy`/FTS5、`similar`、`zip/tar/flate2/sevenz` |
| **C. 后端插件(逻辑 fiber)** | 订阅事件 + 编排能力 = 业务策略 | 有业务语义、静态编译进宿主(R4) | file-history 的"变更→比对→写历史"策略 |
| **D. 前端共享单例(import map)** | 基座 + 插件复用的框架级前端包 | **多消费者**且**必须单例**(否则 hooks 多实例) | react、react-dom、@mantine/*、plugin-sdk |
| **E. 前端插件自带 bundle(打进插件 dist)** | 单插件专用的功能库 | **单消费者**、非单例要求 | CodeMirror、Shiki、echarts、react-arborist、@tanstack/*、react-markdown、react-pdf、react-photo-view、@dnd-kit |

**关键约束**:
- **D 与 E 的分界是"是否多消费者 + 是否要求单例"**。只有框架与 Mantine 进 import map 共享;功能库(即便体积大)只被一个插件用,就**打进该插件自己的 ESM dist**,保持插件 drop-in 自包含、不撑爆共享集。
- **B 与 C 的分界是"原子 vs 业务"**。`image` 解码缩放是原子能力(放 B);"图片库网格何时生成缩略图"是业务(放 C 或直接放前端插件用能力)。
- **重依赖(ffmpeg/pdfium/tantivy/monaco)**优先做成**独立能力 + 独立插件**,不进核心路径,按需启用(06 §5.4)。

---

## 2. 插槽(Slots)清单 — 全部由基座预留,插件只注入

| slotId | 位置 | 现状 | 谁在用/规划用 |
|---|---|---|---|
| `topbar-zone` | 顶栏 | ✅ 存在 | file-ops(新建/上传按钮)、settings 入口 |
| `nav-zone` | 左侧导航 | ✅ 存在 | file-browser(目录树/书签)、storage-analysis |
| `file-sidebar-zone` | 右侧检查器侧栏 | ✅ 存在 | file-history(时间线)、details、preview 摘要 |
| `main-view-zone` | 主内容区 | 🔵 规划 | file-browser(列表/网格)、search(结果)、archive、storage-analysis(treemap) |
| `preview-zone` | 预览面板(分屏/覆盖) | 🔵 规划 | preview-text/code/markdown/image/pdf/media |
| `statusbar-zone` | 底部状态栏 | 🔵 规划 | file-ops(复制进度)、选中统计 |
| `command-palette` | 全局命令面板 | 🔵 规划(基座 spotlight) | 各插件注册命令 |

> 加新 slot = 改基座布局(01 §2),需评估;插件侧只声明 `{ id, export }`。

---

## 3. 元状态与事件总线约定(基座持有,业务不碰)

- **元状态**:仅 `currentFileId`(+ 路径),变更即广播 `selection:changed`。业务数据(历史、标签、收藏)一律由插件自建自持。
- **跨层事件(已冻结 v1)**:`file:changed`、`history:updated`(见 02 §7.1)。
- **规划新增事件(进 Phase 6 时同步 contracts↔plugin-sdk 并跑 `contract:check`)**:
  `file:operation:progress`、`file:operation:complete`(file-ops)、`search:results`(search)、`thumb:ready`(缩略图)、`command:invoke`(面板)。

---

## 4. 能力层原子能力 → 库 → 消费插件(B 落位一览)

| 能力 `domain.action` | 底层库 | 消费它的插件 | Phase 任务 |
|---|---|---|---|
| `fs.list`(并行遍历) | `ignore`/`jwalk` + `rayon` | file-browser、search、archive、storage-analysis | P6-1 |
| `fs.stat` / `fs.readChunk` / `fs.readText` | std + `encoding_rs`+`chardetng` | 多数前端插件 | 已(基础)/ P6-8 |
| `fs.trash` | `trash` | file-ops | P6-2 |
| `fs.copy` / `fs.move`(带进度) | `fs_extra` + 分块进度 | file-ops | P6-3 |
| 自然排序 `natord` | `natord` | file-browser、archive | P6-4 |
| `sys.disk` | `sysinfo` | storage-analysis、details、statusbar | P6-5 |
| `file.kind`(MIME) | `infer` + `mime_guess` | preview-*、details、browser 图标 | P6-6 |
| `thumb.image` | `image` + `fast_image_resize` | file-browser 网格、preview-image | P6-7 |
| `hash.compute` | `blake3`/`sha2` | file-history、去重(未来) | ✅ |
| `text.diff` | `similar` | file-history(版本对比) | P6-11 |
| `db.<store>.*` | `rusqlite`(+ `refinery` 迁移 / `r2d2_sqlite` 池) | file-history、search 索引、settings | P6-12 |
| `search.query`(索引) | `tantivy` **或** SQLite FTS5 | search | P6-9(⚪ 先评估 FTS5) |
| `archive.list`/`archive.extract` | `zip`/`tar`+`flate2`/`sevenz-rust` | archive | P6-10 |
| `fs.chunks`(内容定义分块) | `fastcdc` | file-history 块级历史(可选) | P6-13(⚪) |
| `media.probe`/`media.thumb` | `ffmpeg-next`(系统 ffmpeg) | media(重,独立启用) | ⚪ |
| `doc.render`(PDF) | `pdfium-render` | preview-pdf 后端路线 | ⚪ |

---

## 5. 插件清单(核心:每个库落到哪个插件)

| 插件 | 形态 | 目的 | 前端库(E/D 落位) | 依赖能力(B) | 主要 slot | 关键事件 | 优先级 / 归属 P6 | 状态 |
|---|---|---|---|---|---|---|---|---|
| `plugin-file-browser` | 前端 | 列表/网格/树/标签浏览与导航 | `@tanstack/react-virtual`、`@tanstack/react-table`、`react-arborist`、`lucide-react`、`dayjs`、`pretty-bytes` | `fs.list`、`fs.stat`、`file.kind`、`thumb.image`、`fs.readText` | `nav-zone`、`main-view-zone` | 发 `selection:changed` | 高 | P6-15/16/17/19/20/21 | 🔵 |
| `plugin-file-ops` | **全栈** | 复制/移动/删除/重命名/新建 | `@dnd-kit/core`、`@mantine/modals`、`@mantine/form`、`@mantine/notifications` | `fs.copy`、`fs.move`、`fs.trash`、`fs.mkdir/rename`、`sys.disk` | `topbar-zone`、`statusbar-zone`、命令 | 发 `file:operation:progress/complete`;订 `file:changed` | 高 | P6-2/3/18/27/28 | 🔵 |
| `plugin-file-history` | **全栈** | 内容版本历史 + 时间线 + diff(**已存在,增强**) | `react-diff-view`(+ 现有 Mantine `Timeline`) | `hash.compute`、`text.diff`、`db.history.*`、`fs.readText`(已有) | `file-sidebar-zone` | 订 `file:changed`;发/订 `history:updated` | — | P6-11/23 增强 | ✅ 基础 / 🔵 diff |
| `plugin-search` | **全栈** | 文件名 + 内容检索 | 复用 `@mantine/spotlight`(D 共享)+ 结果列表 | `search.query`、`fs.list`(建索引) | `command-palette`、`main-view-zone`(结果) | 发 `search:results`;订 `file:changed`(增量索引) | 中 | P6-9/14 | 🔵(引擎⚪) |
| `plugin-preview-text` | 前端 | 代码/文本只读预览 + 高亮 | `@uiw/react-codemirror`、`shiki` | `fs.readText`、`file.kind` | `preview-zone` | 订 `selection:changed` | 中 | P6-22 | 🔵 |
| `plugin-preview-markdown` | 前端 | Markdown 渲染预览 | `react-markdown`、`remark-gfm`、`rehype-*` | `fs.readText` | `preview-zone` | 订 `selection:changed` | 中 | P6-24 | 🔵 |
| `plugin-preview-image` | 前端 | 图片查看 / lightbox | `react-photo-view` | `fs.readChunk`、`thumb.image`、`file.kind` | `preview-zone`、`main-view-zone` | 订 `selection:changed`;订 `thumb:ready` | 中 | P6-24 | 🔵 |
| `plugin-preview-pdf` | 前端 / ⚪后端 | PDF 预览 | `react-pdf`(`pdfjs-dist`) **或** 后端 `doc.render`(pdfium) | `fs.readChunk` 或 `doc.render` | `preview-zone` | 订 `selection:changed` | 低 | P6-24 | ⚪ |
| `plugin-media` | **全栈(重,按需启用)** | 音视频播放 + 视频缩略图 | 原生 `<video>` / `plyr` | `media.probe`、`media.thumb`(`ffmpeg-next`) | `preview-zone` | 订 `selection:changed` | 低 | — | ⚪ |
| `plugin-archive` | **全栈** | zip/tar/7z 只读浏览 + 解压 | 复用 file-browser 视图 + `@tanstack/react-virtual` | `archive.list/extract`、`fs.*` | `main-view-zone`、`nav-zone` | 订 `selection:changed` | 中 | P6-10 | 🔵 |
| `plugin-storage-analysis` | 前端 | 磁盘占用 treemap / 空间分析 | `echarts`(`echarts-for-react`) | `sys.disk`、`fs.list`(聚合) | `main-view-zone`(tab)、`nav-zone` | 订 `selection:changed` | 低 | P6-25 | 🔵 |
| `plugin-details`(检查器) | 前端 | 选中项属性/元数据面板 | `lucide-react`、`pretty-bytes`、`dayjs` | `fs.stat`、`file.kind`、`sys.disk` | `file-sidebar-zone` | 订 `selection:changed` | 中 | P6-6/20/21 | 🔵 |
| `plugin-settings` | 前端 | 设置面板(主题/语言/插件开关) | `@mantine/form`、`@mantine/modals` | `db.settings.*`(或 `tauri-plugin-store` 走基座) | `topbar-zone`、独立视图 | 订/发 `plugin:*`(启停) | 中 | P6-27/29 | 🔵 |

> **前端 drop-in 复用要点**:file-browser / archive / search 结果都消费"虚拟列表"能力,故 `@tanstack/react-virtual` 虽被多插件用,但它**无 React hooks 之外的单例约束**——可选方案:(a) 打进各插件 dist,(b) 若发现重复体积显著,再升入 D 共享集。默认 (a),保持共享集只含框架+Mantine。

---

## 6. 基座内建(非插件)对照清单

这些是"应用外壳"级、含业务为零的东西,归基座(A 落位),**不做成插件**:

| 项 | 库 | 说明 |
|---|---|---|
| 布局骨架 + 插槽 | React + Mantine | `topbar/nav/main/sidebar/preview/status` 六区 |
| 元状态 | `zustand`(已在用) | 仅 `currentFileId`/selection |
| 事件总线 | 自写 + `@tauri-apps/api` | 后端事件→前端(已实现桥) |
| `PluginHost` | plugin-sdk | invoke/on/emit/state + 命令注册(受权限约束) |
| 命令面板 | `@mantine/spotlight` | 基座提供面板,插件注册命令项 |
| 国际化 | `i18next` + `react-i18next` | 基座 provider,插件按需取文案 |
| 系统通知 | `@mantine/notifications`(应用内)+ `tauri-plugin-notification`(系统级) | |
| 窗口/单实例/开机 | `tauri-plugin-window-state`/`-single-instance`/`-autostart` | 纯外壳行为,无插槽 |
| 自更新 / 深链唤起 | `tauri-plugin-updater`/`-deep-link` | 发布期接 |
| 用默认程序打开 / 原生对话框 | `tauri-plugin-opener`/`-dialog`(已注册) | 经能力/host API 暴露给插件 |

---

## 7. manifest 草案(格式对 file-browser / file-ops / search)

沿用 02 §2 schema(`schemaVersion=1`,camelCase,`crate` 键)。仅示例**分布**,非落地文件。

```jsonc
// plugins/plugin-file-browser/manifest.json  (纯前端)
{
  "schemaVersion": 1, "name": "plugin-file-browser", "version": "0.1.0",
  "displayName": "文件浏览", "minHostVersion": "0.1.0",
  "frontend": {
    "entry": "frontend/dist/index.js",
    "slots": [
      { "id": "nav-zone",        "export": "FolderTree" },
      { "id": "main-view-zone",  "export": "FileListView" }
    ]
  },
  "permissions": {
    "capabilities": ["fs.list", "fs.stat", "fs.readText", "file.kind", "thumb.image"],
    "events": { "subscribe": ["selection:changed", "thumb:ready"], "emit": ["selection:changed"] }
  }
}
```

```jsonc
// plugins/plugin-file-ops/manifest.json  (全栈:后端 fiber 编排 fs.copy/move/trash 能力 + 进度事件)
{
  "schemaVersion": 1, "name": "plugin-file-ops", "version": "0.1.0",
  "displayName": "文件操作", "minHostVersion": "0.1.0",
  "backend": { "crate": "plugin-file-ops-backend", "enabledByDefault": true, "config": { "chunkBytes": 1048576 } },
  "frontend": {
    "entry": "frontend/dist/index.js",
    "slots": [
      { "id": "topbar-zone",   "export": "OpsButtons" },
      { "id": "statusbar-zone","export": "OpsProgress" }
    ]
  },
  "permissions": {
    "capabilities": ["fs.copy", "fs.move", "fs.trash", "fs.mkdir", "fs.rename", "sys.disk"],
    "events": { "subscribe": ["file:changed"], "emit": ["file:operation:progress", "file:operation:complete"] }
  }
}
```

```jsonc
// plugins/plugin-search/manifest.json  (全栈:后端建/查索引,前端 spotlight + 结果面板)
{
  "schemaVersion": 1, "name": "plugin-search", "version": "0.1.0",
  "displayName": "搜索", "minHostVersion": "0.1.0",
  "backend": { "crate": "plugin-search-backend", "enabledByDefault": true, "config": { "engine": "fts5" } },
  "frontend": {
    "entry": "frontend/dist/index.js",
    "slots": [
      { "id": "command-palette", "export": "SearchPalette" },
      { "id": "main-view-zone",  "export": "SearchResults" }
    ]
  },
  "permissions": {
    "capabilities": ["search.query", "fs.list"],
    "events": { "subscribe": ["file:changed"], "emit": ["search:results"] }
  }
}
```

> 后端插件**只声明并使用能力**,不直连 `trash`/`tantivy`——那些库在能力层(B)。search 后端唯一例外可直连索引库(若索引本身被视为重能力,则同样封进 `search.query` 能力,后端插件仅编排)。二选一在 P6-9 评估时定,记进 05 决策。

---

## 8. 与 Phase 6 / 06 的双向映射

- 本目录 §4/§5 每行都标了对应 **P6-* 任务**与 **06 库**;做某插件时,按它拉起的 P6 任务清单装库、加能力、跑 `contract:check`。
- 反过来:roadmap Phase 6 若新增库需求,先回填本文(该库归 A/B/C/D/E 哪层),再实现——保持"库必先有归属"。

**建议实现顺序**(每步都产出可 dogfood 的新插件并验证架构):
1. **file-browser**(把基座里最小浏览能力外置成插件,验证 slot/元状态/事件全链路)。
2. **file-ops**(首个新增后端能力 + 进度事件 → 验证能力层扩展 + 契约两侧同步 + 错误隔离在写操作上的表现)。
3. **search**(验证重能力/索引 + spotlight 命令注册)。
4. **preview 家族**(text→markdown→image,验证单消费者库打进插件 dist + preview-zone)。
5. **file-history 增强(diff)**:复用 preview 的 diff-view 与 `text.diff` 能力。
6. 视需要:archive / storage-analysis / details / settings / media。
