# 01 · 架构设计

本文定义系统的分层、进程模型、数据流与解耦红线。所有实现必须遵守这里的边界。

---

## 1. 分层总览

```
┌───────────────────────────────────────────────────────────────────┐
│  Tauri v2 单进程                                                     │
│                                                                     │
│  ┌───────────────────────────── WebView ─────────────────────────┐ │
│  │  前端基座 (React 19 + Vite)                                     │ │
│  │   · 外层区域网格:活动栏/侧栏/主视图/详情/工具栏/状态栏(见 §9) │ │
│  │   · <PluginSlot name=... />  插槽(外层 + 容器提供的嵌套槽)     │ │
│  │   · 级联元状态(不透明引用 selection/focus,见 §9.2)            │ │
│  │   · 前端事件总线 (EventBus)                                      │ │
│  │        ▲                                                          │ │
│  │        │ 运行时 import()  (自定义协议 plugin://)                  │ │
│  │   ┌────┴──────────────────────────────────────────────┐        │ │
│  │   │ 前端插件 (ESM,可运行时 drop-in)                     │        │ │
│  │   │  plugin-file-history/frontend, plugin-*/frontend    │        │ │
│  │   └─────────────────────────────────────────────────────┘        │ │
│  └───────────────┬───────────────────────────────▲────────────────┘ │
│                  │ invoke('capability', args)     │ emit(event, payload)
│                  ▼ (前端→后端 命令)                │ (后端→前端 事件)
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  Rust 侧                                                          │ │
│  │                                                                  │ │
│  │  能力层 (Atomic Capabilities)  #[tauri::command]                 │ │
│  │   fs.read_chunk / fs.list / hash.compute / db.* ...  (无业务)    │ │
│  │        ▲ 进程内函数调用(非 IPC)                                  │ │
│  │        │                                                         │ │
│  │  后端内核 (cordis-rs / Cordis v3 runtime, tokio)                 │ │
│  │   Context · Service(DI) · Event(类型化) · Effect · Fiber         │ │
│  │        ▲ ctx.spawn(Plugin)                                       │ │
│  │   ┌────┴───────────────────────────────────────────────┐       │ │
│  │   │ 后端插件 (静态编译的 Rust crate)                     │       │ │
│  │   │  plugin-file-history-backend, plugin-*-backend       │       │ │
│  │   └──────────────────────────────────────────────────────┘       │ │
│  └────────────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
```

**四层职责**

1. **能力层(Atomic Rust)**:纯原子操作工具箱,`#[tauri::command]` 暴露给前端,同时以进程内函数/`Service` 暴露给后端插件。**不含任何业务策略**。
2. **后端内核(cordis-rs)**:插件运行时。负责生命周期(`spawn`/`dispose`)、依赖注入(`Service`)、类型化事件(`Event`)、确定性清理(`Effect`)、并发隔离(`Fiber`)。
3. **后端插件(Rust)**:业务逻辑。实现 cordis-rs 的 `Plugin` trait,订阅事件、调用能力、维护自己的状态。
4. **前端(基座 + ESM 插件)**:UI。基座提供布局、插槽、元状态、事件总线;前端插件是运行时加载的 React 组件。

---

## 2. 进程与运行时模型

- **单进程**:整个应用是一个 Tauri v2 进程。Rust 侧同时跑「能力层」和「cordis-rs 内核」;WebView 侧跑 React。
- **无 sidecar / 无 Node / 无嵌入式 JS 引擎**:后端插件是原生 Rust,直接编进宿主。
- **异步运行时**:cordis-rs 基于 tokio;Tauri v2 通过 `tauri::async_runtime`(底层也是 tokio)驱动异步。内核的 `Context::new()` 与各插件 `Fiber` 需运行在一个 tokio 运行时上。
  - **集成方式(待 Phase 0 验证)**:优先复用 `tauri::async_runtime::spawn` 来驱动 cordis fiber;若 cordis-rs 对运行时有多线程/`LocalSet` 等特定要求,则在 Tauri `setup` 钩子里起一个专用 tokio 运行时线程承载内核。**这是本项目头号技术风险,必须在写业务前先跑通一个最小 "hello fiber" 验证**(见 roadmap Phase 0)。
- **引导顺序**:
  1. Tauri 启动 → `setup` 钩子。
  2. 初始化能力层(注册 `#[tauri::command]`)。
  3. 引导 cordis-rs `Context`,按配置(cordis-loader)依次 `spawn` 内置后端插件。
  4. WebView 加载 React 基座 → 基座读取插件清单 → 对启用的前端插件执行 `import()` → 组件挂载到对应 `<PluginSlot>`。

---

## 3. 后端内核:cordis-rs 概念映射

cordis-rs 是 "a typed runtime for long-lived, plugin-oriented Rust applications",是 Cordis(Cordis v3)架构思想的 Rust 重新设计。核心概念与本项目用法:

| cordis-rs 概念 | 含义 | 在本项目的用法 |
|---|---|---|
| `Context` | 一个运行时的句柄:监听注册、事件派发、Effect、Service、插件 spawn | 全局唯一内核上下文;能力层与插件都通过它交互 |
| `Plugin` | 可复用行为契约:`Config` → `prepare()` → `Input` → `apply(ctx, input)` | 每个后端插件实现它 |
| `Service`(marker trait) | 把一个 Rust 类型绑定到一个具名服务契约(DI) | 能力层以 Service 形式提供给插件;插件间共享能力也走 Service |
| `Event`(具名类型化) | 运行时内的类型化事件契约 | `file:changed`、`history:updated` 等;后端 `ctx.on/emit`,并桥接到前端 |
| `Effect` | 按 generation 归属、至多一次声明的清理义务 | 插件卸载时自动清理监听器/句柄,无需手动 thread |
| `Fiber` / `FiberHandle` | 轻量执行单元,隔离并发与状态;`dispose().await` 确定性卸载 | 每个插件实例 = 一个 fiber;禁用插件 = dispose 其 fiber |

**插件生命周期(源码模型)**:
```
Config ──Plugin::prepare()──▶ Input ──PreparedPlugin::from_input()──▶ PreparedPlugin ──Context::spawn()──▶ FiberHandle/Fiber
```
禁用/热重组 = `fiber_handle.dispose().await`(旧 generation 的 Effect 全部清理)→ 按新配置重新 `spawn`。这正是 cordis-loader + 运行时启用/禁用的落地方式。

---

## 4. 前后端桥接(Tauri IPC)

桥接只有两个方向、两种机制,插件不得绕过:

### 4.1 前端 → 后端:`invoke`(命令)
- 前端插件只能调用**能力白名单**内的 `#[tauri::command]`(如 `invoke('fs_read_chunk', {...})`)。
- 命令是原子的、无业务策略的。业务编排要么在前端插件内完成,要么由后端插件完成后再经事件回传。

### 4.2 后端 → 前端:`emit`(事件)
- 后端插件 `ctx.emit::<E>(payload)` 发出的领域事件,由内核的**事件桥**转发为 Tauri 事件(`app.emit` / `emit_to`)。
- 前端基座的事件总线订阅这些 Tauri 事件,再以统一的前端事件名广播给前端插件。
- 事件负载必须可 JSON 序列化(跨 IPC 边界)。

### 4.3 元状态广播
- 基座维护的全局元状态(不透明引用,如 `focusRef`/`sidebarSelection`,见 §9)变化时,通过前端事件总线广播;前端插件订阅。**基座不把元状态推给后端**,后端若需要,由插件显式 `invoke` 上报。

> 事件命名与负载 schema 的规范见 [02-plugin-spec.md](02-plugin-spec.md) §5。

---

## 5. 典型数据流

### 流 A:前端插件读取文件分块并算哈希(前端发起)
```
前端插件 UI 点击
  → invoke('fs_read_chunk', {path, offset, len})   [能力层]
  → invoke('hash_compute', {path, algo:'md5'})      [能力层]
  → 结果回前端插件,局部渲染
```

### 流 B:文件变更 → 后端记录历史 → 前端时间线更新(后端事件驱动)
```
文件监听(能力层, notify)── emit file:changed ──▶ 内核事件管道
  → plugin-file-history-backend 的 ctx.on::<FileChanged>() 触发 (Fiber)
  → 调用能力层 hash_compute,与上次比对
  → 有变动 → 调用能力层 db.* 写入历史
  → ctx.emit::<HistoryUpdated>(payload)
  → 事件桥 → Tauri emit → 前端事件总线
  → plugin-file-history/frontend 的时间线面板收到并刷新
```
注意:流 B 中前端插件**不主动轮询**,完全由后端事件驱动;前后端两个插件物理隔离,只靠 `history:updated` 事件契约通信。

---

## 6. 解耦红线(开发生死线)

违反任意一条即视为"伪插件化",必须在评审中拦下:

1. **物理零导入(No Direct Import)**
   - 后端:插件之间、插件与基座之间禁止 `use another_plugin::...`。所有交互只能通过 cordis-rs 的 `ctx.on/emit`(事件)与 `Service`(依赖注入)。
   - 前端:插件之间、插件与基座之间禁止 `import ... from '../../another-plugin'`。所有交互只能通过前端事件总线与基座注入的 host API。

2. **基座无状态化(Stateless Host)**
   - 基座不知道"文件有历史版本""文件可上云"等业务概念。基座只维护 `activeTabId`/`activeSidebarView`/`sidebarSelection`/`focusRef`/`activeDetailTab` 这类**不透明全局元状态引用**(见 §9.2),不含业务语义。业务数据全部由插件订阅元状态后自行维护。

3. **原子化 Rust(Atomic Rust)**
   - Rust 能力层只提供 `read_file_chunk`、`compute_hash`、`db_query` 等基础工具箱,**不写针对特定插件的业务逻辑**。业务策略全封在 cordis-rs 后端插件里。

4. **前后端插件解耦(Front/Back Split)**
   - 同一个逻辑插件的前端与后端不共享内存、不共享代码。它们只通过**事件契约**和**能力契约**通信。前端可独立更新(运行时加载),后端随宿主构建。

---

## 7. 关键边界与约束

- **后端插件 = 编译期内置**:第三方无法在运行时向宿主注入新的后端 Rust 代码。运行时的"可安装扩展"仅指前端 ESM 插件,且只能调用已内置的能力。这是本项目**有意接受**的边界(安全 + 无稳定 ABI 风险),不是缺陷。理由见 [05-decisions.md](05-decisions.md)。
- **前端插件 = 运行时加载**:经自定义 Tauri 协议(`plugin://`)下发 ESM 文件,基座用 `import()` 装载。共享依赖(React 等)通过 import map / 全局注入,避免每个插件各打一份。
- **权限**:每个插件在 manifest 声明所需能力与事件;基座/内核在装载与调用时校验白名单。未声明的能力调用一律拒绝。
- **错误隔离**:前端插件运行时的异常不得击穿基座(装载失败降级为空插槽 + 记录);后端插件的 fiber panic/错误由内核捕获并 dispose,不影响其它插件与主进程。
- **样式隔离**:UI 组件库统一用 **Mantine**(作为共享单例提供),前端插件自定义样式走 CSS Modules;**不用 Shadow DOM 包裹插槽**——Mantine 的 Modal/Menu/Tooltip/Notifications 经 portal 渲染到 `document.body`,Shadow DOM 会导致浮层丢样式。主题一致性由 Mantine CSS 变量保证。

---

## 8. 插件分解与库归属

规划期选定的一大票开源库(见 [06](06-open-source-stack.md))不是一股脑装进基座,而是**每个库必先归入下列五层之一**再落地。具体"哪个库进哪个插件"见 [08-plugin-catalog.md](08-plugin-catalog.md);本节只定**归属规则**(与 §6 红线一致):

| 落位 | 判据 | 隔离方式 |
|---|---|---|
| **A 基座** | 跨一切插件共用 / 属应用外壳、零业务 | React + Mantine 共享单例;`PluginHost` 注入 |
| **B 能力层**(`kernel/capabilities`) | 重第三方库、可多插件复用、原子无策略 | 只经 `domain.action` 能力契约对外;换库不外溢 |
| **C 后端插件** | 有业务语义、静态内置(R4) | 只 `ctx.on/emit` + DI 拿能力句柄,不 `use` 他插件 |
| **D 前端共享单例**(import map) | **多消费者 + 必须单例**(hooks) | 仅 react/react-dom/@mantine/*/plugin-sdk |
| **E 前端插件自带 bundle** | **单消费者**、无单例约束 | 打进该插件 ESM dist,保持 drop-in 自包含 |

要点:
- **D/E 的分界是"是否多消费者且要求单例"**。功能库(哪怕大,如 CodeMirror/echarts/arborist)只要单插件用,就打进插件自己的 dist,**不进共享集**;共享集永远只放框架 + Mantine。
- **B/C 的分界是"原子 vs 业务"**。`image` 缩放是能力(B);"何时给哪些文件生成缩略图"是业务(C 或前端插件用 B)。
- **缩略图只经 `thumb.image` 能力**(PNG data URL),不走 `file:`/asset URL:否则拿到路径就等于绕过 `permissions.capabilities` 读任意文件。前端按可见卡片懒取 + 负缓存(见 08 §5.1)。
- **目录顺序由 provider 负责**:`fs.list` 返回自然序、忽略大小写(`natord`),并直接带 `modifiedMs`。浏览器拿到 10 万条时不再做任何排序,头部日期列也不产生 N 次 `fs.stat`。
- **重依赖(ffmpeg/pdfium/tantivy/monaco)默认做成独立能力 + 独立插件**,按需启用,不占核心路径。
- 新增前端功能一律**插件化**以持续 dogfood 架构;新能力落 B 后**同步 `core-shared/contracts`↔`plugin-sdk` 两侧并跑 `contract:check`**;新事件先冻结进 02 §7.1。
- **插槽分两类**:基座预留的**外层区域槽**(见 §9),与容器插件提供的**嵌套槽**(如 `pane-slot:<paneId>`、`nav-panel:<viewId>`、`detail-tab:<name>`)。普通插件只注入;只有三个框架**容器插件**(分栏容器、视图互斥容器、详情容器)提供嵌套槽,机制见 02 §4.5。元状态只存不透明引用(selection/focus 的 `{kind,id,sourcePlugin}`),业务数据由插件自持(见 §6.2)。

---

## 9. 界面区域模型与级联状态

界面是一台**级联的选择/派生状态机**,自上而下由"外层区域(基座) + 各区域内容(插件)"构成。本节定区域划分、级联关系与基座/插件归属;具体槽清单见 08 §2,嵌套槽机制见 02 §4.5。**颜色与组件一律复用 Mantine 主题(默认亮色,顶栏可切 跟随系统/亮色/暗色),本节只定布局与状态。**

### 9.1 区域网格(基座持有的外壳)

```
┌─────┬────────┬───────────────────────────────┬──────────────┐
│LOGO │ 顶部多标签页 tabs(浏览会话)              │              │
│     ├────────┼───────────────────────────────┤  D 详情容器   │
│ A   │ 工具栏:面板开关 + topbar-zone 扩展位      │  (通高)      │
│ 活动 ├────────┼───────────────────────────────┤  = 嵌套槽     │
│ 栏  │ B 侧栏  │  C 主视图 = 分栏容器            │  detail-tab:* │
│     │(nav-pane│  pane-slot:p0..p3(1/2/4 栏)   │  preview-zone │
│ 图标│  l:<id>)│  每栏一个内容插件实例(独立地址栏)│  file-ext-zone│
├─────────────┴───────────────────────────────┴──────────────┤
│ 状态栏 statusbar-zone                                          │
└──────────────────────────────────────────────────────────────┘
```

- **A 活动栏**:**侧栏视图的切换器**(不是浏览标签)。选哪个图标 → B 显示对应视图。底部"设置"入口由 `plugin-settings` 自己贡献齿轮图标(基座不硬编码),点击打开**悬浮面板**(Mantine `Popover`,经 portal 渲染,不占六区任何一格)——设置不是一种侧栏视图,不进 B 的互斥集合。各视图插件向 `activity-rail-zone` 注入图标。
- **B 侧栏**:当前 A 视图的**面板内容**(文件树 / 收藏列表 / 标签列表 / 模拟数据…)。`nav-zone` 由**容器插件 `plugin-layout-views`** 占用,它向下提供 `nav-panel:<viewId>` 并**负责视图互斥**(只显示活动视图,其余隐藏);视图插件不得自己判断活动视图来 self-hide。
- **C 主视图**:B 选中项的**内容展开**(选中文件夹→该目录文件列表;选中标签→该标签下文件)。外层由**分栏容器插件 `plugin-layout-panes`** 占用,可切 1 栏 / 左右 2 栏 / 2×2 四栏,向下提供 `pane-slot:<paneId>`;`plugin-file-browser` 按 outlet 自动为每栏注入一个独立实例(各自目录与**独立历史栈**(后退/前进/上级/刷新)、列表或网格模式、选择)。容器头部显示中文 `栏 N`,槽 id 只作悬停提示。
- **栏高不变量由容器 owner 强制**:`plugin-layout-panes` 把每个栏渲染成**有界 flex 列**(栅格行轨 `minmax(0,1fr)` + 栏 `display:flex/min-height:0`),outlet 只 `overflow:hidden` **不滚动**——滚动权属于内容插件。这样插件里的虚拟滚动(见 08 §5.1)天然拿到确定视口高度,内容插件无须各自猜测父容器高度。
- **D 详情容器**:焦点对象的**上下文检查器**,由 `plugin-inspector` 占用 `file-sidebar-zone`,用 tab 承载。顶部是**焦点标题条**(名称 / 整路径 / 类型徽标);tab 条 = 基座"信息" + `contributedSlots("detail-tab")` 扫到的插件页,**标题取贡献者自己声明的 `host.slotLabel(id)`**(容器不硬编码他插件的名字);正交于**内容模板**(随焦点 kind 切换:文件 = 扩展区+预览+信息 / 文件夹 = 扩展区+信息 / 其他 = 仅信息),空区域显示中文占位。
- **顶部多标签页**:独立的**浏览会话**层。每个会话各持一份 `{activeSidebarView, sidebarSelection, focusRef, activeDetailTab}` 元状态快照,分栏容器另持该会话的 `{mode, ids, colPct, rowPct}`;切会话整组还原——这是"切换不混乱"的保证。分栏**面板实例按会话隔离**,两个会话不共享同一个 `pane-slot:p0`。

### 9.2 级联链(单向派生)

```
activeSidebarView(A) → sidebarSelection(B) → focusRef(C) → activeDetailTab(D)
```
- 基座只搬运**不透明引用** `{kind, id, sourcePlugin}`,不解释 kind 的业务含义。
- 每层订阅上游引用、渲染、并在用户交互时回写下游引用。区域插件各持**局部状态**,互不越界。
- C 有多个栏时,`focusRef` 仍是**会话级单值**:用户在某栏点条目 → 该栏发布 `focus:changed` 并成为该会话的"最后交互栏";B 的 `sidebar:selection:changed` 只驱动这一栏,其余栏忽略(引用里的 `sourcePlugin`/`kind` 由插件自行解释,基座不枚举)。这套"谁最后交互谁接收"记在内容插件本地,不是基座状态。


### 9.3 基座 vs 插件(务实版边界)

| 归属 | 内容 |
|---|---|
| **基座(外壳,不做插件)** | 窗口、根挂载、**外层区域网格**(A/B/C/D/工具栏/状态栏)、顶部多标签会话容器、主题 provider(默认亮色 + 顶栏三态切换控件)、元状态总线、嵌套槽运行时(见 02 §4.5)、插件加载/权限、**插件运行态(装载/卸载/启停)由 loader 独占**:它对外提供 `plugins.list`/`plugins.setEnabled` 两个基座前端能力(见 02 §5.3),**哪些插件不可关闭也是基座策略**,manifest 无法自我豁免 |
| **容器插件(提供嵌套槽)** | `plugin-layout-panes`(拥有 C 的分栏几何,提供 `pane-slot:<paneId>`)、`plugin-layout-views`(拥有 B 的视图互斥,提供 `nav-panel:<viewId>`)、`plugin-inspector`(拥有 D 的 tab 条与模板,提供 `detail-tab:<name>`/`preview-zone`/`detail-info-zone`/`file-extension-zone`)、`plugin-settings`(拥有设置悬浮面板的分页,提供 `settings-page:<name>`) |
| **视图插件(注入 B)** | `plugin-view-file-tree` / `plugin-view-favorites` / `plugin-view-tags` … 各贡献一个 A 图标 + 一个 `nav-panel:<viewId>` 面板 |
| **内容插件(注入 pane-slot)** | `plugin-file-browser`(每栏一个实例:独立地址栏与历史栈 / 列表 / 网格)、search 结果、archive 等 |
| **功能插件(注入 D 的 tab/区域)** | `plugin-file-history`(detail-tab:history)、`plugin-file-details`(信息表 + BLAKE3,注入 detail-info-zone)、`plugin-preview-text`(preview-zone,纯文本;高亮待 P6-22)、`plugin-file-ops`(操作按钮) |
| **功能插件(注入设置面板)** | 任何插件都可贡献 `settings-page:<name>` 一页(标题写自己的 `slots[].label`):页内容只该插件认得,读写**自己的** localStorage 键,并由同插件内的模块级偏好 store 广播给已渲染的实例,使设置**即时生效**而不经基座状态 |

要点:外层网格与总线**留在基座**(稳定、零业务),只把**多变的部分**插件化;提供嵌套槽的容器目前为四个——三个界面框架容器(分栏 / 视图互斥 / 详情)加设置悬浮面板容器 `plugin-settings`。`layoutMode`/`panes`(每栏 id 与比例)属 `plugin-layout-panes` **局部状态**,不上基座;`activeDetailTab` 是级联终点、住在基座元状态里(D 容器读它、用户点 tab 时发 `detail:tab:changed`)。跨区协调只走 §9.2 的不透明引用。
