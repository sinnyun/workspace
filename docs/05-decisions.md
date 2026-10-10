# 05 · 技术选型与决策记录

本文记录关键架构决策的**选项对比、理由、代价与后果**。目的是让任何接手者(包括未来新会话的你)不必重新推导就能理解"为什么是这样",并在触发条件出现时知道该复核哪条决策。

---

## D1 · 后端运行时:cordis-rs(原生 Rust)

**背景**:后端需要一个微内核承载插件生命周期、依赖注入、事件管道。

| 选项 | 后端插件语言 | 需要 JS 引擎/Node | 体积 | 生态 | 结论 |
|---|---|---|---|---|---|
| Node sidecar + Cordis(TS) | TypeScript | 需要 Node 子进程 | 大(+40~80MB) | Node 全生态 | ✗ |
| Deno sidecar + Cordis(TS) | TypeScript | 需要 Deno 子进程 | 中 | TS 原生,Node 兼容需验证 | ✗ |
| Rust 内核 + 嵌入式 JS 引擎跑 Cordis(TS) | TypeScript | 需要 QuickJS/V8 嵌入 | 中 | 受引擎 API 限制 | ✗ |
| **Rust 内核 + cordis-rs** | **Rust** | **不需要** | **最小** | Rust 生态 | ✓ **采用** |

**决定**:后端内核用 **cordis-rs**(Cordis v3 运行时的原生 Rust 实现)。

**理由**:
- 与"外壳即 Rust(Tauri)"统一技术栈,后端插件直接进程内调用原子能力,**无 IPC 开销、无 Node 子进程守护**。
- 保留 Cordis 的心智模型(`Context`/`Service`/`Event`/`Effect`/`Fiber`),插件化能力不打折。
- cordis-rs 是**真实且活跃维护**的 crate(非需自研):`cordis-rs` 门面 26396 次下载、2026-10-01 更新,配套 `cordis-core`/`cordis-rs-loader`/`cordis-rs-hmr`/`cordis-rs-timer` 等。

**代价**:
- 后端插件改用 Rust 写(不是 TS),对只熟悉 TS 的插件作者门槛更高。
- cordis-rs 是早期活跃依赖,API 可能变动(→ R2,用 `core-shared/contracts` 薄封装隔离)。
- 与 Tauri v2 异步运行时的集成方式需实测(→ R1,Phase 0 P0-3 spike)。

**后果**:后端无 Node/无 sidecar/无嵌入式 JS 引擎;后端插件随宿主构建。

**复核触发**:若 cordis-rs 与 Tauri 集成被证实不可行(P0-3 失败)且专用运行时线程方案也不成立,则回到"嵌入式 JS 引擎"或"sidecar"重评。

**证据**:crates.io `cordis-rs`;`github.com/dshbox/cordis-rs` README(Plugin/Context/Fiber/Effect 模型、tokio)。

---

---

## D2 · 后端插件分发:静态内置 Rust

**背景**:cordis-rs 插件是编译期 Rust。需要决定第三方/运行时能否安装新后端插件。

| 选项 | 运行时 drop-in | 安全 | ABI/复杂度 | 结论 |
|---|---|---|---|---|
| **静态内置(cargo 依赖 + feature 门控)** | 否(需重建宿主) | 高(仅可信内置代码) | 低 | ✓ **采用** |
| cdylib 动态库(libloading) | 是 | 低(原生代码=全系统权限) | 高(Rust 无稳定 ABI,须同版本编译) | ✗ |
| WASM(wasmtime) | 是 | 高(沙箱) | 高(cordis-rs 需 tokio+std,跑不进 WASM;插件须实现 WASM 契约) | ✗(本期) |

**决定**:后端插件**静态编译进宿主**;运行时的启用/禁用/改配置/热重组由 cordis-loader + fiber `dispose`/`spawn` 完成。

**理由**:
- cordis-rs **未提供**运行时加载外部二进制/WASM 的机制,其 loader/hmr 做的是"重新组合已编译插件",不是"加载新代码"。
- cdylib 的 Rust ABI 不稳定 + 原生代码全权限,安全与维护成本高;WASM 与 cordis-rs 的 tokio/std 依赖冲突,会让 cordis-rs 退化。
- 桌面文件管理器的主流安全模型是"核心原生可信 + 扩展受限"(类比 VS Code:核心 C++,扩展 JS,不 drop 原生 DLL)。

**代价**:第三方无法在运行时注入新的后端 Rust 代码;新增后端能力/插件需要重新构建并发版宿主。

**后果**:**运行时的"可安装扩展"集中在前端 ESM 一侧**,且只能调用已内置的能力。这是本项目**有意接受的边界**(记录为 R4),不是缺陷。

**复核触发**:若未来确有"第三方后端插件运行时安装"的硬需求,再单独立项评估 WASM 方案(宿主侧 cordis-rs 编排 + 插件侧 WASM 契约)。

---

## D3 · 前端插件加载:本地 ESM + `import()`

**背景**:前端插件如何被基座加载与隔离。

| 选项 | 运行时 drop-in | 隔离 | 复杂度/维护 | 结论 |
|---|---|---|---|---|
| **本地 ESM + `import()`(自定义 `plugin://` 协议)** | 是 | 中(靠 host API + 权限 + 样式隔离) | 低 | ✓ **采用** |
| Module Federation | 是 | 中 | 高(`@originjs/vite-plugin-federation` 已停维护;官方 `@module-federation/vite` 对桌面本地场景偏重) | ✗ |
| 每插件独立 WebView/iframe | 是 | 高(完全沙箱) | 高(通信开销大、跨插件协作难、体验割裂) | ✗ |

**决定**:前端插件编译为普通 **ESM**,基座运行时 `import()`,经自定义 `plugin://` 协议下发,React 等共享依赖用 **import map** 复用宿主单例。

**理由**:
- 桌面本地场景插件就是本地文件,不需要 MF 的"远程 web 模块"能力;普通 ESM 更简单、可控、无额外重依赖。
- drop-in 目标可达成:构建后的前端插件放入目录即生效,无需重建基座。
- iframe/多 WebView 隔离虽强,但通信与体验代价过高,不适合需要与主视图频繁协作的文件管理器面板。

**代价**:隔离弱于 iframe,需靠 host API 收口 + 权限白名单 + Mantine 主题变量约束插件样式(不用 Shadow DOM,因 Mantine 浮层走 portal)兜底(→ R5)。共享依赖(React/Mantine)版本靠 import map 约定。主题与插件样式规范见 [01-architecture.md](01-architecture.md) §7。

**后果**:前端插件产物极小(只含自身代码);React 全局单例;`plugin-sdk` 仅类型 + 无状态 helper。

**复核触发**:若出现不可信第三方前端插件的强安全需求,再评估对高危插件用 iframe/Web Worker 沙箱。

---

## D4 · 进程模型:单 Tauri 进程

**决定**:整个应用是**单个 Tauri v2 进程**;Rust 侧同时承载能力层与 cordis-rs 内核,WebView 承载 React。无 sidecar。

**理由**:D1 选定原生 Rust 后端后,后端与外壳同为 Rust,合进一个进程最简单、启动最快、无跨进程 IPC 与进程守护复杂度。

**代价/风险**:内核与 UI 宿主同进程,后端重活需避免阻塞 UI 线程(靠 tokio 异步 + fiber 隔离 + 重活走 rayon)。

**后果**:后端插件调用能力是**进程内函数调用**;只有"前端↔Rust"这一条 Tauri IPC 边界。

---

## D5 · 前后端契约的单一事实源:镜像类型 + 契约测试

**决定**:事件/能力的 schema 以 `core-shared/contracts/events.schema.json` 为单一清单源;TS 类型(`plugin-sdk`)与 Rust 类型(`contracts`)各维护一份并由**契约测试**校验一致。**初期不引入代码生成**。

**理由**:双语言端各写类型不可避免;先用"单一清单 + 测试兜底"这种轻量方式防漂移,codegen 的复杂度留到确有需要(契约稳定、手工同步成本变高)时再上。

**代价**:仍需手工维护两端类型,靠测试发现不一致。

**复核触发**:契约条目增多、手工同步频繁出错时,评估 TS/Rust codegen。

---

## D6 · 容器里的标题从哪来:贡献者声明 `label`(结构化),不靠容器硬编码

**背景**:`plugin-inspector` 的 D 区 tab 条由 `contributedSlots("detail-tab")` 动态扫出,需要一个显示名;分栏头、区域占位同理。

| 选项 | 加插件要改谁 | 权限代价 | 结构保证 | 结论 |
|---|---|---|---|---|
| 容器里写 `slotId→中文` 映射表 | **改容器** | 无 | 无(表会漏) | ✗ |
| 组件导出第二个值(如 `HistoryPanel.label`) | 无 | 无 | 弱(entry 需额外约定,基座装载器不校验) | ✗ |
| manifest `frontend.slots[].label` → 注册项携带 → `host.slotLabel(id)` | 无(插件自己声明) | **无**(标签是寻址层元信息,不是数据) | 强:装载期校验(空白即拒),容器只回落槽名 | ✓ **采用** |

**决定**:槽的显示名是**贡献者的元数据**,写在 manifest `frontend.slots[].label`(可选);基座把它随注册项带进注册表,容器经 `host.slotLabel(slotId)` 读取,缺声明时回落槽名。容器自己拥有的**区域**(如 `插件预留`/`预览`/`属性信息`)的中文名留在容器里——谁提供谁命名。

**理由**:符合"发现面只寻址不解释"的既有边界(02 §4.5):容器拿标题**不需要任何新权限**,也不读任何插件的业务数据;新增一个 tab 不触碰容器代码,规则由结构而非自觉保证(与 B 视图互斥交给容器同一取向)。

**代价**:双端契约各加一个可选字段(TS `validateManifest` + Rust `SlotDecl.label`),声明式槽才带标签——`activate()` 里动态 `contributeToSlot` 的实例拿不到 label(现只有 `pane-slot` 用它,而分栏头不需要标题)。

**后果**:`cargo test -p fm-contracts` 覆盖 label 往返/缺省为 Null/空白拒绝;SDK 单测覆盖同规则;D 的 tab 实测显示 `信息`/`历史`。

**复核触发**:若出现"同一槽多个贡献者要各自标题"或需要本地化标题,再考虑 label 结构化(如 `{ "zh": … }`)并接 i18n(P6-26)。

---

## D7 · 亮/暗主题:直接用 Mantine 的 colorScheme,不自造主题层

| 选项 | 代码量 | 插件侧一致性 | 结论 |
|---|---|---|---|
| **`MantineProvider defaultColorScheme="light"` + `useMantineColorScheme`** | 零额外依赖 | 插件与基座共用**同一个** Mantine 单例 → 天然同步 | ✓ **采用** |
| 基座自写 CSS 变量 + 自定义"主题已切换"事件广播给插件 | 需自持监听/持久化/跟随系统 | 需要新契约与 gating | ✗ |
| 引入 next-themes 之类第三方主题库 | 多一个依赖且与 Mantine 职责重叠 | — | ✗ |

**决定**:主题能力**完全交给 Mantine**:基座设默认亮色并提供切换控件,`plugin-settings` 用同一个 hook 提供面板入口;持久化沿用 Mantine 的 `mantine-color-scheme-value`。插件颜色只允许取 Mantine CSS 变量。

**理由**:"优先用开源库,不自研"(用户既定偏好);共享单例机制(D 落位)本就是为了让 `useMantineColorScheme` 在 host 与 plugin 里指向同一份状态——**跨入口同步不需要任何自定义事件**,这是架构既有能力的直接收益。

**代价**:主题状态由 Mantine 持有,基座不把它放进级联元状态(它是外观,不是选择状态);写死色值(如 `--mantine-color-gray-0`)的旧样式在暗色下会错位,须逐个换成 `var(--mantine-color-body)` 一类语义变量。

**后果**:`@mantine/*` 全线锁 `^7.17.8`(15 个包),**升版后必须重跑 `pnpm build:shared`** 重建两套单例变体,否则运行时与类型漂移(见 00 §4)。

**复核触发**:若要做"每会话/每插件不同主题",再把 colorScheme 提进元状态并设计作用域。

---

## D8 · 缩略图:读取 Windows Shell 系统缩略图,应用不生成

| 选项 | 权限模型 | 结论 |
|---|---|---|
| `shell.thumbnail.read` → Windows Shell 缩略图 | 与 `fs.*` 同一套 `permissions.capabilities` gating；通过 `IThumbnailCache::GetThumbnail`，命中读取系统缓存、未命中由系统 handler 提取；应用不解码/生成 | ✓ **采用** |
| `asset:` / `file:` 协议直出原图 | 拿到路径即可显示任意文件,权限形同虚设;缩放交给浏览器 CSS,大图全量解码 | ✗ |
| 应用内核/插件自行解码、缩放或 canvas 造缩略图 | 复制系统能力、格式覆盖不一且偏离用户要求 | ✗ |

**决定**:Windows 系统缩略图由 `plugin-windows-thumbnails` 统一拥有；宿主 capability 提供受权限控制的 Shell API，`plugin-file-browser`、`plugin-preview` 等消费者只按当前可见项/焦点请求。应用短期缓存只保存读取结果引用以减少重复请求，Windows 缓存由系统管理。无图时回退文件类型图标。

**理由**:权限边界不能被显示路径绕过(与 01 §8 "B/C 分界是原子 vs 业务"一致);按需取图让 50 万条目录的拉取成本仍只是一屏请求量。

**代价**:能力仅在 Windows 上提供，且格式覆盖取决于系统已安装的 Shell thumbnail handler；缓存未命中可能慢，消费者必须提供占位和图标回退。

**验收重点**:首屏按可见范围请求并限制并发；若 Shell 缓存冷启动较慢，先优化请求队列和状态反馈，不改为应用生成或解析自定义缩略图缓存。

---

## D9 · 目录顺序与 mtime 由 provider 负责,不由浏览器负责

**决定**:`fs.list` 返回**自然序、忽略大小写**(`natord::compare_ignore_case`)的条目,并直接带 `modifiedMs`(目录为 `null`)。前端拿到即渲染,**不做排序、不逐行 `fs.stat`**。

**理由**:10 万条名字在前端排序是 UI 线程上的固定成本,而 provider 侧排序是一次 Rust 计算;日期列若靠 `fs.stat` 补齐会变成 N 次往返。dev mock 的生成顺序与之对齐,保证浏览器 dev 与 Tauri 行为可对照。

**代价**:前端要"按大小排序"之类的视图需要新契约(排序参数或前端二次排序),届时再设计,不提前预留。

---

## D10 · "栏高有界"是容器 owner 的不变量,不是每个内容插件的自检

**决定**:`plugin-layout-panes` 保证每个栏是**有界 flex 列**——栅格行轨 `minmax(0,1fr)`、栏 `display:flex`+`min-height:0`、outlet `flex:1`+`overflow:hidden`(outlet 不滚动,滚动权属于内容插件)。内容插件只写 `height:100%`。

**理由**:跨组件规则(虚拟滚动需要确定视口高度)由**容器**强制,而不是要求每个注入 `pane-slot` 的插件各自探测父高或补 `min-height`。反例实测:容器一旦退化成 `display:block`,`flex:1` 被忽略、outlet 长到内容高度,虚拟列表**静默挂载全部行**且被 `overflow:hidden` 裁掉——错误不响,只在大数据下爆内存。

**后果**:该不变量写进 01 §9 与 08 §5.1 要点;React 侧的触发点(`display: hidden ? "none" : undefined` 会被当成"删除属性")记在 00 §4.19。

---

## D11 · 设置入口:独立插件的**悬浮面板**,不是一种侧栏视图

| 选项 | 与六区网格的关系 | 多插件分页 | 结论 |
|---|---|---|---|
| Mantine **`Popover`**(受控 `opened`,挂 `activity-rail-zone` 的齿轮上) | 经 portal 渲染到 `body`,**不占六区任何一格**,不改布局 | 面板内部 `Tabs` 自由分页 + 嵌套槽 | ✓ **采用** |
| `Modal` / `Drawer` | 遮罩打断浏览(设置是**对照界面边看边调**的动作),且遮罩会盖住正在被设置的网格 | 可以 | ✗ |
| 继续占 B(`nav-panel:settings`) | 设置被当成"侧栏视图之一",与文件树/收藏抢同一格;分页只能塞进 B 的窄面板 | 差 | ✗ |
| 自写 Portal + 定位 | 要自己处理翻转/避让/ESC/外点关闭 | — | ✗(Mantine 已提供) |

**决定**:`plugin-settings` 贡献 A 栏底部齿轮,点击打开**悬浮面板**;面板外层分页 **软件设置**(主题 + 插件启停)与 **插件设置**(每个插件一页,标题取贡献者自己的 `slots[].label`)。设置不再是 B 的视图,齿轮也不再发 `sidebar:view:changed`。面板是**固定尺寸的容器**(`620×560`),正文各自内部滚动,切页/切子页不改形不挪位。

**理由**:设置是"看着当前界面调当前界面"的动作,遮罩式模态打断这个循环;而把它塞进 B 会让"设置"和"文件树"在同一格里互斥竞争,分页深度也受侧栏宽度限制。用 `Popover` 的既有能力(flip/shift/withArrow/ESC/外点关闭)而不是自写浮层,符合"优先用开源库"。

**后果**:受控 `opened` 下 Mantine 的 `Popover.Target` **不再自己挂 `onClick`**(源码 `...!ctx.controlled ? { onClick: ctx.onToggle } : null`),开合必须由齿轮自己翻,`onChange` 只回送 ESC/外点——这个坑记在 00 §4.23。浮层高度默认跟内容走,换分页会同时变形和被 floating-ui 重新定位,所以尺寸写死、滚动内聚,记在 00 §4.26。

**复核触发**:若设置页需要脱离齿轮独立开窗(如"在独立窗口打开设置"),再考虑 `Modal` 作为第二形态。

---

## D12 · 插件启停:owner 是**基座 loader**,核心保护由基座判定,能力名不进 Rust 契约

| 选项 | 单一 owner | 第三方插件能否自免 | 契约成本 | 结论 |
|---|---|---|---|---|
| 基座 `loader` 持启停 + 暴露 `plugins.list`/`plugins.setEnabled` 两个**基座前端能力** | ✓(装载/卸载/槽回收都在它手里) | 不能:`protected` 由基座的固定名单判定,与 manifest 无关 | 零(不动 Rust、不动 `contract:check`) | ✓ **采用** |
| `plugin-settings` 自己 import 各插件目录并动态 import | ✗:UI 插件同时成了加载器,与 loader 两份装载状态 | 取决于实现 | 零 | ✗ |
| 放进 Rust 内核(真能力) | ✓ | — | 要动 `capability::names` + dump + 前端插件状态得反向同步进 Rust | ✗(**前端插件的存在与否本来就是前端事实**) |

**决定**:运行态启停归 `apps/shell-ui/src/loader.ts`,持久化 `fm.plugins.disabled.v1`;不可关闭集合是**基座策略**(三个界面框架容器 + 设置面板自身)。设置 UI 只经 `host.invoke` 走同一套 `permissions.capabilities` 白名单,不获得任何特权通道。

**理由**:与 D10 同源——**跨组件的不变量必须由 owner 结构性强制**。若"哪些插件不可关"写在 manifest,任何插件都能豁免自己,"基座最小、其余皆可插拔"这条边界就形同虚设;若启停逻辑住在 UI 插件里,卸载顺序/槽回收这些只有 loader 知道的事实会被复制第二份实现。

**后果**:`FrontendCapabilities` 与 `Capabilities` **必须是两个常量**:`contract:check` 拿 Rust `capability::names` 与 `Capabilities` 做全等比对,基座前端能力没有 Rust 对应物,混进去即假阴性/漂移。SDK 单测额外断言这两个名字**不在** `Capabilities` 里。基座能力查找排在 Tauri `invoke` 之前(`invoke.ts` 三级分流:基座表 → Tauri → dev mock)。

**复核触发**:若要做"禁用后端 Rust 插件"(dispose fiber)的统一面板,`plugins.list` 需扩成前后端合并视图,届时再谈是否把前端侧名称并入 Rust 契约。

---

## D13 · 插件自己的设置页:内容自持,生效走**同插件内模块级 store**,不进基座状态

**决定**:一个插件的设置页(`settings-page:<name>` 里的内容)读写**自己的** localStorage 键,并经由该插件 dist 内部的模块级偏好 store(`useSyncExternalStore` + 监听者集合)通知已渲染的实例;值域在读与写两侧都 clamp。基座元状态不新增任何"设置"字段。

**理由**:同一插件的 bundle 天然共享模块作用域,所以"设置页改一次、已在渲染的每一栏立刻跟随"不需要新契约、不需要事件、也不需要基座解释这个偏好的含义。**反例实测**:只让 `Thumb` 的取图 `useEffect` 早退而不让渲染读开关,已加载的缩略图会因缓存的 data URL 仍在 state 里而**关不掉**(实测 `<img>` 恒为 7)——"即时生效"必须同时覆盖取数与渲染两条路径。

**代价**:偏好按插件分散在各自己的键里(现为 `fm.file-browser.prefs.v1`、`fm.preview.prefs.v1`),没有全局导出/导入;等出现"备份配置"需求时再统一(可能落 `db.settings.*`)。

**复核触发**:若两个插件需要共享同一设置(例如主题色影响预览渲染),那说明它已经是跨插件契约,应提升进能力/事件面而不是各自读同一键。

---

## D14 · 文件写操作由 Windows Shell 执行，插件只负责受权调用与界面

**决定**：规划中的 `plugin-file-ops` 作为唯一应用内文件写操作入口。Windows 上复制、移动、重命名、新建和删除由 Rust host 的 Windows provider 调用 `IFileOperation`；删除默认设置 `FOFX_RECYCLEONDELETE`。打开文件和资源管理器定位使用已注册的 `tauri-plugin-opener`；路径选择使用 `tauri-plugin-dialog`。前端通过 host capability 调用，不能直接 import Tauri 插件或发任意 Shell 命令。

**理由**：用户要求复用 Windows 自身文件操作能力。系统 Shell 已提供目录级 copy/move/rename/delete/create、冲突提示和进度界面，避免应用再实现一套递归复制、覆盖规则和进度算法。能力层仍负责权限、路径校验、COM 线程隔离和结果适配；插件负责用户入口、参数输入、确认和结果反馈。

**实现边界**：`IFileOperation` 要求单线程单元（STA），因此需使用专用 COM STA 线程，不直接在通用 Tokio worker 调用。系统进度/冲突对话框作为权威反馈；插件最多展示操作摘要，不再叠加自制的详细进度 UI。永久删除不属于普通删除。非 Windows 平台不得静默退回自写文件 mutation；须提供单独原生 provider 或明确显示不支持。

**复核触发**：若产品后续要求无系统对话框、云端/虚拟文件或可跨平台的后台批处理，再评估相应 OS provider；不得默认恢复 `fs_extra`/`trash` 的通用自实现路线。

---

## D15 · 右侧预览默认使用系统缩略图，内容预览由用户显式启动

**决定**：右侧 `preview-zone` 对每个新聚焦文件默认只展示 `plugin-windows-thumbnails` 返回的 Windows 系统缩略图；没有缩略图时显示文件类型图标。用户点击“打开文件预览”后，统一 `plugin-preview` 才初始化 Open File Viewer 并通过授权资源句柄读取文件。预览区提供单个切换按钮，viewer 模式下按钮为“返回缩略图”。模式只属于当前焦点文件的临时 UI 状态；切换焦点恢复缩略图模式，不记住上次预览状态。

**理由**：选中文件时不自动读取完整内容或启动格式解析，避免大文件导致不必要的数据传递、内存占用和界面阻塞；用户的明确点击才启动完整预览。

**生命周期**：切回缩略图或切换焦点时立即取消在途读取、撤销只读预览句柄并释放 viewer/worker/media/object URL。缩略图读取独立于 viewer，不得触发正文读取。

---

## D16 · 文件版本历史：Lore 核心 + 本应用历史面板

> **当前状态**：Lore 集成**暂缓**（P7-25 决策门结论见 D21）。本节是定案的目标形态，尚未开工；现在运行的历史面板仍是 hash/DB 快照，不宣称可恢复内容版本。

**背景**：现有 `plugin-file-history` 以 watcher、hash 和 SQLite 元信息记录快照，尚未形成可恢复的内容版本。用户希望采用开源 Lore 进行版本管理和切换，并可参考 LoreGUI。

**决定**：以 Epic Games Lore 作为仓库内文件版本、提交和历史操作的事实来源；`plugin-file-history` 保留 `detail-tab:history` 时间线并负责 Lore 查询、创建和恢复。参考 LoreGUI 将 Lore 核心与 GUI 解耦的 `lore-vm` 思路，不嵌入其完整桌面 GUI。文件监听只刷新 Lore 工作区状态；默认由用户明确创建版本，不对每个 watcher 事件静默提交。恢复需确认并产生可追踪的新变化，不回退分支头。

**边界**：用户显式选择/确认仓库根目录；仓库外文件不自动纳管。版本正文由 Lore 仓库存储；插件偏好仅存仓库选择等配置。旧 `db.history.*` 元数据在迁移验证前保留，只作为旧记录，不宣称可恢复。若 Lore 需要 `loreserver`，必须在 P6-69 验证其打包与生命周期；这将触及 D4 的“单进程、无 sidecar”决策，须一并评估其架构代价。远端服务仅在用户主动配置后连接。

**代价与风险**：增加 Lore API/格式、Windows 打包与服务生命周期维护；Lore 和 LoreGUI 目前处于 pre-1.0，接口与磁盘格式可能变化。正式开发前需固定兼容 revision、核对许可证并完成 Windows/API/数据迁移验证。若上游核心与当前单进程宿主不兼容，应先重评集成适配层，不得直接把 CLI 或完整 GUI 塞进插件 UI。

**证据**：[Epic Games Lore](https://github.com/EpicGames/lore) 说明其集中式、内容寻址版本控制模型及 pre-1.0 状态；[LoreGUI](https://github.com/BiloxiStudios/loregui) 说明它使用原生 Lore Rust crate，并提供与 GUI 解耦的 `lore-vm` 核心；[Lore CLI 文档](https://github.com/EpicGames/lore/blob/main/docs/reference/lore-cli-commands.md) 列出文件历史、差异、指定版本读取与恢复相关操作。

---

## D17 · 历史版本展示信息由独立插件保存

**背景**：Lore revision 负责版本内容和版本操作，但历史面板还需要呈现创建该版本时的缩略图、文件大小和图片尺寸；直接读取当前文件会让历史条目显示成当前状态。

**决定**：新增 `plugin-history-metadata`，在 Lore revision 创建生命周期边界捕获并保存缩略图和展示属性，按 `(repositoryId, revisionId, normalizedPath)` 关联。它提供 `history-record:metadata` 子槽，在历史版本行显示数据；缩略图来自 Windows Shell，不由应用生成。插件不管理 Lore 仓库、revision、diff、commit 或 restore。

点击“切换到此版本”时，元数据卡片只发 `history:revision:restore-requested`；`plugin-file-history` 执行焦点/未提交改动校验、确认和 Lore 恢复。元数据采集为 best-effort，失败只显示缺失状态，不得阻塞或回滚 Lore 创建的版本。采集来源必须绑定提交边界并校验 revision 文件指纹，竞态时标记 partial/unavailable，禁止误绑后续文件状态。

**存储边界**：元数据插件独占 `db.historyMetadata.*` 和应用数据目录下的缩略图 blob；清理这些副本不删除原文件或 Lore revision。Lore 仓库保持版本事实来源，元数据表仅作历史面板展示快照。

---

## D18 · 取消独立压缩包浏览与解压插件

**决定**：取消 `plugin-archive` 的 zip/tar/7z 虚拟目录浏览与解压规划；不为该插件继续建设专用 archive 能力、虚拟路径 Ref 或解压流程。保留其功能文档作为已取消方案的记录。统一预览器可能支持的压缩包只读预览属于另一项预览能力，需按具体格式单独验收。

**理由**：当前目标聚焦文件管理主流程与插件扩展基础设施；压缩包浏览/解压需要独立路径模型、冲突策略和安全防护，暂不纳入当前开发范围。

---

## D19 · 右键面板采用可扩展的独立界面框架

**决定**：新增 `plugin-context-menu` 作为应用内 Mantine 右键面板框架，独立负责打开上下文、面板定位、分组/排序、键盘交互、关闭与插件项注册生命周期。业务动作由各自插件通过 `host.contextMenu.registerItem` 注册并用自身权限执行；入口区域通过 `host.contextMenu.open` 提交短期上下文。插件禁用/卸载时自动移除其贡献项。

**边界**：框架不实现具体文件/收藏/标签/Lore 动作，也不代替贡献插件调用 capability；上下文只含不透明 Ref、surface、栏/会话和锚点信息，不持久化。右键面板是应用内浮层，不采用 Tauri 原生菜单作为插件扩展界面。初始贡献者包括 file-ops、file-history、favorites/tags 和 file-browser。

---

## D20 · 类型识别与卷信息用内核单表 + 直接 Win32，不引 `infer`/`mime_guess`/`sysinfo`

**决定**：`file.kind` 由 `core-shared/kernel/src/capabilities/file_kind.rs` 的一张扩展名→`(类别, MIME)` 表回答，**只按扩展名、从不嗅探内容**；`sys.disk.list` 直接调 Win32(`GetDiskFreeSpaceExW`/`GetVolumeInformationW`/`GetLogicalDrives`)，遍历用自有有界线程池。Phase 6 原选的 `infer`(魔数)、`mime_guess`、`sysinfo` 都不引入。

**理由**：同一个类别问题有三屏要问(图标列、预览分派、右键"打开方式")，各自维护清单必然漂移，漂移的表现为把位图交给解不开它的代码路径；所以事实源必须是一张表，而这张表要能和线协议枚举一起被 `contract:check` 守住。嗅探要求为列表里每一行 open 一次文件，而列表可能有十万行，且 Windows Shell 本身也按扩展名决定怎么处理文件——无扩展名就如实报 `unknown`，而不是猜。卷信息与遍历都只有两三个调用点，`windows` crate 已因 Shell COM 在依赖里，再叠一层 `sysinfo` 抽象不换来什么。

**代价**：新增格式要改表(改表即改契约枚举的覆盖范围，有单测逐行守住)；MIME 只在确有惯用媒体类型时给出，没有就留 `None`，界面不能把缺省读成"未知格式"。dev 侧镜像表与内核表逐行对齐，两侧不同步会被契约测试拦住。

## D21 · Lore 集成暂缓：批次 8 不排期

**决定**：P7-25 决策门按"能否以受支持的 Rust 依赖形态接进来"评估，结论是**暂缓**——不引入任何 Lore crate，`plugin-file-history` 继续以现有 hash/DB 快照形态运行并保持"不宣称可恢复内容版本"的口径；P7-26（迁移）与 P7-27（历史元数据插件）随之不排期。

**事实依据（2026-10 核对）**：上游是 `EpicGames/lore`，pre-1.0；**它没有向 crates.io 发布 Lore**——名字 `lore` 被一个无关 crate（"Flexible logic programming"，NthTensor 0.1.0）占着，`lore-vm` 直接 404。文档里原先设想的"参考 LoreGUI 的 `lore-vm` 解耦层"指的是 `BiloxiStudios/loregui` 里的**第三方** crate，不是 Epic 的受支持接口面。所以唯一的接入方式是把上游 git revision 固定下来从源码自建，代价是同时背上三项：Windows 工具链构建由本仓库兜底、仓库磁盘格式随 pre-1.0 上游漂移、`loreserver` 的生命周期与数据目录直接违反 D4 的"单进程、无 sidecar"。

**理由**：这三项都不是一次性成本，而是长期维护面；换来的是"恢复到任意历史内容"，而当前主流程（浏览/预览/文件操作/空间分析）尚未因此受阻。按"优先用开源库的既有能力"的原则，前提是这个库能以受支持的依赖形态被使用；不满足时不硬接，也不假装接了。

**复核触发**（任一成立即重开 P7-25）：① Epic 发布 crates.io crate 或给出稳定 Rust API；② Windows 构建与许可证由上游官方明确支持；③ 产品确定需要"恢复到任意历史内容"，并接受一个宿主管理的本地服务进程（届时须重评 D4）。

## D22 · 时间与体积格式化归 SDK，是应用唯一的显示格式化面

**决定**：`core-shared/plugin-sdk` 导出四个格式化函数并承担全应用的显示格式：`formatSize`（`pretty-bytes`，`binary: true` → `B/KiB/MiB/GiB/TiB`）、`formatDate`（`YYYY-MM-DD`）、`formatDateTime`（`YYYY-MM-DD HH:mm`）、`formatClock`（`HH:mm:ss`）；三者对无效输入统一给占位符（`—` 或调用方传入的空串），不出现 `Invalid Date`。插件内不得自带第二套实现——`plugin-file-browser`/`plugin-file-details`/`plugin-preview`/`plugin-storage-analysis`/`plugin-file-history`/`plugin-devtools-log` 的本地 `formatSize`/`formatBytes`/`Intl.DateTimeFormat` 已删除。图标同理统一 `lucide-react` 组件（每插件自带，不进 import map），界面文本不留符号字形。

**理由**：SDK 是插件唯一允许依赖的包，且已经通过 import map 以单例下发，所以 `dayjs`/`pretty-bytes` 只需在 `shared/plugin-sdk.js` 里内联一次；放各插件会重复打包，放基座则让"只持元状态"的基座承担了显示规则。同一个字节数要在列表、D 信息页、预览区、空间分析四屏写成同一个样子，四份实现就是四次漂移的机会。

**单位选二进制是刻意的**：Windows 资源管理器按 1024 报体积，列表里的数字必须能和它对上；`binary: false` 的十进制 `KB/MB` 在同一个文件上会显示成另一套数，等于让用户对不上账。

**代价**：改动单位口径会改掉所有用户可见字符串（`2.0 KB → 2 KiB`、`81.0 MB → 81 MiB`），取证脚本必须同批改断言，否则"全绿"是假的。因此 `.scratch/pw/run-f.mjs` 不再自己写一份 `fmtBytes`，而是直接 `import` SDK 的实现——期望串与渲染串同源，不可能再漂移；`run.mjs` 末尾另加两条全局断言：界面文本零 emoji/符号字形、不出现 `KB/MB/GB/TB` 残留。i18n（P6-26）不在本决策范围内：界面按单一语言中文建设。

## D23 · 表格模式归 file-browser 拥有，排序口径由结构强制

**决定**：表格是 `plugin-file-browser` 的**第三种显示方式**，不是新插件、也不是把行模型交给库：数据流、虚拟化、选择与焦点、右键 surface（与列表行同为 `browser.list.item`）、请求序号防过期覆盖全部沿用现有那条流。`@tanstack/react-table` **v9** 只提供排序状态机与列可见性，并且随该插件自己的 dist 打包，**不进** import map 共享单例。排序口径三条都写死在实现里：① 没人点表头时行序**严格等于** `fs.list` 返回的顺序（承 D9，浏览器不重排）；② "文件夹成组在前"由一个隐藏的排序主键 `dir`（不可隐藏、宽度 `0px`、无单元格内容）强制，所以升序降序都不会把目录混进文件里；③ 数值与日期列**第一次点击是升序**（表级 `sortDescFirst: false`，覆盖 v9 从数据值推断出的"数值先降序"）。列可见性存进插件自有偏好 `fm.file-browser.prefs.v1.tableColumns`，名称一列 `enableHiding: false` 因此界面上根本没有关掉它的入口；排序状态**不落任何存储**。几何上表头定高、固定在滚动区之外，行定高，`estimateSize` 因此是精确值。

**理由**：三种显示方式必须给同一目录同一个默认顺序和同一套选中口径，否则用户切模式就是在换语义；行模型若拆进独立插件，就得跨插件传目录状态，破"插件不读彼此私有存储"和 D9 的分工。库自带而非共享，是因为共享单例只留给 React/Mantine/SDK 这一层应用级单例，表格库只有一个消费者。首击升序是能让用户和 Windows 资源管理器对账的肌肉记忆。隐藏主键代替"每处渲染前再 `filter` 一遍目录"是同 D10 的做法：不变量由结构（排序键）保证，不靠每个渲染分支自觉。

**代价**：v9 与网络上大量 v8 例子 API 不通用（`tableFeatures(...)` + `features`、列选项 `sortFn` 而非 `sortingFn`、渲染走 `<table.FlexRender cell={…}/>`），实现时必须读包内自带的 `skills/` 文档而不是凭记忆。表头与虚拟行的网格必须**镜像几何**（同样的左右 1px 透明边框 + 实测滚动条内宽），否则两套 `grid-template-columns` 会差 2~17px，所以验收断言的是计算样式串严格相等而非像素宽度。隐藏主键要前置在每个用户排序状态之前，`onSortingChange` 必须把它从用户状态里滤掉，否则点一次表头就多挂一个 `dir` 项。区间多选（Shift 点选）三种显示方式都还没有，属本决策未覆盖的缺口。

## D24 · 搜索索引引擎选 SQLite FTS5（trigram），不引入 tantivy

**决定**：P7-28 决策门定为 **SQLite FTS5**，而且它不是新依赖——`db` 能力已经在用的 `rusqlite`（`bundled`）本身就带 FTS5。索引库是宿主数据目录下**独立、可整体重建**的 `search-index.db`，形状是一张普通表 `files(rowid, name, parent, is_dir, size, mtime)` 加一张对同一行 `name` 建倒排的**外部内容**表（`content='files'`, `content_rowid='rowid'`, `tokenize='trigram'`），所以正文/名称文本只存一份，索引里只有倒排。本批只索引**文件名与路径**，正文级全文不在本批。中文子串因此靠 trigram；短于 3 个字符的查询退回对 `files` 的 `LIKE '%词%'` 扫描并带 `LIMIT` 兜住。

**spike 事实**（`core-shared/kernel/tests/search_spike.rs`，6 项全过，debug 构建实测）：①bundled SQLite 是 **3.46.0**，libsqlite3-sys 的编译脚本带 `-DSQLITE_ENABLE_FTS5`，`trigram` 分词器可直接用；②`unicode61` 把一整段中文当作**一个** token，`"报告"` 和 `"季度报"` 都命中 0 行——中文文件名子串搜索**必须**用 trigram，这不是偏好；③trigram 要求查询 ≥3 字符：`"报告"`（2 字）MATCH 返回 0 行，而 `LIKE '%报告%'` 返回 2 行，所以短查询要有退回路径；④`LIKE` 写在 FTS 表上会走索引（`SCAN files_idx VIRTUAL TABLE INDEX 0:L0`），写在数据表上是全表 `SCAN files`，所以查询形状要紧；⑤10 万条名称建索引 1170 ms，ASCII 子串查询均值 33 ms、中文子串 26 ms、2 字退回扫描 13 ms；⑥外部内容表的删除必须把**旧值**回喂索引（`INSERT INTO files_idx(files_idx, rowid, name) VALUES('delete', …)`），否则索引与数据失配。

**理由**：文件名搜索要的只是"命中 + 目录优先 + 相关性"，BM25 已经够；而 tantivy 换来的是 Lucene 级的正文全文、分面与模糊匹配，本批一项都不消费，代价却是第二个自带磁盘格式、第二套生命周期、以及"能力层已经是 SQLite"之上再叠一层抽象。按"优先用开源库既有能力"的既定原则，能用依赖树里现成引擎解决的范围，就不引第二个引擎；单进程、单写连接、WAL、可整体重建这些性质也和现有 `db` 能力同构，取消与重建就是一句 SQL。

**代价与边界**：trigram 索引比 unicode61 更大更慢（10 万条约 1.2 s，仍在可接受区间）；<3 字符的查询退化为全表 LIKE，靠有界扫描 + `LIMIT` 兜住；FTS5 的 `snippet()` 对不在索引里的正文无用，所以正文高亮要等正文索引；索引是**缓存而非事实源**，任何时刻可删可重建，界面状态不得依赖它存在。

**复核触发**（任一成立即重开 P7-28）：①要做正文级全文或结果片段高亮；②名称规模让建索引进入分钟级；③需要模糊/拼音匹配（trigram 与 LIKE 都给不了）。届时比较 tantivy 与"FTS5 + 正文表"两条路，并重新评估 D5 的"能力层即隔离层"边界。

## D25 · 命令注册与快捷键调度归基座服务，面板归 plugin-command-palette

**决定**：`PluginHost` 增加 `commands` 面，由 manifest `permissions.commands` 分别授权两半——业务插件只有 `register`、面板插件加 `provide`，整个段缺席=没有命令面。命令的**唯一登记簿**是基座 `commandService`（`apps/shell-ui/src/commands.ts`）：命令 id 全局唯一；快捷键与命令一一对应、先注册者占有，后到的重复或非法快捷键**整体拒绝**该命令并告警；全局只装**一个** window keydown 监听（惰性、capture）；可输入控件里只派发带 Ctrl/Alt/Meta 的和弦（打字 `p` 不会触发布字母的键位，Ctrl+Shift+P 在地址栏里照样可用）；执行有忙碌守卫（同刻只跑一条）与失败捕获（`lastError()` 供面板就地显示）；卸载/停用插件即移除其命令、快捷键与（若持有）面板提供者身份，并清掉 mid-run 的忙碌标记，不让它卡住后续命令。**面板是普通插件** `plugin-command-palette`：占 `command-palette` 槽（基座只渲染 `<PluginSlot>` 出口、不含任何面板逻辑），经 `provide()` 领取唯一 launcher；`Ctrl+Shift+P` 本身作为一条命令注册（`palette.open`），"面板怎么开"和"插件怎么发命令"走同一条路径。命令只在前端总线内执行，不新增 Rust 契约，也就没有 `command:invoke` 事件。

**理由**：与 D19 同一分工——基座管管道（注册、唯一性、调度、清理），插件管画面板。命令 id 与快捷键的唯一性只有单一 owner 能**结构性**保证，否则两个插件可以各自"正常"却互相覆盖；非法快捷键宁可整体拒命令，也不留一条永远不响的死键；卸载即移除要求登记簿不属于面板插件，否则面板一停命令全灭。与 D12 同样的原则：能力由基座判定，插件不能自我豁免（`plugin-dev-slot-harness` 的故意越权正是这条的运行时证据）。

**代价与边界**：`provide()` 先到先得，面板插件被停用时 `Ctrl+Shift+P` 随其命令一起消失——单一面板提供者形态是刻意的。`@mantine/spotlight` 进 import map 共享集（它是 React/Mantine 之外唯一带 hooks 的库，保证面板与任何后续命令 UI 只有一份 store）；面板里的键盘选择依赖库的 `Spotlight.ActionsList` 设置 listId，几何固定（620×420）靠内联覆盖库自带的 `max-height: calc(100% - 3.125rem)`。命令过滤是 descriptor 字段的简单子串匹配，没有拼音/模糊（与 D24 的复核触发一致：真有需求再评估）。

**复核触发**（任一成立即重开）：①需要后端/跨进程命令，或快捷键用户自定义、按上下文切换映射；②命令总量增长到需要分组/模糊搜索/最近使用排序；③出现第二个面板形态（如独立的快速文件跳转入口）。

## D26 · 标签存储迁入 `db.tags`：唯一写者 + 受权只读契约

**决定**：标签与成员的**唯一事实源**从 `fm.view-tags.v1` localStorage 迁到通用 `db` 能力里的 `tags` store（零新 Rust 契约：`db.<store>.<op>` 走动态路由）。kv 行：key = 标签名，value = `{seq, members:[{path,kind}]}`；`seq` 保存创建顺序（kv 行本身按 key 排序，改名不得重排队位）。权限结构：`plugin-view-tags` 持 `db.tags.*`（**唯一写者**）；`plugin-file-browser` 只持 `db.tags.list`（精确匹配，只读）。读路径只有 SDK 的 `listTags`/`parseTagRows` 一条；写成功后 owner 发 `tags:updated`（前端总线事件、**无载荷**——广播快照会制造第二份会过期的共享状态，消费者自行重查）。此批同时修复宿主 `run_db` 的一个潜伏缺陷：key 解析原先在分支前用 `?` 提前返回，使"无 key 列举 kv 行"的分支不可达；修复由宿主单测锁定，`db.tags.list` 无参调用自此是契约的一部分。

**迁移**：owner 载入时若 store 为空且旧 localStorage key 存在，则一次性导入（逐条 put；任一条失败即回滚已写入并报错，可重试；全部成功后删除旧 key；旧 JSON 损坏则只提示、不导入也不删除）。成员口径：同一标签内**按 path 唯一**，kind 只是可刷新的属性；路径逐字符保留（大小写敏感盘上两种拼写可能是两个文件）；同 path 可存在于多个标签。**不自动清理成员**：文件删除/移动/进回收站都不触发成员移除——回收站恢复不应丢标签；失效引用在点击穿越时如实报错，由用户手动移除。

**理由**：chips 与"按标签浏览"要求跨插件读取，而"插件不读彼此私有存储"是既定红线（docs/09 §7）；把 store 放进通用 db 能力，读写在能力层留下 manifest 可见的授权足迹（`db.tags.*` vs `db.tags.list`），结构上就不存在第二份可写副本。`tags:updated` 不带载荷，是为了不制造"事件里的快照"与"库里的真相"两个版本；消费者重查一次 `db.tags.list` 是廉价的。`seq` 落库而不是靠改名重排，是因为"创建顺序"是一个事实，不该随改名漂移。

**代价与边界**：db 写失败时 UI 必须诚实——提示并重载真相，面板因此有 loading/error/重试三态，取代旧的"storage 不可用仍可操作"；旧 key 只有一次导入窗口（store 为空时），非空 store 不再读它。文件系统级的成员一致性不做（见上），批量清理留待真实需求。`tags:updated` 是前端事件，不进 Rust 契约（contract-check 排除集）。

**复核触发**：①出现第二类写者（如命令面板直接编辑标签）；②成员规模让全量 `db.tags.list` 成为性能问题（届时评估点查或增量事件载荷）；③需要按 path 反查标签的索引（chips 侧当前每次重查自建索引，规模上去再谈）。

## 决策速查

| 维度 | 决定 |
|---|---|
| 外壳 | Tauri v2(Rust) |
| 后端内核 | cordis-rs(原生 Rust,tokio,Fiber/Effect) |
| 后端插件 | 静态内置 Rust crate;loader 管启用/禁用/热重组 |
| 前端基座 | React 19 + Vite |
| 前端插件 | 本地 ESM + `import()`,`plugin://` 下发,import map 共享 React |
| 进程模型 | 单 Tauri 进程,无 sidecar/无 Node/无嵌入式 JS 引擎 |
| 能力层 | Rust 原子命令(fs/hash/db/watch),无业务逻辑 |
| 契约源 | `core-shared`(TS `plugin-sdk` + Rust `contracts`)+ 契约测试 |
| 界面标题来源 | 贡献者 manifest `slots[].label` → `host.slotLabel`(容器不硬编码他插件名,见 D6) |
| 亮/暗主题 | Mantine 内置 colorScheme(默认亮色;基座与插件共用单例,不自造主题层,见 D7) |
| 图片预览 | 统一 `plugin-preview` + Open File Viewer；本地文件经受权预览句柄读取，图片缩略图另经 Windows Shell `shell.thumbnail.read`(见 D8) |
| 文件版本历史 | 目标形态：Lore 为版本事实来源 + `plugin-history-metadata` 存展示快照(D16/D17)；**集成暂缓**(D21)，当前沿用 hash/DB 快照且不宣称可恢复 |
| 压缩包浏览/解压 | 独立 `plugin-archive` 已取消；预览器的只读格式支持另行评估(见 D18) |
| 类型识别/卷信息 | `file.kind` = 内核单一扩展名表(不嗅探)；`sys.disk` = 直接 Win32；不引 `infer`/`mime_guess`/`sysinfo`(见 D20) |
| 右键菜单 | `plugin-context-menu` 管框架；业务插件注册自有动作并自行执行(见 D19) |
| 列表顺序/mtime | provider 在 `fs.list` 里排好(自然序)并带 `modifiedMs`,浏览器不排序(见 D9) |
| 分栏几何不变量 | 容器 owner 保证"栏高有界 + outlet 不滚动",内容插件只写 `height:100%`(见 D10) |
| 设置入口形态 | 独立插件 `plugin-settings` 的悬浮 `Popover`(不占六区、不是 B 视图;分页软件设置/插件设置,见 D11) |
| 插件启停 | owner = 基座 `loader`;不可关闭集合由基座判定,`plugins.*` 是基座前端能力、不进 Rust 契约(见 D12) |
| 插件设置页生效方式 | 页内容自持 + 同插件内模块级 store 广播,基座不持有设置状态(见 D13) |
| 图标 | `lucide-react` 组件,每插件自带;界面文本不留 emoji/符号字形(见 D22) |
| 时间/体积格式 | SDK 的 `formatSize`(pretty-bytes, 二进制单位)/`formatDate`/`formatDateTime`/`formatClock` 是单一事实源,插件与取证脚本都不自写(见 D22) |
| 表格模式 | 归 `plugin-file-browser`；`@tanstack/react-table` v9 只出排序与列可见性、按插件自带；未排序透传 provider 顺序，隐藏 `dir` 主键保证目录成组，首击升序，排序不落存储、列开关进插件偏好(见 D23) |
| 搜索索引引擎 | SQLite **FTS5** + `trigram`（`rusqlite` bundled 自带，非新依赖），独立可重建的 `search-index.db`，外部内容表不复制正文；不引 tantivy(见 D24) |
| 命令面板/快捷键 | 基座 `commandService` 是唯一登记簿（id 全局唯一、快捷键一一对应、单一 window 监听、忙碌与失败捕获、卸载即移除）；面板 = `plugin-command-palette` 领取唯一 launcher；Ctrl+Shift+P 自身也是命令(见 D25) |
| 标签存储 | 迁入通用 db 能力 `db.tags`（key=标签名, value={seq,members}）；owner 独占 `db.tags.*` 写、file-browser 只读 `db.tags.list`，读走 SDK `listTags`，写后发无载荷 `tags:updated` 重查；旧 localStorage 一次性导入、不自动清成员(见 D26) |
