# 09 · 插件功能规格与交互数据契约

> 本文将现有架构和插件目录转成可执行的产品/开发规格，供后续逐个实现、联调与验收。它覆盖插件生命周期、界面与动效、状态、存储、能力调用、插件间交流和异常恢复。
>
> **状态标识**：✅ 代码已实现（仍需按本规格逐项验收）；🟡 已有基础功能，完整功能待补；🔵 规划功能；⚪ 技术方案待决。文中“目标行为”是下一阶段的开发要求，不代表代码已经提供。代码与本规格不一致时，先确认差异，再更新规格或实现；不要把规划事件当成现有契约直接调用。
>
> **逐插件功能文档现已拆分到 [`docs/plugin-functional/`](plugin-functional/README.md)**。本文件保留全局状态、运行时、通用数据流与跨插件契约；插件级的具体职责、数据处理、交互/显示/动效、状态和存储以该目录对应插件文档为准。

## 1. 目标与适用范围

本规格用于把“插件能加载”推进到“插件功能完整、状态可预测、交互可验收”。每个插件都必须写清：用户入口、允许的动作、显示状态、异步流程、状态归属、持久化规则、依赖能力和事件、失败与卸载行为。新插件须在 manifest、SDK/契约、本文功能条目及 [08 插件目录](08-plugin-catalog.md) 中保持一致。

目标架构仍是 Tauri v2 单进程、React + Mantine 基座、运行时加载的前端 ESM 插件、编入宿主的 Rust 后端插件。基座只负责外壳、插槽、权限门、元状态、事件桥接和插件生命周期；业务数据及其解释由拥有该业务的插件负责。完整分层见 [01 架构](01-architecture.md)，manifest、SDK 与权限字段见 [02 插件规范](02-plugin-spec.md)。

## 2. 运行时与责任边界

### 2.1 一个插件实例的生命周期

```text
启动宿主
  → 发现并校验 manifest
  → 根据禁用清单和核心保护规则筛选
  → 按索引顺序动态 import 前端 ESM
  → createHost 注入受限 PluginHost
  → activate(host)：订阅事件、监听状态、注册动态嵌套槽
  → 挂载 manifest 声明的 slot exports
  → 处理用户交互与数据更新
  → disable/unload：调用 teardown，撤销订阅与注入，释放该插件所有槽
```

- 前端入口导出 `activate(host)` 和 manifest 中声明的命名组件。`activate` 只做安装期工作；必须返回或登记可重复安全的清理函数。组件卸载与插件停用都不得留下监听、计时器、进行中的异步更新或跨插件引用。
- 前端插件加载、manifest 校验、`activate` 或单个插件渲染失败时，只隔离该插件；宿主和其他插件继续工作。错误需进入开发日志，用户区域显示可恢复的中文错误或空状态。
- Rust 后端插件按 Cordis `prepare → spawn → dispose` 生命周期运行。Fiber 错误/取消不能破坏其他插件；Effect 负责监听器、任务和句柄清理。
- 核心容器 `plugin-layout-panes`、`plugin-layout-views`、`plugin-inspector`、`plugin-settings` 由宿主保护，不允许从设置关闭。其他插件停用时立即卸载其 UI/事件订阅；重新启用时重新加载，不保证恢复未持久化的临时组件状态。
- 前端插件可运行时启停；后端插件是静态编译内容，变更后端插件代码需要重新构建宿主。不要在 UI 中暗示能单独安装任意 Rust 插件。

### 2.2 前后端及插件间的边界

```text
用户动作 → 前端插件 → host.invoke(已授权原子能力) → Rust 能力层
                                  ↓
                         前端局部状态/渲染

文件系统/后端工作 → Rust 能力 → Cordis 业务插件
                                  ↓ 类型化领域事件
                           Tauri 事件桥
                                  ↓
                          前端事件总线
                                  ↓
                       订阅该契约的前端插件
```

- 前端插件只能通过注入的 `PluginHost` 读元状态、订阅/发布白名单事件、调用白名单能力、贡献或提供插槽。禁止直接导入另一个插件、读取宿主内部 store、跨插件读取 localStorage/数据库分区。
- 后端插件之间通过 Cordis `Event` 发布/订阅，或通过明确注册的 `Service` 获取共享原子能力；不直接依赖另一业务插件 crate。
- 能力只做可复用的原子操作，不决定业务流程、用户默认值或 UI 展示。业务编排放在对应插件。
- 前端事件仅在 WebView 内；跨 Tauri IPC 的领域事件必须是 Rust/TypeScript 两侧一致的 JSON 契约，并通过 `contract:check`。事件到达顺序不应被当作事务保证。
- `host.emit` 本身是广播，不是定向 RPC，也不返回对方处理结果。需要结果时，显式调用 capability；不能用“发事件后等另一个插件回信”构造无关联 ID 的请求响应。

## 3. 界面、交互、动效与切换的共同规范

### 3.1 界面和输入规则

- 所有插件 UI 使用宿主共享的 Mantine 单例、主题变量和统一密度。区域尺寸、滚动责任由外壳/容器决定；插件不得覆盖全局主题或依赖 Mantine 私有类名。颜色切换入口只在设置内。
- 插件声明其入口槽和插槽贡献权限。容器按贡献者 manifest label 展示标签；内容插件不自绘第二套区域标题或越权控制父容器布局。
- 可交互控件须有可见的中文名称或清晰图标说明、键盘焦点态、禁用态和可访问名称。危险动作要确认；无副作用的选择、浏览和视图切换不增加确认步骤。
- 同一控件的点击、键盘激活和辅助技术激活结果一致。双击打开/单击选择、右键菜单、拖放、快捷键必须由具体功能条目标注支持情况；未列入支持清单时不承诺该手势。
- 长列表/大数据必须虚拟化或分页，不能因数据量增长而将所有行挂载进 DOM。布局容器提供有界高度；内容插件负责自身滚动，不用全局页面滚动模拟列表滚动。

### 3.2 动效与状态转换

动效用于表达因果，不用作装饰。建议基线：普通控件/焦点 120–180ms，菜单/弹层 160–220ms，布局模式与栏宽变化 180–240ms；统一使用 Mantine transition/theme token。禁止长时间弹跳、无限循环和影响数据操作完成时间的动画。

| 转换 | 目标表现 | 约束 |
|---|---|---|
| hover / focus / pressed | 背景、边框、图标或轻微透明度变化 | 立即反馈；键盘焦点不能只靠颜色 |
| 插槽内容加载 | 轻量 skeleton 或局部 loading | 不移动外壳网格；异步完成后保持当前滚动位置 |
| 下拉菜单/Popover | 淡入并轻微位移，关闭淡出 | ESC、外点关闭；焦点返回触发器；位置变化不抖动 |
| 1/2/4 分栏切换 | 网格栏位平滑重排 | 稳定 paneId；不丢每栏路径/历史/组件状态；减少栏隐藏而不是错误串状态 |
| 会话切换 | 内容按新会话快照切换 | 同步恢复活动侧栏、选择、焦点、详情 tab；异步内容须防止旧请求覆盖新会话 |
| 列表/网格切换 | 内容样式过渡 | 同一文件数据与选择保持；切换不能重置目录或重建导航历史 |
| 插件启停 | 开关即时反馈，内容局部卸载/挂载 | 核心插件锁定；失败时回滚 UI 状态并给出原因 |
| 进度 | 真实进度条/阶段状态 | 不伪造百分比；未知总量时用不确定进度，并能显示取消能力（若后端支持） |

用户系统启用了“减少动态效果”时，除状态可读性所需的即时变化外，过渡时长降为近零。动效不能代替 loading/error/success 文案。

### 3.3 所有异步 UI 必须具备的显示状态

每个依赖 IPC、网络/文件 I/O 或后台事件的 UI 单元，都必须定义：`idle`、`loading`、`success/data`、`empty`、`error`；长任务另有 `progress`，可中断任务另有 `cancelling/cancelled`。重复请求采用取消、请求序号或等效机制，旧响应不得覆盖新选择。缓存命中可直接展示旧数据并后台刷新，但需明确标注刷新失败时保留的旧数据。

错误面向用户显示简明原因和可执行动作（重试、返回、选择其他文件）；详细堆栈放开发日志。无权限/文件消失/路径无效/二进制无法作为文本读取/插件停用分别处理，不能都显示为“加载失败”。

## 4. 级联状态、会话与导航行为

基座每个会话维护一份 `HostMetaState`：`activeTabId → activeSidebarView → sidebarSelection → focusRef → activeDetailTab`。其中 `Ref={kind,id,sourcePlugin}` 只是不透明引用，不包含路径、文件属性或业务对象。通过已冻结的协调事件变更，不允许插件直接写基座 store。

| 元状态 | 含义/写入方 | 变化后责任 | 清空/失效规则 |
|---|---|---|---|
| `activeTabId` | 基座会话条；`tab:activated` | 容器切到该会话的布局、选择和焦点快照 | 关闭会话后清理对应会话状态；至少保留一个会话 |
| `activeSidebarView` | 视图图标插件发 `sidebar:view:changed` | `plugin-layout-views` 显示唯一 `nav-panel:<viewId>` | 当前视图插件被停用时选取可用视图或显示空侧栏 |
| `sidebarSelection` | 侧栏视图发 `sidebar:selection:changed` | 浏览器按引用选择目的地/标签/数据集 | 新引用不再有效时清空或由拥有者解析；不能猜测引用内容 |
| `focusRef` | 内容插件发 `focus:changed` | inspector/detail、preview、属性和历史插件按 kind 取数 | 切目录或焦点对象不存在时发送 `null`；异步响应按当前 ref 校验 |
| `activeDetailTab` | inspector 发 `detail:tab:changed` | D 区显示对应详情页 | tab 贡献移除时切到“信息”默认页或首个有效 tab |

`selection:changed{fileId}` 是 `focusRef.kind === "file"` 的兼容投影；新插件优先订阅 `focus:changed` 并检查 `kind`。旧事件在移除消费者前保持兼容，不能出现两份可独立写入的选择状态。

顶部会话不是插件。每个会话的分栏布局和每栏路径/模式分别以会话 id 隔离。跨会话切换不应把 A 会话的焦点带入 B 会话；切回 A 时应恢复其快照。关掉有焦点的会话后，激活邻近会话并恢复其完整快照。

## 5. 插槽发现、贡献与重配置

外层槽由基座固定：`activity-rail-zone`、`topbar-zone`、`nav-zone`、`main-view-zone`、`file-sidebar-zone`、`statusbar-zone`、`bottom-drawer`、`command-palette`。容器通过 `frontend.provides` 声明嵌套前缀，内容插件同时需声明 `permissions.slots.contribute` 授权。每个提供/贡献操作都由基座校验。

1. 插件启动先调用 `providedSlots(prefix)` 补齐已经存在的 outlet，再订阅 `slot:registered`，避免错过先于插件启动的出口。
2. outlet 新增后，容器发出 `slot:reconfigured{slotId,action:"add"}` 表达布局意图；运行时发 `slot:registered` 告知真实挂载。贡献者只在当前会话/栏位规则允许时注入。
3. outlet 卸载时运行时发 `slot:disposed`；贡献者撤销该 outlet 的贡献并清理绑定数据。容器移除栏位还须发 `slot:reconfigured{action:"remove"}`。
4. 事件处理必须幂等：重复注册不创建重复 contribution；未知前缀、未授权目标、无效 manifest 记录诊断并安全跳过。
5. 禁用插件时由 loader 回收其全部贡献、出口和事件订阅。slot id 仅作为地址/调试信息，不能用它当业务数据通道。

稳定 paneId 在布局变更期间复用；只保留能映射到当前模式的有效 pane，不将位置序号误当成业务身份。容器负责 `min-height:0`、有界 flex/grid 与 outlet 几何；内容插件滚动其自身视口。

## 6. 能力调用、事件交流与数据契约

### 6.1 当前已存在的事件

| 名称 | 范围 | 负载 | 当前生产者 → 消费者 | 语义 |
|---|---|---|---|---|
| `tab:activated` | 前端 | `{tabId:string}` | 基座 → 所有订阅者 | 激活会话并恢复其级联快照 |
| `sidebar:view:changed` | 前端 | `{viewId:string}` | 侧栏入口 → layout-views/关心该视图的插件 | 选择 A 区视图 |
| `sidebar:selection:changed` | 前端 | `Ref \| null` | tree/favorites/tags/mock-data → file-browser | B 区选择引用，驱动 C 区 |
| `focus:changed` | 前端 | `Ref \| null` | file-browser/tags 等 → inspector/file-details/preview/history | C 区焦点对象，驱动 D 区 |
| `selection:changed` | 前端兼容 | `{fileId:string \| null}` | 基座从 focus 投影 → 旧插件 | 只表示文件焦点，不是独立状态 |
| `detail:tab:changed` | 前端 | `{tabId:string}` | inspector → 详情消费者 | D 区活动 tab |
| `slot:registered` | 前端 | `{slotId:string}` | 槽运行时 → 动态贡献插件 | outlet 已真实挂载 |
| `slot:disposed` | 前端 | `{slotId:string}` | 槽运行时 → 动态贡献插件 | outlet 已卸载 |
| `slot:reconfigured` | 前端 | `{slotId:string,action:"add"\|"remove"}` | 容器 → 动态贡献插件 | 容器意图变更，补充运行时挂载事件 |
| `file:changed` | Rust → Tauri → 前端 | `{path:string,kind:string}` | watch 能力 → file-history 等 | 路径内容变化；不得假定是单次、完整快照 |
| `history:updated` | Rust → Tauri → 前端 | 当前 `{path:string}`；Lore 迁移后扩为 `{repositoryId:string,path:string}` | file-history backend → 历史 UI | 历史/dirty 状态失效提示；消费者按当前焦点决定刷新，不承载版本数据 |

以上 payload 以 SDK/contracts 为准。任何字段改动都先同步 Rust DTO、TS SDK、权限清单、文档与 `contract:check`。前端协调事件不进入 Rust 契约；后端领域事件必须可 JSON 序列化。

### 6.1.1 历史展示插件规划事件

| 名称 | 范围 | 负载 | 生产者 → 消费者 | 语义 |
|---|---|---|---|---|
| `lore:revision:creating` / `lore:revision:created` / `lore:revision:create-failed` | Rust 内部领域事件 | `{operationId?,repositoryId,path,revisionId?,fileFingerprint?,captureHandle?}` | Lore adapter/服务器通知订阅 → history-metadata backend | 覆盖应用内创建和连接同一 Lore 服务的 LoreGUI 创建；创建后提供 revision 绑定只读采集上下文；capture 失败不得阻塞 Lore commit |
| `history:metadata:updated` | Rust → Tauri → 前端 | `{repositoryId,revisionId,path,status}` | history-metadata backend → 历史面板 | 指定 revision 元数据变更，仅作失效提示，不包含缩略图 bytes |
| `history:revision:restore-requested` | 前端 | `{repositoryId,revisionId,path,focusRef}` | history-metadata 卡片 → file-history UI | 用户请求切换版本；file-history 负责检查、确认并调用 Lore |

上述均为规划契约，必须定义版本化 DTO、权限与取消/去重语义后才能实现。`history-metadata` 不获得 Lore commit/restore capability。

### 6.2 能力与数据处理约定

已实现能力名：`fs.home`、`fs.list`、`fs.stat`、`fs.readChunk`、`fs.readText`、`hash.compute`、`thumb.image`（迁移目标为 Windows 专属 `shell.thumbnail.read`）、`watch.subscribe`、`db.<store>.*`；前端基座自有能力 `plugins.list` 与 `plugins.setEnabled`。具体参数/返回 DTO 以 `core-shared/contracts` 和 SDK 为唯一机器契约。

- 任何文件访问均经 capability，路径由宿主校验/规范化。插件不得用 `file://` 或拼装 asset URL 绕开权限。缩略图返回 data URL；清单读取应携带已支持元数据，避免逐行 `stat`。
- 大文件读分块或流式处理；文本读取须设上限并对二进制/编码失败给明确结果。哈希由后端流式计算；UI 显示进度仅在契约提供真实进度时开启。
- 列表结果按 provider 约定排序，分页/虚拟滚动不得再次复制整个大列表或排序每一行。慢能力调用进入 `loading`；并行请求限流；组件卸载后取消或丢弃结果。
- DB 采用插件独占 store 名称（如 `history`）；每个插件负责 schema/version、升级、清理策略和数据兼容。禁止一个插件查询或修改另一个插件的 store。KV JSON 里业务结构由 owning plugin 定义并验证。
- 文件系统事件可能重复、合并或在 UI 卸载期间到达。后端去重/排序属于业务插件策略；消费者可按 path + 当前状态合并刷新，但不能把事件当成完整文件内容。

### 6.3 插件间交流流程

**侧栏导航到文件夹**：视图插件发 `sidebar:selection:changed({kind:"directory",id:path,sourcePlugin})` → 基座只存 Ref → 每个 file-browser 实例收到事件 → 根据自己的会话和“当前可见栏”规则解析 directory Ref → 更新对应栏目录与导航栈 → `fs.list` → 更新列表并在首次加载时清空不再有效的焦点。

**列表选中文件并驱动详情**：file-browser 发 `focus:changed({kind:"file",id:path,sourcePlugin:"plugin-file-browser"})` → meta store 更新当前会话 → 兼容事件发出 → inspector 选择文件模板 → file-details、统一 preview、file-history 各自判断当前 kind/path 并调用获准能力或展示状态。任一插件失败不阻断其他详情贡献者。

**文件变更刷新历史**：watch → `file:changed` 后端事件 → file-history backend 查询 Lore 仓库工作区状态 → 发 `history:updated` 失效提示 → 前端检查当前焦点路径后重取历史与 dirty 状态。用户显式创建版本时，backend 才调用 Lore stage/commit；成功的 revision 生命周期通知触发 history-metadata 采集版本缩略图/属性并存入独立存储。UI 不轮询。

**布局增加栏**：用户从 topbar 内的分栏下拉选择模式 → layout-panes 更新当前会话布局并分配稳定 paneId → emit `slot:reconfigured(add)` 并挂载 outlet → runtime 发 `slot:registered` → file-browser 扫描已有出口规则后注入新栏组件 → 新栏读取会话|paneId 独立持久化路径，不复用另一栏实例状态。

插件之间传递的是明确的小型契约或不透明 Ref，不直接交换完整文件记录、组件引用或可变 store。事件名、owner、允许 emitter/subscriber、触发条件和兼容策略均登记在 [08](08-plugin-catalog.md) 及插件功能条目中。

## 7. 状态与数据存储策略

| 数据类别 | Owner | 建议/现状位置 | 生命周期与规则 |
|---|---|---|---|
| 当前会话和级联 Ref | 基座 | 内存 Zustand store | 会话切换恢复快照；关闭会话释放；Ref 不放业务字段 |
| 外壳区宽度/折叠 | 基座 | `fm.shell.layout.v2` localStorage | 本机偏好；解析失败回默认；写入失败不得阻断 UI |
| 插件启停 | loader | `fm.plugins.disabled.v1` localStorage | 由基座唯一读写；无存储权限时仅本次会话生效 |
| 分栏模式、栏 id、比例 | layout-panes | `fm.layout-panes.v1` localStorage | 按 `activeTabId` 分区；校验旧/损坏值；pane id 稳定 |
| 每栏路径、模式及浏览历史 | file-browser | `fm.file-browser.v1` localStorage | 按会话和 paneId 隔离；重新打开从安全目录恢复；不存在路径报错并提供回退 |
| 浏览偏好 | file-browser | `fm.file-browser.prefs.v1` localStorage | defaultMode、缩略图等；更改即时广播给所有实例；单栏显式选择优先于默认 |
| 收藏 | favorites | `fm.view-favorites.v1` localStorage（当前） | 插件独占；未来若需要跨端/统一备份再迁移专属 DB store |
| 标签与成员 | view-tags | `fm.view-tags.v1` localStorage（当前） | 插件独占；其它插件不能直接读取。跨插件显示 chips 必须新增受控契约/API |
| 预览偏好 | preview | `fm.preview.prefs.v1` localStorage | `{autoLoadText,maxTextChars,defaultFit}`；双方校验；迁移旧 text 偏好时停止双写 |
| 文件历史与版本 | Lore（由 file-history backend 适配） | 用户选择的 Lore 仓库保存版本正文与提交；插件偏好仅存仓库选择等配置；旧 `db.history.*` 元信息只读保留 | Lore 是版本真相；仓库范围必须用户确认；仓库删除/清理需明确确认；不得把凭据或正文放入偏好 |
| 版本展示元数据 | history-metadata backend | 独占 `db.historyMetadata.*` + 应用数据目录中的缩略图 blob；主键 `(repositoryId,revisionId,path)` | 只保存某个 revision 创建时的展示属性，不存文件正文、不管理 Lore 版本；清理元数据不影响 Lore 历史 |
| Windows 缩略图 | windows-thumbnails capability/provider | Windows Shell thumbnail cache；应用仅短期保存结果引用 | 系统缓存不由应用读写；修改文件/关闭偏好/插件销毁时使应用引用失效 |
| 调试捕获 | devtools-log | 有界环形内存缓冲（当前上限 5000） | 清空、筛选、导出仅影响本地调试数据；发布构建不加载 |

任何 localStorage 访问都要 try/catch、schema 验证、版本键隔离和默认回退；不得存文件内容/秘密。新增持久状态必须记录 owner、key/store、schema、清理策略、跨版本迁移和会话维度。短命 UI 状态（弹层开合、hover、pending request）默认只放组件内存，不持久化。

## 8. 插件功能规格清单

下列条目将每个插件的范围定到可独立开发的边界。✅/🟡/🔵 描述代码现状，后续完整验收按“目标交互和状态”逐项补齐；开发排序见 [04 roadmap](04-roadmap.md) 和 [08 插件目录](08-plugin-catalog.md)。

### 8.1 基础容器与系统插件

| 插件 | 当前状态 / 槽 | 输入与输出 | 状态、存储与验收重点 |
|---|---|---|---|
| `plugin-layout-panes` 分栏容器 | ✅ `main-view-zone`、topbar 分栏菜单；提供 `pane-slot:*` | 接受会话切换、用户选择 1/2/4 栏；输出 outlet 生命周期事件；不读文件业务 | 每会话保存 mode/ids/seq/比例；目标支持分隔条拖动、焦点可见性、有效 pane 增减、稳定 id 和无串状态；单栏隐藏重复栏内导航，多栏各栏独立导航；菜单必须当前选项明确、ESC 可关 |
| `plugin-layout-views` 侧栏容器 | ✅ `nav-zone`；提供 `nav-panel:*` | 接受 `sidebar:view:changed`；根据活跃 viewId 显示唯一面板 | 无业务持久状态；目标处理无贡献/被禁用 view 的空态和回退，不卸载非活动视图导致无谓丢失局部展开状态 |
| `plugin-inspector` 详情容器 | ✅ `file-sidebar-zone`；提供详情、预览嵌套槽 | 输入当前 `focusRef`、详情 tab 贡献；输出 `detail:tab:changed` | 目标：无焦点、目录、普通文件、未知 kind 各有模板；标题路径截断但可查阅；tab 被移除时安全回退；扩展贡献独立失败；窄栏滚动局部化 |
| `plugin-settings` 设置 | ✅ 活动栏齿轮 Popover；插件设置嵌套页 | 软件设置：亮/暗/跟随系统；插件启停；每个 `settings-page:*` | 外层主题沿 Mantine 持久化；disabled 清单由 loader 管理；核心插件锁定。Popover 固定尺寸、内部分页滚动；启停显示加载/失败回滚；子页面标签来自贡献者 manifest label |
| `plugin-context-menu` 右键菜单框架 | 🔵 规划；应用级 Mantine `ContextMenuLayer` | 统一处理各 surface 的上下文与锚点，按条件聚合/分组/排序贡献项；业务插件加载时注册、卸载时移除；执行 handler 始终归贡献插件 | `ContextMenuContext` 只短期驻留内存；框架不调用业务 capability、不持久化上下文。定义键鼠/辅助技术交互、生命周期、ACL、错误与取消契约 |

### 8.2 已实现的用户功能插件

| 插件 | 当前状态 / 槽 | 完整功能目标 | 数据、交互和跨插件行为 |
|---|---|---|---|
| `plugin-file-browser` 文件浏览 | ✅ 列表/网格、每栏地址栏/历史、虚拟列表、图片缩略图、顶栏视图下拉；`pane-slot:*` 与设置页 | 地址输入/提交/取消；后退、前进、上级、刷新；文件夹分组后文件分组；列表/网格共享选择和焦点；空目录、超大列表、无权限、路径失效；列出名称/类型图标/大小/修改时间；网格可见项才取 Windows 系统缩略图；规划标签 chips、表格视图与更多排序 | `fs.home/list/shell.thumbnail.read`（规划替换）；每栏独立历史与选择；订侧栏选择/slot 生命周期，发 focus Ref。模式切换保持路径、滚动可合理归零、选择保持；请求序号避免过期列表覆盖；目录变更后若焦点已离开当前目录则清焦点。缩略图无结果显示文件类型图标，关闭后停止请求并隐藏图像 |
| `plugin-view-file-tree` 目录树 | ✅ 活动栏图标 + `nav-panel:file-tree` | 懒加载目录；展开/折叠、加载中、错误重试、空目录；点击目录作为侧栏选择；保持键盘导航 | `fs.home/list`；发 sidebar view/selection Ref。展开路径暂存于组件内存；刷新树时保留可验证节点；每个树项不得触发 N 次 stat |
| `plugin-view-favorites` 收藏视图 | ✅ 活动栏 + `nav-panel:favorites` | 首页/收藏位置列表；添加、移除、重命名或排序（具体编辑入口随实现明确）；点击目录驱动浏览器；失效项提示移除/重新定位 | 当前独占 `fm.view-favorites.v1`；`fs.home`；发 sidebar selection。写入原子化；损坏数据回退并可恢复；定义收藏路径失效策略 |
| `plugin-view-tags` 标签视图 | ✅ 活动栏 + `nav-panel:tags` | 标签集合增删改名、成员管理、按标签浏览；成员点击聚焦文件；标签本身与文件 Ref 区分 kind | 当前独占 `fm.view-tags.v1`；发 view/selection/focus。不得供浏览器直接读 localStorage；规划卡片标签 chips 时新增受控查询/批量查询契约并确定删除文件/重复路径处理 |
| `plugin-file-details` 文件详情 | ✅ `detail-info-zone` 基础属性与 BLAKE3 | 按当前焦点展示文件名、路径、大小、类型、修改时间、哈希；文件夹展示适用的目录信息；可复制路径；慢 hash 单独 loading/error | `fs.stat/hash.compute/fs.home/fs.readText`（按实现权限）；订 selection 兼容事件。每个异步响应核验 ref；大文件哈希如未有进度契约显示 indeterminate；二进制不强行 readText |
| `plugin-file-history` Lore 文件历史与版本操作 | 🟡 `detail-tab:history`，当前是旧式 hash/元数据快照 | Lore 仓库内版本查询、dirty、显式创建、只读查看、diff、安全恢复；版本行展示由独立 metadata 插件贡献 | `file:changed` 仅刷新 Lore 工作区状态；用户操作经 Lore 适配层。消费 metadata 插件发出的 restore request 并负责确认/执行；自身不保存版本缩略图属性 |
| `plugin-history-metadata` 历史版本信息 | 🔵 规划；贡献 `history-record:metadata` 子插槽 | 按 revision 保存 Windows 系统缩略图、文件大小/类型、图片尺寸和采集状态；供历史版本行展示；点击切换只发送 restore request | 订 Lore revision 创建生命周期，采集属性并写独占 `db.historyMetadata.*`/blob；不拥有 Lore capabilities，不提交、不恢复、不读取 Lore 私有存储 |
| `plugin-preview` 统一预览 | 规划；整合现有 `plugin-preview-text`；`preview-zone` + 自有设置页；Open File Viewer React SDK | 预览区提供“缩略图 / 文件预览”切换；新焦点默认只显示 Windows 缩略图，不加载 viewer、不读取正文；用户主动点击后才统一分派文本/代码/Markdown、图片、PDF、音视频、Office、压缩包等；加载/不支持/损坏/加密/超限状态可恢复 | `file.kind` + 授权预览资源句柄/range 通道；`fm.preview.prefs.v1` 仅存格式偏好，不存模式。切回缩略图/焦点变化取消读取、撤销句柄并释放 media/worker；不暴露裸路径 |
| `plugin-mock-data` 模拟数据（dev） | ✅ dev only 活动栏 + `nav-panel:stress` | 选择 1K/10K/100K/500K/空目录/读取失败数据，驱动真实浏览与详情链路 | 仅浏览器开发 mock 索引存在，发布宿主不得发现；发 Ref，不将 stress 文件逻辑塞进业务插件；用于性能、空态和失败态回归 |

### 8.3 后续业务插件（规划，不得误认为已提供）

| 插件 | 主要入口/依赖 | 目标数据流和功能 | 必需状态与待冻结契约 |
|---|---|---|---|
| `plugin-file-ops` Windows 原生文件操作（全栈） | topbar、状态栏、详情操作；Windows `IFileOperation` + 已注册 Tauri opener/dialog | 收集路径/目标/新名称 → 校验授权 → 调用系统 Shell 完成 copy/move/rename/create/delete → 系统冲突/进度对话框 → 返回结果并刷新列表；open/reveal 走 opener | 不自写文件复制/移动/删除实现；删除默认进回收站；后台结果/进度 DTO 先进入 Rust contracts + SDK。能力建议 `shell.fileOperation/openPath/revealItemInDir/pickFile/pickDirectory`，实现前冻结；COM 用 STA 线程 |
| `plugin-search` 搜索（全栈） | 命令面板 + 搜索结果 pane；FTS5/Tantivy 待选 | 输入词、范围和类型条件 → 查询索引 → 增量结果 → 打开结果所在目录并聚焦文件；索引后台更新 | 保存用户过滤偏好，不保存明文文件内容之外的额外副本；索引可重建；定义暂停/取消/部分结果；`search.query`/`search:results` schema、排序和索引状态需冻结 |
| `plugin-preview` 统一预览 | `preview-zone`；Open File Viewer React SDK | 一个容器分派文本/Markdown、图片、PDF、媒体、Office、压缩包等；格式按本地样本逐步验收；加载/不支持/损坏/加密/超限状态明确；视频帧不得自制为缩略图 | 订焦点；通过路径绑定、只读、短时资源句柄与 range 数据通道读取；禁裸路径 URL、禁任意远程加载；切焦点撤销句柄并释放 worker/media/object URL |
| `plugin-windows-thumbnails` Windows 系统缩略图 | Windows Shell `IThumbnailCache` | 缓存命中读取或允许 Shell handler 提取；仅缓存模式未命中显示类型图标；不解析系统 cache 文件、不经应用生成 | `shell.thumbnail.read`（规划；DTO 待冻结）；消费者按可见性请求；系统缓存归 Windows 管理，应用短期引用可丢弃 |
| `plugin-storage-analysis` 空间分析 | `pane-slot:*`；echarts、`sys.disk`、遍历能力 | 选根目录 → 扫描进度 → treemap/目录大小 → 点击下钻/返回；扫描失败与权限跳过统计 | 扫描可取消；聚合结果缓存须按路径和时间失效；不能阻塞文件浏览；排除/符号链接/硬链接策略待定 |
| 文件操作扩展：标签 chips / 表格视图 | file-browser 内功能，不另造隐式跨插件依赖 | 表格排序/列配置/键盘选择；标签 chip 显示关联标签并可筛选 | TanStack Table 规划；跨插件标签必须经受权的 `tags.*` 能力或事件 DTO，禁止读取 tags 的私有存储 |
| 命令面板与全局命令 | 基座 Spotlight + 各插件注册项 | 搜索命令、键盘打开、插件卸载后移除命令、命令错误就地显示 | 命令注册/执行接口目前需单列设计（SDK 当前 `PluginHost` 没有 command API）；不得仅以占位 slot 假称已实现 |

独立 `plugin-archive` 压缩包虚拟目录浏览/解压已取消，不纳入当前规划；统一预览器支持某些压缩格式的只读预览仍单独评估。

### 8.4 开发期插件

| 插件 | 功能边界 | 生命周期与安全 |
|---|---|---|
| `plugin-devtools-log` | 捕获 console/window 错误、未处理 rejection、long task 和白名单事件；环形缓冲最多 5000；面板筛选/搜索/新旧排序/清空/JSON 导出 | dev 索引专用；采集事件白名单避免泄露文件内容；卸载时移除全局监听；生产构建不装载 |
| `plugin-dev-slot-harness` | 验证嵌套槽注册/移除、权限拒绝、focus Ref 展示 | 故意越权仅用于 dev 测试；错误应在日志可见、不能阻塞宿主；不进入发布清单 |

## 9. 数据处理状态机样例

### 9.1 浏览器打开目录

```text
idle → loading(path, requestId)
  ├─ fs.list 成功且有项 → ready(entries, metadata)
  ├─ 成功但无项         → empty(path)
  ├─ 拒绝/目录消失      → error(kind, message, retryable)
  └─ 路径切换/卸载      → cancel 或忽略旧 requestId 结果
```

导航历史只有在目标路径通过解析并成功或进入明确错误状态时按同一策略推进，不能在输入框每个字符都写入历史。刷新不新增历史项。重复选择当前路径可作为显式刷新，但不创建重复栈项。目录树选择只影响对应当前会话可见栏；双栏各自路径的作用范围需保持一致并在实现中有 UI 提示。

### 9.2 焦点驱动详情

收到新 `focusRef` 时，详情贡献者立刻将旧数据标为过期并启动新 request token；`null` 显示空态；目录显示目录模板；kind 不支持时显示通用信息。每个 capability 完成前都核对 token 和当前 `host.getState().focusRef`，不匹配则丢弃。单一插件失败不影响详情容器其它贡献者。

### 9.3 文件操作（规划）

```text
idle → validating → awaiting-confirmation → queued → running(progress)
  → completed(summary) / partial-failure(items) / failed(reason) / cancelled
```

每次操作都要区分源和目标；跨卷 move 是否退化为 copy+delete 必须报告；目标冲突策略由用户明确选择或采用已保存偏好；取消只停止仍可安全取消的工作，并报告已完成项，不能谎报回滚。操作完成由 watcher/显式刷新收敛 UI；多选操作部分成功时提供可复制失败清单。

## 10. 插件开发登记模板与验收门槛

新增或补全插件时，在 PR/任务说明及本文条目填写下列字段：

```text
插件名 / displayName / 版本 / 当前阶段
用户问题与不做范围：
入口槽、贡献 label、提供的嵌套槽：
用户动作与快捷键：
展示形态、空/加载/错误/禁用状态：
交互状态机与动效/减少动态效果：
输入数据、owner、数据校验和刷新策略：
调用能力（权限最小集合、参数/返回 DTO）：
订阅/发出的事件（owner、payload、触发条件、幂等/顺序约束）：
持久化 key/store、schema 版本、会话键、迁移和删除策略：
并发/取消/过期响应处理：
插件禁用与宿主重启行为：
大数据/性能边界：
可访问性与键盘行为：
验收场景（成功、空、失败、快速切换、卸载、权限拒绝）：
```

完整交付至少满足：

1. manifest 精确列出 capability/event/slot 权限；无过宽 `*`，不存在直接导入另一插件或访问其存储。
2. Rust 与 TS 跨 IPC DTO 已同步，`contract:check` 通过；前端事件 payload 有 SDK 类型/文档并设置唯一 owner。
3. 主要交互覆盖 loading/success/empty/error，快速选择/会话切换时无旧数据闪回；卸载后无残留订阅和任务。
4. 持久化可容忍损坏/旧版本/不可用；重启和插件启停行为符合所属条目。
5. 亮/暗主题下使用 Mantine token，键盘焦点可见，减少动态效果可用；长列表不会全部挂载。
6. 成功、空态、错误、越权、切换、重复事件、卸载等关键场景有相应的自动化或可复现验收记录；真实 Tauri IPC/文件监听场景与浏览器 dev mock 场景分开记录。

## 11. 事实源与更新顺序

代码接口事实以 `core-shared/contracts`、`core-shared/plugin-sdk`、实际 manifest 和 `apps/shell-ui/src` 为准；插件状态/库分布以 [08](08-plugin-catalog.md) 为准；阶段优先级以 [04](04-roadmap.md) 为准；本文定义完整用户功能和验收行为。新增需求时先更新本文和 08，再改 manifest/contract/代码，最后补状态与证据，避免文档把规划误写成已实现。
