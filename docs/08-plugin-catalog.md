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

## 2. 插槽(Slots)清单 — 外层由基座预留,嵌套由容器插件提供

**外层区域槽(基座预留,插件注入)** — 对应 01 §9.1 的网格:

| slotId | 区域 | 现状 | 谁在用/规划用 |
|---|---|---|---|
| `activity-rail-zone` | A 活动栏(侧栏视图切换器) | ✅ 存在 | `view-file-tree`/`view-favorites`/`view-tags`/`mock-data` 各贡献一个图标 tab,`settings` 贡献底部齿轮入口(均已交付,P6-48/51/57) |
| `topbar-zone` | 工具栏扩展位 | ✅ 存在 | file-ops(新建/上传按钮)、视图工具按钮 |
| `nav-zone` | B 侧栏面板 | ✅ 存在 | **由 `plugin-layout-views` 容器占用**(P6-54):容器向下提供 `nav-panel:<viewId>` 并负责视图互斥,视图插件不再 self-hide |
| `main-view-zone` | C 主视图 | ✅ 存在 | **由 `plugin-layout-panes` 容器占用**(P6-46),容器再向下提供 `pane-slot:<paneId>`;基座不含任何浏览逻辑,浏览能力归 `plugin-file-browser`(P6-55) |
| `file-sidebar-zone` | D 详情容器 | ✅ 存在 | **由 `plugin-inspector` 容器占用**(P6-47),容器再向下提供 `detail-tab:*`/`preview-zone`/`detail-info-zone`/`file-extension-zone` |
| `statusbar-zone` | 底部状态栏 | ✅ 存在(基座自带 `会话 N · 文件/目录 <路径>` 文本 + `statusbar-zone` 扩展位) | file-ops(复制进度)、选中统计 |
| `bottom-drawer` | 底部调试抽屉(非 A/B/C/D 网格区,开发/排障用) | ✅ 存在 | `devtools-log`(性能/错误/事件捕获面板)、`dev-slot-harness`(嵌套槽验证夹具),均仅 dev 索引装载 |
| `command-palette` | 全局命令面板 | 🔵 规划(基座 spotlight) | 各插件注册命令 |

**嵌套槽(基座嵌套槽运行时 P6-45 已就绪:manifest `frontend.provides` 声明前缀 + `permissions.slots.contribute` 授权注入;容器插件才能 `provideSlot`)**:

| slotId 前缀 | 提供者(容器插件) | 谁注入 |
|---|---|---|
| `pane-slot:<paneId>`(paneId 为容器分配的稳定 id:`p0/p1/p2/p3`) | `plugin-layout-panes` | `plugin-file-browser`(每栏一个独立实例,已交付)、search 结果、archive、storage-analysis、preview-*(规划) |
| `nav-panel:<viewId>`(`file-tree`/`favorites`/`tags`/`settings`/`stress`) | `plugin-layout-views` | 对应视图插件的 B 面板;图标由同一插件的 `activity-rail-zone` 贡献 |
| `detail-tab:<name>` | `plugin-inspector` | `file-history`(`detail-tab:history`,manifest `label:"历史"`)、未来详情类插件——tab 标题取自贡献者自己的 `label`(02 §4.5) |
| `preview-zone` | `plugin-inspector`(在"信息"tab 内) | `preview-text`(已交付,纯文本)、preview-code/markdown/image/pdf/media(规划) |
| `detail-info-zone` | `plugin-inspector`(在"信息"tab 内) | `file-details`(属性/校验,已交付)、file-ops(操作按钮) |
| `file-extension-zone` | `plugin-inspector`(在"信息"tab 内,占位文案 `插件预留`) | 任意针对焦点文件的扩展插件 |
| `dev-pane:<n>` | `plugin-dev-slot-harness`(仅 dev) | harness 自身(取证 provide/contribute 与越权拒绝路径) |


> 加**外层** slot = 改基座布局(01 §9),需评估;**嵌套** slot 由容器插件在自己 manifest `provides` 声明即可,内容插件在 `permissions.slots.contribute` 列目标前缀。

---

## 3. 元状态与事件总线约定(基座搬运不透明引用,业务不碰)

- **元状态(级联引用,见 01 §9)**:`activeTabId`(顶部会话)、`activeSidebarView`(A)、`sidebarSelection: Ref\|null`(B→C)、`focusRef: Ref\|null`(C→D)、`activeDetailTab`(D)。`Ref={kind,id,sourcePlugin}`,基座只搬运不解释。业务数据(历史、标签、收藏、缩略图缓存)一律插件自建自持。
- **协调事件(前端总线,TS SDK 内,不跨 IPC)**:`tab:activated`、`sidebar:view:changed`、`sidebar:selection:changed`、`focus:changed`、`detail:tab:changed`,以及嵌套槽 `slot:registered/reconfigured/disposed`(02 §4.5/§6.4)。
- **跨层领域事件(已冻结 v1,需 Rust 契约)**:`file:changed`、`history:updated`(见 02 §7.1)。
- **规划新增领域事件(进 Phase 6 时同步 contracts↔plugin-sdk 并跑 `contract:check`)**:
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

## 5. 插件清单

### 5.1 框架 / 布局插件(把界面外壳的可变部分拆成插件)

01 §9 的务实边界:**外层网格 + 元状态总线留在基座**,只把多变部分插件化。下面这几个是"框架级"插件——它们提供嵌套槽或承载某个区域,先于业务内容插件装载:

| 插件 | 形态 | 区域 | 占用(注入) | 提供(嵌套槽) | 局部状态 | 目的 | 状态 |
|---|---|---|---|---|---|---|---|
| `plugin-layout-panes` | 前端 | C 主视图 | `main-view-zone` | `pane-slot:<paneId>` | `fm.layout-panes.v1`,按会话 `activeTabId` 存 `{mode,ids,seq,colPct,rowPct}` | 分栏容器:切单栏/左右双栏/2×2 四栏;稳定 paneId + 单一 keyed 数组迁移子树不丢状态;按模式**增量挂载** outlet;**每栏都是有界 flex 列**(栅格行轨 `minmax(0,1fr)`、栏 `display:flex`+`min-height:0`、outlet `overflow:hidden`),滚动权交给内容插件 | ✅ |
| `plugin-inspector` | 前端 | D 详情 | `file-sidebar-zone` | `detail-tab:<name>`、`preview-zone`、`detail-info-zone`、`file-extension-zone` | 活动 tab 取 `meta.activeDetailTab` | 详情容器:焦点标题条(名称/路径/类型徽标)+ tab 条(信息 + `contributedSlots("detail-tab")` 扫到的,标题取 `host.slotLabel`)+ 焦点 kind 模板(文件/文件夹/其他);tab 全挂载、隐藏非活动;空槽显示中文占位 | ✅ |
| `plugin-layout-views` | 前端 | B 侧栏 | `nav-zone` | `nav-panel:<viewId>` | 无(读 `meta.activeSidebarView`) | 视图互斥容器:只渲染活动视图对应出口可见,其余 `display:none`;**互斥是容器职责**,视图插件不写 self-hide | ✅ |
| `plugin-file-browser` | 前端 | C 内容 | (运行时注入 `pane-slot:*`) | — | `fm.file-browser.v1`,按 `会话\|槽id` 记住每栏 `{cwd,mode}` | 每栏一个独立实例:**独立地址栏 + 后退/前进/上级/刷新历史栈**、列表或网格(统一虚拟滚动流,列表/卡片共用一条 row stream)、文件夹/文件分组、图标与大小、**日期列直接用 `fs.list` 带的 `modifiedMs`**、网格卡片按可见性懒取 `thumb.image`(共享 LRU + 负缓存:不支持的扩展名不再重复请求)、选择与 `focus:changed` 发布;头部显示 `N 目录 · M 文件 · 拉取毫秒` | ✅ |
| `plugin-view-file-tree` | 前端 | A+B | `activity-rail-zone`(图标)、`nav-panel:file-tree` | — | 展开态与已加载目录在组件内(ref),不持久化 | 侧栏视图:目录树(react-arborist,自写懒加载) | ✅ |
| `plugin-view-favorites` | 前端 | A+B | `activity-rail-zone`、`nav-panel:favorites` | — | `fm.view-favorites.v1` 收藏列表 | 侧栏视图:主页 + 收藏/书签;选中发 `sidebar:selection:changed` | ✅ |
| `plugin-view-tags` | 前端 | A+B | `activity-rail-zone`、`nav-panel:tags` | — | `fm.view-tags.v1` 标签与成员 | 侧栏视图:标签/集合;点标签发 `{kind:"tag"}` 选择,点成员发 `focus:changed` | ✅ |

要点:
- 容器插件(`layout-panes`/`inspector`/`layout-views`)**只管几何与承载**,不碰内容业务;内容插件只认 `slotId`,不感知自己处在哪种分栏。
- **稳定 `paneId` + 按 id 迁移子树**是"切换布局/切会话不混乱"的硬要求(02 §4.5):同一直子节点数组里渲染全部活跃面板,不可见者 `display:none` 而非卸载。
- **"栏高有界"是容器的职责,不是每个内容插件的自检**:栅格行轨写 `minmax(0,1fr)`、栏写 `display:flex`+`min-height:0`、outlet 只 `overflow:hidden`。内容插件的虚拟滚动因此总能拿到确定视口;容器若退化成 `display:block`,`flex:1` 会被忽略、outlet 长到内容高度,虚拟列表会**静默挂载全部行**(10 万条时 DOM 直接爆)。
- `slot:registered`/`slot:disposed` 由**基座槽运行时**随出口挂载/卸载发出;`slot:reconfigured{add|remove}` 由**容器**按意图发出。内容插件靠这两个面做**自动跟随注入**(`providedSlots(prefix)` 扫已有 + 订增删),不扒 React 内部。
- 顶部多标签**会话容器**属基座外壳(01 §9.1),不插件化;每个会话快照一份 §3 的级联引用。面板实例同样**按会话隔离**(切会话不共享同一 `pane-slot:p0`)。
- **界面文案中文且分层**:基座与容器的中文只出现在自己的渲染层(容器 tab、区域占位、A/B/C/D 折叠按钮的 `title`/`aria-label`),槽 id 只作为 `title` 提示留在开发者可见处(分栏头显示 `栏 N`,悬停给 `pane-slot:p0`);内容插件的 tab 名走 manifest `slots[].label`,容器不硬编码他插件的名字。


### 5.2 业务功能插件(每个库落到哪个插件)

| 插件 | 形态 | 目的 | 前端库(E/D 落位) | 依赖能力(B) | 主要 slot | 关键事件 | 优先级 / 归属 P6 | 状态 |
|---|---|---|---|---|---|---|---|---|
| `plugin-file-browser` | 前端 | 列表/网格/标签浏览与导航(目录树见 `view-file-tree`) | 现有:`@tanstack/react-virtual`(列表与网格共用一条虚拟化流)、`lucide-react` 类型图标、自写 `formatSize`;规划 `@tanstack/react-table`、`dayjs`、`pretty-bytes` | `fs.home`、`fs.list`、`thumb.image` | `pane-slot:*`(运行时按 outlet 自动注入,每栏独立实例) | 发 `focus:changed`;订 `sidebar:selection:changed`、`slot:registered`/`slot:disposed` | 高 | P6-16/19/21 剩余 | ✅ 每栏独立地址栏+历史前进后退 / ✅ 列表·网格虚拟滚动(P6-59) / ✅ 网格缩略图 + 日期列(P6-62) / 🔵 标签 chips、表格视图 |
| `plugin-file-ops` | **全栈** | 复制/移动/删除/重命名/新建 | `@dnd-kit/core`、`@mantine/modals`、`@mantine/form`、`@mantine/notifications` | `fs.copy`、`fs.move`、`fs.trash`、`fs.mkdir/rename`、`sys.disk` | `topbar-zone`、`statusbar-zone`、`detail-info-zone`(操作按钮)、命令 | 发 `file:operation:progress/complete`;订 `file:changed` | 高 | P6-2/3/18/27/28 | 🔵 |
| `plugin-file-history` | **全栈** | 内容版本历史 + 时间线 + diff(**已存在,增强**) | `react-diff-view`(+ 现有 Mantine `Timeline`) | `hash.compute`、`text.diff`、`db.history.*`、`fs.readText`(已有) | `detail-tab:history` | 订 `file:changed`;发/订 `history:updated` | — | P6-11/23 增强 | ✅ 基础 / 🔵 diff |
| `plugin-search` | **全栈** | 文件名 + 内容检索 | 复用 `@mantine/spotlight`(D 共享)+ 结果列表 | `search.query`、`fs.list`(建索引) | `command-palette`、`pane-slot:*`(结果) | 发 `search:results`;订 `file:changed`(增量索引) | 中 | P6-9/14 | 🔵(引擎  待评估) |
| `plugin-preview-text` | 前端 | 文本只读预览 | 现有:Mantine `ScrollArea`+`Code`(纯文本,截断 200k 字符);规划 `@uiw/react-codemirror`、`shiki`(P6-22 高亮) | `fs.readText`、`file.kind`(规划) | `preview-zone` | 随 `focusRef` 刷新(`onStateChange`) | 中 | P6-22 剩余(高亮) | ✅ 纯文本 / 🔵 语法高亮 |
| `plugin-preview-markdown` | 前端 | Markdown 渲染预览 | `react-markdown`、`remark-gfm`、`rehype-*` | `fs.readText` | `preview-zone` | 订 `selection:changed` | 中 | P6-24 | 🔵 |
| `plugin-preview-image` | 前端 | 图片查看 / lightbox | `react-photo-view` | `fs.readChunk`、`thumb.image`、`file.kind` | `preview-zone`、`pane-slot:*`(大图查看) | 订 `selection:changed`;订 `thumb:ready` | 中 | P6-24 | 🔵 |
| `plugin-preview-pdf` | 前端 / ⚪后端 | PDF 预览 | `react-pdf`(`pdfjs-dist`) **或** 后端 `doc.render`(pdfium) | `fs.readChunk` 或 `doc.render` | `preview-zone` | 订 `selection:changed` | 低 | P6-24 | ⚪ |
| `plugin-media` | **全栈(重,按需启用)** | 音视频播放 + 视频缩略图 | 原生 `<video>` / `plyr` | `media.probe`、`media.thumb`(`ffmpeg-next`) | `preview-zone` | 订 `selection:changed` | 低 | — | ⚪ |
| `plugin-archive` | **全栈** | zip/tar/7z 只读浏览 + 解压 | 复用 file-browser 视图 + `@tanstack/react-virtual` | `archive.list/extract`、`fs.*` | `pane-slot:*`(复用 file-browser 视图) | 订 `selection:changed` | 中 | P6-10 | 🔵 |
| `plugin-storage-analysis` | 前端 | 磁盘占用 treemap / 空间分析 | `echarts`(`echarts-for-react`) | `sys.disk`、`fs.list`(聚合) | `pane-slot:*`(treemap 占一栏) | 订 `selection:changed` | 低 | P6-25 | 🔵 |
| `plugin-details`(检查器)→ 现为 `plugin-file-details` | 前端 | 选中项属性/校验面板 | `pretty-bytes`/`dayjs` 规划;现为自写格式化 | `fs.stat`、`hash.compute`、`fs.home`、`fs.readText` | `detail-info-zone` | 订 `selection:changed`;随 `focusRef` 刷新 | 中 | P6-6/20/21 | ✅ 基础(属性+BLAKE3)/ 🔵 元数据扩展 |
| `plugin-settings` | 前端 | 设置面板(主题已交付;语言/插件开关规划) | 现有:Mantine `SegmentedControl` + `useMantineColorScheme`(与基座共用单例,无需自造事件);规划 `@mantine/form`、`@mantine/modals` | `db.settings.*`(规划,现主题由 Mantine 自带持久化 `mantine-color-scheme-value`) | `activity-rail-zone`(底部齿轮)、`nav-panel:settings` | 发 `sidebar:view:changed`;随 `activeSidebarView` 高亮 | 中 | P6-27/29 剩余 | ✅ 主题(跟随系统/亮色/暗色)/ 🔵 语言、插件开关 |

> **前端 drop-in 复用要点**:file-browser / archive / search 结果都消费"虚拟列表"能力,故 `@tanstack/react-virtual` 虽被多插件用,但它**无 React hooks 之外的单例约束**——可选方案:(a) 打进各插件 dist,(b) 若发现重复体积显著,再升入 D 共享集。默认 (a),保持共享集只含框架+Mantine。

### 5.3 开发期 / 调试插件(2026-10-08 交付,非发布形态)

先用外层槽跑通参考界面的基础信息展示、大数据渲染观察与运行时捕获,便于肉眼验收与调试;除 `dev-slot-harness` 外都不提供嵌套槽。**仅出现在浏览器 dev 的 `plugins_list_frontend` 模拟索引(`dev-mocks.ts`)中,发布/Tauri 下不装载。**

6E(P6-46~48/54/55)容器交付后,这批插件的挂载点已迁到容器提供的嵌套槽:清单加 `permissions.slots.contribute`(外层槽注入同样要授权),取焦点统一读级联 `focusRef`(`kind === "file"` 才当文件用),`selection:changed` 保留为兼容事件。原 `plugin-file-nav` 的主页/常用位置归 `plugin-view-favorites`、每栏地址栏与路径跟随归 `plugin-file-browser` 实例。

压力数据由 `dev-mocks.ts` 的 `/stress` 数据集提供(见 §5.4),`plugin-mock-data` 只做**入口**:列数据集 → 点击 → 发 `sidebar:selection:changed` → C 区真实网格加载。

| 插件 | 形态 | 占用槽 | 依赖能力 | 关键事件 | 用途 | 状态 |
|---|---|---|---|---|---|---|
| `plugin-file-details` | 前端 | `detail-info-zone`(inspector 的"信息"tab 内) | `fs.stat`、`hash.compute`、`fs.home`、`fs.readText` | 订 `selection:changed`;随 `focusRef` 刷新 | 选中项属性 + BLAKE3 校验面板 | ✅ |
| `plugin-file-history` | 全栈 | `detail-tab:history` | `fs.readText`、`fs.stat`、`hash.compute`、`db.history.*` | 订 `file:changed`/`selection:changed`;发/订 `history:updated` | 内容哈希时间线(D 容器第二个 tab) | ✅ |
| `plugin-mock-data` | 前端(dev) | `activity-rail-zone` + `nav-panel:stress`(B 区视图) | `fs.list` | 发 `sidebar:view:changed`、`sidebar:selection:changed` | 压力数据集入口:列 `/stress` 下各数据集目录,点击即以**不透明引用**驱动 C 区任意栏加载真实条目(每栏独立,可左右对比不同量级) | ✅ |
| `plugin-devtools-log` | 前端(dev) | `bottom-drawer` | — | 订 `selection:changed`/`file:changed`/`history:updated` + 级联 5 事件 + `slot:registered`/`slot:reconfigured`/`slot:disposed` | 捕获 console / `window` 错误 / `unhandledrejection` / longtask / 白名单事件入环形缓冲(上限 5000),面板可筛选/搜索/新旧序/清空/导出 JSON;在 dev 索引里**最先装载**以捕获他插件 | ✅ |
| `plugin-dev-slot-harness` | 前端(dev) | `bottom-drawer`;提供 `dev-pane:<n>` | — | 订 `slot:registered`/`slot:reconfigured`/`slot:disposed` | 嵌套槽运行时(P6-45)验证夹具:注册 `dev-pane` 前缀并渲染两个 `<SlotOutlet>`,卡片随 `focusRef` 更新;**故意**越权注入 `file-sidebar-zone` 与 `provideSlot("forbidden-prefix:0")`,让两条 gating 拒绝路径在调试台留证 | ✅ |

### 5.4 `/stress` 压力数据集(dev only,`apps/shell-ui/src/dev-mocks.ts`)

目的:在**真实插件路径**上测大数据,而不是另写一个演示列表。所有条目由 `fs.list`/`fs.stat`/`fs.readText`/`hash.compute`/`thumb.image` 这些正常能力返回,`plugin-file-browser` 与 `plugin-inspector` 完全按发布形态处理它们。

- **量级**:根 `/stress` 下 `数据集-1千 / -1万 / -10万 / -50万`(路径里的数字即条目数)+ `空目录` + `读取失败` + `说明-压力数据.md`,每个数据集内再合成卷宗目录(`2026-Q3_*`、`downloads_*`、`素材_*`…)与子目录,可一直下钻。
- **真实感**:约 48 种格式各有对数均匀的体积区间(`.log` 100KB~80MB、`.mp4` 5~600MB、`.heic` 1.5~12MB…),标注 `content: text|binary` 与 `thumbnail`;目录占 9.5% 且名字按权重随机;mtime 在两年内偏近期。二进制文件的 `fs.readText` **按真实约定 reject**,D 区因此能演"无法以文本读取 .m4a(二进制格式)"。
- **缩略图**:`thumb.image` 的 dev 实现用 canvas 画一张真 PNG(渐变 + 噪声 + 文件名)再缩到 `edge`,返回 `data:image/png;base64`,与内核 `ThumbOut` 字节形状一致;非图片扩展名 reject。
- **顺序**:生成后按名字比较排序,和内核 `natord` 的自然序一致(名字内嵌零填充序号),浏览器两侧行为可对照。
- **实测**(2026-10-08,浏览器 dev,双栏):`数据集-10万` 拉取 295ms、`数据集-50万` 472ms;50 万条目下 DOM 常驻节点约 200(列表)/500(网格),滚动 1400px/帧时 p50 ≈ 26ms;调试抽屉打开时长任务日志会把 p50 放大到 ≈ 90ms(仅 dev 面板成本)。


---

## 6. 基座内建(非插件)对照清单

这些是"应用外壳"级、含业务为零的东西,归基座(A 落位),**不做成插件**:

| 项 | 库 | 说明 |
|---|---|---|
| 布局骨架 + **外层槽** | React + Mantine | 01 §9.1 网格:`activity-rail / topbar / nav(B) / main(C) / detail(D) / statusbar` 六区 + 根挂载;外壳控件(会话标签、折叠按钮、主题切换、分隔条)一律 Mantine |
| **主题(亮/暗/跟随系统)** | `MantineProvider`(`defaultColorScheme="light"`)+ `useMantineColorScheme` | 基座顶栏 `SegmentedControl` 与 `plugin-settings` 面板操作**同一个** Mantine 配色值(共享单例)→ 天然同步,持久化 key `mantine-color-scheme-value` |
| **顶部多标签会话容器** | React + Mantine `Tabs` | 每会话持一份 §3 级联引用快照;切会话整组还原 |
| **嵌套槽运行时** | 自写 slot registry(动态) | `provideSlot`/`contributeToSlot` + `slot:*` 生命周期 + 稳定 paneId 子树迁移(02 §4.5);容器插件才能 provides |
| 元状态(级联引用) | `zustand`(已在用) | `activeTabId`/`activeSidebarView`/`sidebarSelection`/`focusRef`/`activeDetailTab`(不透明 `Ref`,基座不解释) |
| 事件总线 | 自写 + `@tauri-apps/api` | 后端事件→前端(已实现桥) |
| `PluginHost` | plugin-sdk | invoke/on/emit/state + 命令注册(受权限约束) |
| 命令面板 | `@mantine/spotlight` | 基座提供面板,插件注册命令项 |
| 国际化 | `i18next` + `react-i18next`(**未接**) | 基座 provider,插件按需取文案。当前所有界面文案为**中文硬编码**(基座/容器/插件各自内联),多语言属 P6-26 |
| 系统通知 | `@mantine/notifications`(应用内)+ `tauri-plugin-notification`(系统级) | |
| 窗口/单实例/开机 | `tauri-plugin-window-state`/`-single-instance`/`-autostart` | 纯外壳行为,无插槽 |
| 自更新 / 深链唤起 | `tauri-plugin-updater`/`-deep-link` | 发布期接 |
| 用默认程序打开 / 原生对话框 | `tauri-plugin-opener`/`-dialog`(已注册) | 经能力/host API 暴露给插件 |

---

## 7. manifest 草案(格式对 file-browser / file-ops / search)

沿用 02 §2 schema(`schemaVersion=1`,camelCase,`crate` 键)。`plugin-layout-panes` 与 `plugin-file-browser` 是**落地清单**(与仓库一致);`plugin-file-ops`/`plugin-search` 仅示例**分布**,代码未写。

```jsonc
// plugins/plugin-layout-panes/manifest.json  (框架容器:占用 main-view-zone,向下提供 pane-slot:<paneId>)
{
  "schemaVersion": 1, "name": "plugin-layout-panes", "version": "0.1.0",
  "displayName": "分栏容器", "minHostVersion": "0.1.0",
  "frontend": {
    "entry": "frontend/dist/index.js",
    "slots": [ { "id": "main-view-zone", "export": "PanesContainer" } ],
    "provides": ["pane-slot"]
  },
  "permissions": { "capabilities": [], "events": { "subscribe": [], "emit": ["slot:reconfigured"] }, "slots": { "contribute": ["main-view-zone"] } }
}
```

> `slot:registered`/`slot:disposed` 由基座槽运行时随出口挂载/卸载发出,容器无需订阅或声明;容器只按**意图**发 `slot:reconfigured{action:'add'|'remove'}`。

```jsonc
// plugins/plugin-file-browser/manifest.json  (内容插件:每栏一个独立实例;目录树在 view-file-tree)
{
  "schemaVersion": 1, "name": "plugin-file-browser", "version": "0.1.0",
  "displayName": "文件浏览", "minHostVersion": "0.1.0",
  "frontend": {
    "entry": "frontend/dist/index.js",
    "slots": [],                                  // 无固定外层槽;activate() 里 providedSlots("pane-slot") 扫已有栏 + 订 slot:registered/disposed,逐栏 contributeToSlot('pane-slot:<id>', Browser)
    "provides": []
  },
  "permissions": {
    "capabilities": ["fs.home", "fs.list"],       // 规划增强:fs.stat、file.kind、thumb.image
    "events": { "subscribe": ["sidebar:selection:changed", "slot:registered", "slot:disposed"], "emit": ["focus:changed"] },
    "slots": { "contribute": ["pane-slot:*"] }
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
    ],
    "provides": []
  },
  "permissions": {
    "capabilities": ["fs.copy", "fs.move", "fs.trash", "fs.mkdir", "fs.rename", "sys.disk"],
    "events": { "subscribe": ["file:changed"], "emit": ["file:operation:progress", "file:operation:complete"] },
    "slots": { "contribute": ["detail-info-zone"] }   // 操作按钮经运行时注入 inspector 的 detail-info-zone
  }
}
```

```jsonc
// plugins/plugin-search/manifest.json  (全栈:后端建/查索引,前端 spotlight + 结果面板注入 pane-slot)
{
  "schemaVersion": 1, "name": "plugin-search", "version": "0.1.0",
  "displayName": "搜索", "minHostVersion": "0.1.0",
  "backend": { "crate": "plugin-search-backend", "enabledByDefault": true, "config": { "engine": "fts5" } },
  "frontend": {
    "entry": "frontend/dist/index.js",
    "slots": [ { "id": "command-palette", "export": "SearchPalette" } ],   // 结果面板运行时 contributeToSlot('pane-slot:<n>', SearchResults)
    "provides": []
  },
  "permissions": {
    "capabilities": ["search.query", "fs.list"],
    "events": { "subscribe": ["file:changed"], "emit": ["search:results"] },
    "slots": { "contribute": ["pane-slot:*"] }
  }
}
```

> **容器 vs 内容**:容器插件(`provides` 非空)占用一个外层槽并向下提供嵌套槽;内容插件用 `frontend.slots` 声明固定槽(外层或容器嵌套槽),或在 `activate()` 里 `host.contributeToSlot('pane-slot:<paneId>', Comp)` 注入动态槽(故 `frontend.slots` 留空、改在 `permissions.slots.contribute` 授权前缀,如 `pane-slot:*`)。声明式槽条目可带 `label`(真实例子:`{ "id": "detail-tab:history", "export": "HistoryPanel", "label": "历史" }`),容器用 `host.slotLabel(id)` 题名;空白 `label` 在装载期即被 `validateManifest`/Rust `validate()` 拒。动态槽的数量由容器决定,内容插件靠 `providedSlots(prefix)` + `slot:registered`/`slot:disposed` 发现并跟随,不扒 React 内部。每栏放哪个内容插件、如何切换,是 `plugin-layout-panes` 的容器职责(P6-46)。
> 后端插件**只声明并使用能力**,不直连 `trash`/`tantivy`——那些库在能力层(B)。search 后端唯一例外可直连索引库(若索引本身被视为重能力,则同样封进 `search.query` 能力,后端插件仅编排)。二选一在 P6-9 评估时定,记进 05 决策。

---

## 8. 与 Phase 6 / 06 的双向映射

- 本目录 §4/§5 每行都标了对应 **P6-* 任务**与 **06 库**;做某插件时,按它拉起的 P6 任务清单装库、加能力、跑 `contract:check`。
- 反过来:roadmap Phase 6 若新增库需求,先回填本文(该库归 A/B/C/D/E 哪层),再实现——保持"库必先有归属"。

**建议实现顺序**(每步都产出可 dogfood 的新插件并验证架构):
0. **框架/布局先行(P6-43~48/54/55,已交付)**:基座补外层区域网格 + 顶部会话容器 + 嵌套槽运行时(provide/contribute + `slot:*` 生命周期 + 稳定 paneId 迁移),再落 `plugin-layout-panes`(C 分栏)、`plugin-inspector`(D tab 容器)、`plugin-layout-views`(B 视图互斥),并把最小浏览能力拆成 `plugin-file-browser`(每栏实例)与 `view-*` 侧栏视图。**先立外壳与级联状态,后续业务插件才有稳定的挂载点**——现在挂载点已稳定,基座内零业务状态。
1. **file-browser 增强**(✅ 每栏独立地址栏+历史前进后退、列表/网格统一虚拟滚动已交付,见 P6-59;剩余:缩略图 `thumb.image`、标签 chips(需跨插件读标签数据→须先定数据归属,不破插件隔离)、表格视图 `@tanstack/react-table`、网格修改时间需 `ListEntry` 加 mtime)。
2. **file-ops**(首个新增后端能力 + 进度事件 → 验证能力层扩展 + 契约两侧同步 + 错误隔离在写操作上的表现)。
3. **search**(验证重能力/索引 + spotlight 命令注册)。
4. **preview 家族**(✅ text 已交付纯文本路线,高亮待 P6-22;下一步 markdown→image,验证单消费者库打进插件 dist + preview-zone)。
5. **file-history 增强(diff)**:复用 preview 的 diff-view 与 `text.diff` 能力。
6. 视需要:archive / storage-analysis / details / settings / media。
