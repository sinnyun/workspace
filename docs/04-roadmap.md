# 04 · 路线图与进度追踪

本文是**实现进度的事实源**。每完成一轮工作,必须更新对应任务的状态,并在「证据」列填入本轮的命令输出摘要或 commit。文档与代码不一致时,以本文标注的状态为准去追代码。

---

## 状态图例

| 标记 | 含义 |
|---|---|
| ✅ | 已实现并验证(有证据) |
| 🟡 | 已实现未验证 |
| 🔵 | 已决定未实现(设计已定,代码未写) |
| ⚪ | 待调研(方案/API 尚未确认) |
| ❌ | 已否决 / 明确不做 |

> 当前进度:Phase 0–4 主线已打通并有证据;Phase 5 基本完成(打包 ✅、可观测 ✅、契约冻结 v1 ✅、
> 权限拒绝路径 ✅、错误隔离后端无头测试 ✅)。后端垂直切片由无头集成测试 `cargo test -p fm-kernel`
> 证实;前端基座与插件加载由 `vite dev` 浏览器实测证实(共享单例 + 运行时 `import()`);NSIS 安装包由
> `tauri build` 产出。**Tauri 窗口内的可视化验证在本环境(无显示器)未做**,相关项标 🟡 而非 ✅。
> API 事实参考见 [07-cordis-api-memo.md](07-cordis-api-memo.md)。
>
> **Phase 6 已立**:2026-10-08 开源库使用审计后,把 [06](06-open-source-stack.md) 的既定选型逐项转成可执行任务(6A 能力 / 6B 前端插件 / 6C 工具链 / 6D cordis 运行时 / 6E 界面框架与布局 / 6F 开发期演示与调试插件),后续开发按 Phase 6 接入并使用这些库。审计中 cordis-rs 侧发现的**已声明未用**依赖(`cordis-loader`/`cordis-timer`)不删除,由 P6-41/P6-42 转正启用。
>
> **6F 已交付(2026-10-08)**:跑通"参考界面基础信息展示 + 大数据渲染性能观察 + 运行时错误/性能捕获",dev 索引里的演示/调试插件已在 `vite dev` 浏览器实测(见 P6-49~53);6E 容器交付后其挂载点已迁到容器提供的嵌套槽(`detail-info-zone`/`detail-tab:history`/`nav-panel:stress`)。
>
> **6E 框架布局已交付 P6-43~48(2026-10-08)**:基座渲染六区外层网格 + 顶部会话容器(每会话一份级联快照、可折叠、宽度记忆),级联元状态经协调事件总线单一路径写入,嵌套槽运行时 `provideSlot`/`contributeToSlot` + `slot:*` 生命周期 + manifest gating;C 分栏容器 `plugin-layout-panes`、D 详情容器 `plugin-inspector`、B 互斥容器 `plugin-layout-views`、侧栏视图 `plugin-view-file-tree`/`-favorites`/`-tags`、主浏览能力外置 `plugin-file-browser` 全部在 `vite dev` 浏览器实测(见各任务证据)。6F 演示插件已迁到容器化挂载点(`detail-tab:*`/`nav-zone` 视图),基座不再持有任何业务状态(红线 2)。
>
> **6E 第二轮交付 P6-56~60(2026-10-08,对照 `docs/界面布局.jpg` 收口)**:基座外壳改全 Mantine 组件并以**亮色**为默认(`MantineProvider defaultColorScheme="light"`),顶栏三态主题切换(跟随系统/亮色/暗色)与 `plugin-settings` 面板操作同一份 Mantine 配色值;新增**槽标签发现面**(manifest `frontend.slots[].label` → `host.slotLabel`),D 的 tab 标题由贡献者自己声明、容器零硬编码;`plugin-file-browser` 每栏拿到**独立地址栏 + 后退/前进/上级/刷新历史栈**与 列表/网格 双模式(统一 `@tanstack/react-virtual` 流、文件夹/文件分组、类型图标);D 增焦点标题条、A/B/C/D 文案与状态栏全中文;新增 `plugin-settings`、`plugin-preview-text`。全 14 个 dev 插件加载 0 控制台错误。
> **6E 后续收口(2026-10-09,按实际使用反馈)**:Mantine 主题统一管理颜色、字体、圆角、阴影、焦点与基础控件样式；壳层 CSS 只负责布局几何/滚动/响应式，插件内容使用 Mantine 组件和主题变量。顶部主题切换移除，设置面板是唯一主题入口；文件浏览与分栏插件各向 `topbar-zone` 贡献一个下拉按钮，分别切换列表/网格与单/双/四栏。此规则覆盖 P6-56/57 原“顶栏主题切换”交互，Mantine 共享主题能力和亮色默认保留。
>
> **Phase 7 已立(2026-10-09)**:按 [09 §8](09-plugin-functional-spec.md) 与 [`docs/plugin-functional/`](plugin-functional/README.md) 把逐插件缺口排成 10 个难度递增批次(P7-1~34),并附**代码现状核对**表校准工作量——已实测交付的部分(分栏拖动、树虚拟化、每栏历史栈、详情 kind 模板)不重做,只补核对确认的真实缺口。两个决策门均已过门:`P7-25`(Lore 结论:暂缓,见 [D21](05-decisions.md))、`P7-28`(定案 SQLite FTS5,见 [D24](05-decisions.md))。
> **批次 1~7 已交付并取证(2026-10-10)**:P7-1~24 中除三处需要真机 GUI 的事实(真 Tauri 窗口、真实 Shell 缩略图字节、真实 `chardetng` 猜测)保持 🟡 外全部 ✅。六套 headless 门禁同时全绿:`run.mjs` 43/43、`run-b.mjs` 15/15、`run-c.mjs` 11/11、`run-d.mjs` 47/47、`run-e.mjs` 47/47、`run-f.mjs` 125/125(截图 `.artifacts/shots/06..85`),加 `pnpm -r typecheck` 干净、`contract:check` `contract OK`、`cargo test -p fm-kernel` 67 passed。新增落地插件:`plugin-context-menu`、`plugin-file-ops`、`plugin-preview`、`plugin-storage-analysis`;新增后端能力:`file.kind`、`fs.openResource/readResource/closeResource`、`shell.fileOperation/cancelFileOperation/openPath/revealItemInDir/pickFile/pickDirectory`、`shell.thumbnail.read`(删除应用侧生成缩略图的 `kernel/src/capabilities/thumb.rs` 路线)、`sys.disk.list`、`sys.scan.start/cancel`;`clipboard.write` 由前端基座自己服务(与 `host.contextMenu` 同类,不进 Rust 契约)。
> **批次 8 决策门 + 批次 10-A 已交付(2026-10-10)**:`P7-25` 结论为**暂缓**——上游 `EpicGames/lore` 未向 crates.io 发布任何 Lore crate(`lore` 名字属无关项目、`lore-vm` 404),设想中的 `lore-vm` 是第三方 `BiloxiStudios/loregui` 的 crate,接入只能 git 自建并承担 pre-1.0 磁盘格式漂移与 `loreserver` 生命周期对 D4 的冲突;`P7-26/27` 随之不排期,历史面板保持 hash/DB 快照(见 [05](05-decisions.md) D21)。`P7-34`(=P6-20/21)交付:A 栏与各面板/工具条的符号字形全部换成 `lucide-react`,时间与体积格式统一由 SDK 的 `formatSize`(`pretty-bytes`,**二进制单位**)/`formatDate`/`formatDateTime`/`formatClock` 提供,六个插件里的自写实现删除,取证脚本 `run-f.mjs` 也改为 import 同一个实现(见 D22)。`run.mjs` 因此新增三条全局展示层断言(零 emoji 字形 / 无 `KB/MB/GB` 残留 / 无 `undefined`、`[object`),六套门禁同时全绿:**43/43、15/15、11/11、47/47、47/47、125/125**,`-r typecheck` 干净、`contract OK`、SDK `node --test` **14/14**。同轮修掉一处证据漂移:SDK 测试仍断言批次 4 已删除的 `Capabilities.thumbImage`(文档此前写"11 项过"即源于此)。
> **批次 10-B 已交付(2026-10-10)**:`P7-31`(=P6-16)表格视图落地——`plugin-file-browser` 增加第三种显示方式,排序与列可见性由 `@tanstack/react-table` **v9** 提供,行模型/选择/右键 surface/虚拟化流仍归本插件拥有;隐藏的 `dir` 排序主键保证两种方向都文件夹在前,未排序时严格保持提供方顺序(D9)。取证脚本新增第七套 `.scratch/pw/run-g.mjs` **49/49**(截图 86~88),七套门禁与本批一起复跑全绿(43/43、15/15、11/11、47/47、47/47、125/125、49/49)+ `-r typecheck` + `contract OK` + SDK 14/14 + `cargo test -p fm-kernel` 67 passed。顺带修掉一处**既有缺陷**:带记住目录启动的栏位此前从不发起 `fs.list`,永远停在"正在加载目录…"(详见 [00](00-handover.md) §4)。
> **批次 11 已交付(2026-10-10)**:`P7-32` 标签 chips 跨插件契约落地——标签存储迁入通用 db 能力 `db.tags`(kv 行 key=标签名,value `{seq,members:[{path,kind}]}`,决策见 [05](05-decisions.md) D26):`plugin-view-tags` 重构为**唯一写者**(独占 `db.tags.*`),消费方只经受权 `db.tags.list`(SDK `listTags`/`parseTagRows`)读取并订无载荷 `tags:updated` 重查;旧 `fm.view-tags.v1` 在 store 为空时一次性导入(脏值清理并如实提示、任一条写失败即回滚、成功后删旧键,损坏 JSON 只提示)。`plugin-file-browser` 在列表/网格/表格三种模式渲染标签 chips(超两条折 `+N`、悬停给出其余名),点击 chip 打开 `标签「X」` 视图(与目录共用同一导航栈、`tag://` 编码不外显、无上级目录、成员大小/时间如实显示 `—`,标签被删即时报"已不存在"、撤销删除后视图自愈,每栏记忆恢复后重新拉成员)。取证脚本新增第九套 `.scratch/pw/run-i.mjs` **70/70**(截图 200~207:写路径与库内真值 / 旧键导入与脏数据清理 / 伪造脏行的读取侧清洗与 seq 排序 / 标签视图与栈·记忆·自愈 / 表格标签列不可排序 / 控制台干净),九套门禁同轮复跑全绿(43/15/11/47/47/125/49/87/70)、`cargo test --workspace` **118 passed**、SDK `node --test` **15/15**、Vitest **14/14**、`contract:check` OK、`pnpm -r typecheck`/biome/`cargo fmt --check`/clippy/`build:plugins`+`build:shared` 干净。顺带修掉一处**既有缺陷**:表格表头用 v9 恒返回函数的 `getToggleSortingHandler` 判断列可排序与否,展示列(标签)因此看起来能点还挂着排序箭头——改问 `getCanSort()`(见 [00](00-handover.md) §4);另修三处**证据漂移**(`run.mjs` 仍断言"标签筛选暂未支持"、`run-c.mjs` 的缩略图定位扫描停在旧卡片高度、`run-g.mjs` 的列数期望停在 4 列)并格式化 `apps/host` 的一处 rustfmt 违规。

---

## 里程碑总览

| 阶段 | 目标 | 关键产出 | 依赖 |
|---|---|---|---|
| **Phase 0** | 工程基线 + 关键风险验证 | 双工作区骨架、cordis-rs↔Tauri 集成跑通、前端 import() 跑通 | — |
| **Phase 1** | 后端内核 + 能力层 | cordis-rs 内核引导、原子能力命令、事件桥、loader | P0 |
| **Phase 2** | 前端基座 + 插槽 + 加载器 | React 骨架、PluginSlot、事件总线、前端插件动态加载 | P0 |
| **Phase 3** | 插件规范固化 + SDK | manifest schema、plugin-sdk/contracts、权限模型、脚手架 | P1,P2 |
| **Phase 4** | 首个全栈插件打通 | file-history 前后端 + 全链路数据流验证 | P3 |
| **Phase 5** | 加固与打包 | 错误隔离、可观测、tauri build、契约冻结 v1 | P4 |
| **Phase 6** | 既定开源栈落地 | 把 [06](06-open-source-stack.md) 选型接入:能力扩展 / 功能插件 / 质量工具链 / cordis 运行时补全 | P4(基座可用即可并行推进) |
| **Phase 7** | 插件功能按规格收口 + 规划插件落地 | 依 [09 §8](09-plugin-functional-spec.md) 与 [`docs/plugin-functional/`](plugin-functional/README.md) 逐插件补齐目标行为;9 个批次按难度递增排期 | P6(容器/槽/能力基线已交付) |

---

## Phase 0 · 工程基线与关键验证

> Phase 0 的目的是**在写任何业务前,把两个头号技术风险用最小 spike 证伪/证实**。P0-3 与 P0-4 未通过前不进入后续阶段。

| # | 任务 | 完成条件 | 状态 | 证据 |
|---|---|---|---|---|
| P0-1 | 初始化 cargo + pnpm 双工作区与目录骨架 | 根 `Cargo.toml`/`pnpm-workspace.yaml` 就位,空 `apps/host`、`apps/shell-ui`、`core-shared/*`、`plugins/plugin-file-history/*` 可被两工作区识别;按 [06-open-source-stack.md](06-open-source-stack.md) 选型引入基础依赖并锁版本 | ✅ | `cargo test --workspace` 与 `pnpm -r typecheck` 全绿;成员含 contracts/kernel/host/shell-ui/plugin 前后端 |
| P0-2 | Tauri v2 最小窗口跑通 | `tauri dev` 打开窗口,加载 shell-ui 的 hello 页面 | 🟡 | `fm-host` 编译通过、`tauri build` 产出 NSIS 安装包可运行;窗口可视化本身在本环境(无显示器)未验证 |
| P0-3 | **cordis-rs ↔ Tauri 异步集成 spike** | 在 Tauri `setup` 内 `Context::new()` 并 `spawn` 一个 hello `Plugin` fiber;`ctx.emit` 一个事件、`ctx.on` 收到;`fiber_handle.dispose().await` 成功且 Effect 清理 | ✅ | spike `cargo run -p cordis-boot` 通过;真实集成落于 `apps/host` setup:`Kernel::new`+`start_backend`+`EventBridge`,`cargo test -p fm-kernel` 证实 spawn/emit/on/dispose(fiber_count 归零) |
| P0-4 | **前端 `import()` 本地 ESM spike** | shell-ui 运行时 `import()` 一个本地 test 插件 ESM,渲染组件到插槽;确认经 import map 复用宿主 React 单例(hooks 不报多实例错) | ✅ | `vite dev` 浏览器实测:运行时 `import()` 加载 plugin-file-history ESM,HistoryPanel 渲染进 `file-sidebar-zone`,hooks/ Mantine 单例无多实例错 |
| P0-5 | cordis-rs API 摸底并锁定版本 | 记录 `Plugin`/`Context`/`Service`/`Event`/`Effect` 的确切签名与 loader/hmr crate 可用性;产出 `core-shared/contracts` 初版类型 | ✅ | `cordis-core v0.6` 锁定并实测;签名记入 [07-cordis-api-memo.md](07-cordis-api-memo.md) |
| P0-6 | 自定义 `plugin://` 协议下发验证 | host 注册协议,WebView 能取到本地插件文件并 import | 🟡 | `register_asynchronous_uri_scheme_protocol` 已注册且带路径穿越防护;浏览器 dev 走 `/dev-plugins` 等价路径已实测,`plugin://` 本体需 Tauri 窗口验证 |

---

## Phase 1 · 后端内核 + 能力层

| # | 任务 | 完成条件 | 状态 | 证据 |
|---|---|---|---|---|
| P1-1 | 能力层骨架 | `fs.readChunk`/`fs.list`/`fs.stat`/`hash.compute` 作为 `#[tauri::command]` 可被前端 invoke,返回正确 | 🟡 | 命令已注册并编译;能力本体由 `cargo test -p fm-kernel` 证实;经真实 Tauri invoke 的往返待窗口验证(浏览器 dev 走 mock) |
| P1-2 | 能力以 cordis `Service` 暴露给后端 | 后端插件能经 DI 拿到能力句柄并进程内调用(非 IPC) | ✅ | `backend_slice.rs`:插件经 `ctx.try_service::<FsCapability>()` 等进程内调用 |
| P1-3 | 事件桥 | 后端 `ctx.emit::<E>` → Tauri emit → 前端总线收到同名事件;负载 JSON 往返一致 | 🟡 | `ctx.emit`→observer 由 `backend_slice` 证实;observer→`app.emit`→前端 `bridgeBackend` 链路编译通过,跨进程段待窗口验证 |
| P1-4 | 文件监听能力 | `watch.subscribe` 基于 notify;文件变更产生 `file:changed` 事件 | 🟡 | `WatchHub`(notify-debouncer)已实现并经 `watch.subscribe` 能力暴露;真实文件系统触发未在无头测试中行使 |
| P1-5 | 存储能力 | `db.<store>.*`(sqlite,按 store 分区隔离),读写可用 | ✅ | `backend_slice` 经 `db.read_log/append` 证实;`:memory:` 与 WAL 路径均覆盖 |
| P1-6 | 内核引导 + loader | 从各 manifest 生成加载计划,`spawn` 已启用后端插件;运行时禁用 = `dispose` 其 fiber,无残留 | ✅ | `Kernel::start_backend` 按 registry 顺序 spawn;`shutdown` 反序 dispose 后 `fiber_count==0`(backend_slice) |
| P1-7 | 流式哈希 + 多线程遍历 | 大文件 `hash.compute` 流式分块;`fs.list` 多线程;基准达预期(见 R7) | 🟡 | 流式分块哈希已实现(blake3/sha2);性能基准未跑 |

---

## Phase 2 · 前端基座 + 插槽 + 加载器

| # | 任务 | 完成条件 | 状态 | 证据 |
|---|---|---|---|---|
| P2-1 | 布局骨架 | 侧边栏/顶栏/主视图区渲染,响应式基本可用 | ✅ | 浏览器截图:topbar/nav/main/sidebar/status 五区渲染 |
| P2-2 | `<PluginSlot>` | 具名插槽组件,按 slotId 渲染已注册组件;无插件时降级为空 | ✅ | dev 有插件时渲染 HistoryPanel;preview(无插件源)同插槽降级为空,基座不报错 |
| P2-3 | 元状态 + 事件总线 + host 对象 | `currentFileId` 变更广播 `selection:changed`;`PluginHost` 按契约注入 | ✅ | 点击行后 status bar 与插件面板同步更新;`state.ts` 在变更时 `bus.emit(Events.selectionChanged)` |
| P2-4 | 前端插件加载器 | 读 manifest → `import()` entry → 挂载 slots/activate → 支持卸载钩子;加载失败降级为空插槽并记录 | ✅ | loader 实测加载+挂载;preview 下 entry 404 时按插件隔离降级并 `console.error`,基座继续运行 |
| P2-5 | 样式与主题统一 | Mantine 共享单例 + 基座统一主题；壳层 CSS 限定布局，插件 UI 使用 Mantine 组件与主题变量，不用 Shadow DOM | ✅ | 样式规范详见 `docs/01-architecture.md` §7；旧 CSS Modules 方案已由后续 Mantine 集中样式规范取代 |
| P2-6 | import map + React/Mantine 单例 | 生产构建下插件复用宿主 React 与 Mantine,无多实例 | ✅ | `shared-dist`(prod)/`shared-dist-dev`(dev)双变体 + import map;dev 与 `vite preview` 均渲染,hooks 跨 host/插件无多实例错;宿主 bundle 仅 ~16KB(库全外部化) |

---

## Phase 3 · 插件规范固化 + SDK

| # | 任务 | 完成条件 | 状态 | 证据 |
|---|---|---|---|---|
| P3-1 | manifest JSON Schema + 校验 | schema 定稿;装载时校验,非法 manifest 被拒并给清晰错误 | ✅ | `fm_contracts::manifest::PluginManifest` + `validate()`;Rust 测试 4 项过(含坏 schemaVersion/缺 permissions 拒绝);前端 loader 经 SDK `validateManifest` 同规则 gating |
| P3-2 | `core-shared/plugin-sdk`(TS) | `PluginHost`/`SlotProps`/事件负载类型导出;前端插件仅依赖它 | ✅ | SDK 导出类型+`Events`/`Capabilities`/`validateManifest`/`matchesPermission`/`disposer`;`node --test` 5 项过;插件 frontend 仅依赖该包 |
| P3-3 | `core-shared/contracts`(Rust)+ 契约测试 | Event/Capability 类型定稿;契约测试校验 TS/Rust 事件名与字段一致 | ✅ | `pnpm --filter shell-ui contract:check`:事件名/事件字段/能力名/DTO 字段全 ok;负向验证(改 SDK 能力名)正确 FAIL |
| P3-4 | 权限模型 | 能力/事件白名单在装载与运行时校验;越权调用被拒(见 §8 校验点) | ✅ | `matchesPermission`(精确/`.*`/`*`)单测覆盖;host.ts 在 invoke/on/emit 三处强制,越权 invoke 抛错、on/emit 告警并忽略 |
| P3-5 | `build.rs` 后端注册表生成 | 扫描 manifest 自动生成注册表 + 加载计划,无手写漂移 | 🔵 | 注册表当前为 `fm-kernel::registry` 手写;生成器未做 |
| P3-6 | 插件脚手架模板 | 一条命令生成合规的 backend/frontend/manifest 骨架 | 🔵 | 未做 |

---

## Phase 4 · 首个全栈插件打通(file-history)

| # | 任务 | 完成条件 | 状态 | 证据 |
|---|---|---|---|---|
| P4-1 | 后端插件 | 订阅 `file:changed` → `hash.compute` 比对 → 变动写 `db.history` → `emit history:updated` | ✅ | `backend_slice`:emit file:changed → 历史写入且 hash 与 `hash.file` 一致;重复 emit 幂等(仍 1 条) |
| P4-2 | 前端插件 | `HistoryPanel` 时间线;订阅 `history:updated` + `selection:changed`,展示当前文件历史 | ✅ | 浏览器实测:选中 notes.txt 后 Mantine Timeline 展示 2 条历史(hash+时间),经 gated `db.history.list` |
| P4-3 | 全链路联调 | 改文件内容 → 后端记录一条历史 → 前端时间线**自动**刷新(无轮询) | 🟡 | 后端段与前端段分别证实;真实 watcher→Tauri emit→前端自动刷新需窗口验证 |
| P4-4 | 前端 drop-in 验证 | 构建后的前端插件放入插件目录,**不重建宿主**即出现面板且数据流通 | ✅ | dev 从 `plugins/*/frontend/dist` 直接伺服已构建 ESM,宿主未重建即加载渲染 |
| P4-5 | 禁用/卸载验证 | 运行时禁用 → 前端卸载钩子执行 + 后端 fiber dispose,监听器/句柄无残留 | 🟡 | teardown/dispose 路径已实现(loader teardowns、kernel shutdown 归零);运行时禁用 UI 未做 |

---

## Phase 5 · 加固与打包

| # | 任务 | 完成条件 | 状态 | 证据 |
|---|---|---|---|---|
| P5-1 | 错误隔离 | 前端插件抛错不击穿基座;后端 fiber panic 被内核捕获并 dispose,不影响他插件与主进程 | 🟡 | 后端: `panic_isolation` 无头测试通过——`apply` panic 经 cordis `contained.rs` 收敛为 `Failed`,`ready()` 返回 Err,失败 fiber 不入 roster,同 Kernel 的 file-history 兄弟仍能响应 `file:changed`;前端: `PluginErrorBoundary` 按插件包裹 + loader/eventbus try/catch(窗口视觉确认待显示环境) |
| P5-2 | 权限拒绝路径测试 | 越权 invoke/emit 被拒并告警,有测试覆盖 | ✅ | SDK 单测覆盖 `matchesPermission` 拒绝分支;host 拒绝路径(invoke 抛错/on、emit 告警)已接线 |
| P5-3 | 日志/可观测 | 接入内核生命周期诊断并转发到统一日志管道;关键事件可追踪 | ✅ | host 初始化 `tracing_subscriber`(EnvFilter,info 默认);fm-kernel `logger.rs` 用 cordis 原生 `Logger`/`add_exporter` 面把 Runtime 诊断(contained panic、dispatch/lifecycle/effect 错误)桥接为 `tracing` 事件,`LogBridgePlugin` 作为首个 fiber 发布;无头测试 `logger_bridge` 证实经同一 `add_exporter` 注册的 exporter 能收到带 level/channel/text 的记录。未引入独立 logger crate(cordis 自带面已足够) |
| P5-4 | 打包 | `tauri build` 产出可运行安装包;前端插件分发目录约定明确 | ✅ | `npx tauri build` 成功: `target/release/bundle/nsis/File Manager_0.1.0_x64-setup.exe`(~3.9MB), `fm-host.exe` 16.9MB;`dist/shared/*` 9 文件随包产出;插件分发目录见 [03-project-layout.md](03-project-layout.md) |
| P5-5 | 契约冻结 v1 | manifest/SDK/能力/事件契约标为 v1,文档回填,后续变更走版本流程 | ✅ | [02-plugin-spec.md](02-plugin-spec.md) §7.1 冻结 v1(manifest `schemaVersion==1` / 能力名 / 事件+负载 / DTO 形状)并声明变更走版本流程;`contract:check` 退出 0(事件名/负载、能力名、DTO 字段 TS↔Rust 一致)作为漂移回归 |

---

## Phase 6 · 既定开源栈落地(能力扩展 + 功能插件 + 工具链)

> 目的:把 [06-open-source-stack.md](06-open-source-stack.md) 已选型的开源库**真正接入**,而不是停在清单。每项注明**用哪个库**、**装在哪(隔离层)**、**完成条件**。新增后端能力一律落在 `core-shared/kernel/src/capabilities/*`(对外只经 `db.<store>.*` / 能力名契约);新增前端功能一律做成**插件**(运行时 `import()`),共享依赖走 import map 单例。跨层新数据形状先加 `core-shared/contracts`↔`plugin-sdk` 并跑 `contract:check`。
>
> **这些库按插件的分布(哪个插件拉起哪些 P6 任务、占哪些插槽、声明哪些能力/事件)见 [08-plugin-catalog.md](08-plugin-catalog.md)。** 下面 6A/6B/6C/6D/6E 是"按库/任务"视角,08 是"按插件"视角,同一批工作两种切面。

### 6A · 后端能力层扩展(Rust,走 capabilities 隔离层)

| # | 能力 / 任务 | 采用库 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-1 | 并行目录遍历 + 大目录基准(收口 P1-7) | 定案改为自有有界工作线程池(`std::fs` + 8 worker),不引 `jwalk`/`rayon`/`ignore` | 体积统计走 `sys.scan.start` 的并行遍历;`fs.readChunk`/`hash.compute` 流式分块;10 万级真实磁盘基准仍未跑 | 🟡(P7-23 交付实现,基准未取证) |
| P6-2 | Windows 原生回收站删除 | Windows Shell `IFileOperation` + `FOFX_RECYCLEONDELETE` | `plugin-file-ops` 经授权 host capability 调用；由系统处理回收站和确认，不实现永久删除 | 🟡(随 P7-16/P7-17:契约与前端已交付,provider 已实现;真机 Shell 行为待有显示器环境取证) |
| P6-3 | Windows 原生复制 / 移动 | Windows Shell `IFileOperation` + 系统冲突/进度对话框 | `plugin-file-ops` 不引入 `fs_extra` 或自写分块复制；COM 调用放专用 STA 线程，返回逐项结果和取消状态 | 🟡(随 P7-16/P7-17:同上) |
| P6-4 | 文件名自然排序 | `natord` | 列表/排序 "2 file" < "10 file" | ✅(`fs.list` 出参按 `natord::compare_ignore_case` 排好,provider 负责顺序,浏览器不再排序;dev mock 生成序与之对齐) |
| P6-5 | 磁盘/系统信息 | 定案：直接 Win32(`GetDiskFreeSpaceExW`/`GetVolumeInformationW`),不引 `sysinfo`(见 D20) | 能力 `sys.disk.list`(剩余空间、文件系统名)随 P7-23 交付 | ✅ |
| P6-6 | 类型识别(MIME) | 定案：内核单一扩展名表,不引 `infer`/`mime_guess`,不嗅探(见 D20) | 能力 `file.kind` 随 P7-16 冻结并交付,供预览/图标/右键三屏消费 | ✅ |
| P6-7 | 旧应用自制图像缩略图（迁移源记录） | 当前 `image` + `base64` 实现 | 当前代码经 `thumb.image` 解码/缩放；该实现由 P6-66 替换，目标应用不得自制缩略图 | ✅ 现有实现；已被新决策取代 |
| P6-8 | 文本编码探测 | `encoding_rs` + `chardetng` | `fs.readText` 非 UTF-8 正确预览 | ✅(随 P7-19 交付) |
| P6-9 | 名称/路径检索（=P7-28/29） | SQLite **FTS5** + `trigram` 分词（定案见 [D24](05-decisions.md)，不引 tantivy） | 搜索后端独立索引库 + `search.query`/`search.status`/`search.index.*` 能力；正文全文检索不在本任务范围，索引不存正文副本 | ✅（契约冻结于 P7-28；索引后台/查询/重建/取消随 P7-29 交付，检索界面随 P7-30 交付；取证见批次 9） |
| P6-10 | 归档浏览与解压 | `plugin-archive` | 曾规划 zip/tar/7z 虚拟目录浏览与解压；已取消，不纳入当前开发路线；统一预览器内的压缩包只读预览单独评估 | ⚫ 已取消 |
| P6-11 | 文本差异(file-history 内容 diff) | Lore revision diff API；文本展示 `react-diff-view` | 优先由 Lore 提供版本比较；若接口不覆盖纯文本显示需求，再用 `react-diff-view` 呈现 | 🔵（随 Lore 历史迁移） |
| P6-12 | DB schema 迁移 + 并发池 | `refinery`(版本化迁移)+ `r2d2_sqlite`(多线程池) | 当出现 schema 演进即引入 refinery;当前 rusqlite 单连接直连为已知延后项 | 🔵 |
| P6-13 | 增量版本存储(块级历史,可选) | `fastcdc`(内容定义分块) | 仅在做块级去重历史时启用;否则不引 | ⚪ |

### 6B · 前端功能插件(React + Mantine 生态 + 专用库)

| # | 功能 / 任务 | 采用库 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-14 | 命令面板(Ctrl+Shift+P) | `@mantine/spotlight` | 基座命令总线 + 插件可注册命令 | ✅（随 P7-30 交付：基座命令服务 + `plugin-command-palette`，见 [D25](05-decisions.md)） |
| P6-15 | 大文件列表虚拟滚动 | `@tanstack/react-virtual` | 十万级列表不卡 | ✅(已接进 `plugin-file-browser`:列表/网格/表格合并成**一条**虚拟化流,`estimateSize` 按行/头/卡片区分;浏览器实测 50 万条目常驻 DOM ~200(列表)/~500(网格)节点,见 P6-62) |
| P6-16 | 表格视图(排序/列/选择) | `@tanstack/react-table` | 详情列表模式 | ✅(随 P7-31 交付:`plugin-file-browser` 的第三种显示方式,列排序 + 列可见性 + 每栏独立,选中口径与列表/网格一致(单击单选 + 全选;Shift 区间多选三种模式都还没有,不属于本批)。`react-table` **v9** API,按插件自带打包) |
| P6-17 | 目录树 | `react-arborist`(或 TanStack Virtual 自绘) | 虚拟化树 + DnD/重命名/键盘 | 🟡(虚拟化树 + 自写懒加载已交付并实测,见 P6-48;DnD/重命名未做) |
| P6-18 | 文件条目拖放 | — | 已从功能范围移除 | ❌ |
| P6-19 | 快捷键 | 定案：自写派发器（不引 `react-hotkeys-hook`，见 [D25](05-decisions.md)） | 基座级键位，插件在命令描述符里声明；单一 window 监听、可输入控件里只派发带 Ctrl/Alt/Meta 的和弦 | ✅（随 P7-30 交付） |
| P6-20 | 图标 | `lucide-react` | 基座与插件统一图标源,替换现有内联/emoji | ✅(基座顶栏/折叠/会话、D 焦点标题、browser 文件类型图标、A 栏活动图标、各工具条与面板的符号字形全部为 lucide 组件;界面文本零 emoji 由 `run.mjs` 断言守住。`@vscode/codicons` 未引入——单一图标源已够用) |
| P6-21 | 日期 & 文件大小格式化 | `dayjs` + `pretty-bytes` | 时间线/列表展示 | ✅(SDK 的 `formatSize`/`formatDate`/`formatDateTime`/`formatClock` 是单一事实源,插件内自写实现已删除,见 [05](05-decisions.md) D22) |
| P6-22 | 统一文件预览插件 | Open File Viewer React SDK（MIT；依赖与格式按需验证） | 唯一 `plugin-preview` 承载文本/图片/PDF/音视频/Office/压缩包分派、受限本地资源句柄、按需 worker/资源清理 | ✅(随 P7-21 交付) |
| P6-23 | 版本 diff 面板 | `react-diff-view` | 消费 P6-11 后端 diff | 🔵 |
| P6-24 | 统一预览格式覆盖 | Open File Viewer 内部格式插件（只保留一个应用预览插件） | 文本/代码/Markdown、图片、PDF、音视频、Office、压缩包已按代表性本地样本逐类取证；表外类别(如矢量图)在申请句柄前如实拒绝 | ✅(随 P7-22 交付) |
| P6-25 | 磁盘占用 treemap | `echarts`(`echarts/core` + `TreemapChart` + `CanvasRenderer`) | 消费 `sys.disk.list` + `sys.scan.start` 的聚合遍历数据，下钻/合并/取消随 P7-24 交付 | ✅ |
| P6-26 | i18n | `i18next` + `react-i18next` | 基座+插件文案 | 🔵(界面按**单一语言中文**建设,暂无第二语言需求;P7-34 只收口图标与格式化,不含 i18n) |
| P6-27 | 操作参数表单 | Mantine form/modal（仅收集新名称/目标等参数） | 表单负责输入校验和确认；实际重命名/创建/删除均委托系统原生 provider，不实现文件操作算法 | ✅(随 P7-18 交付:`plugin-file-ops` 的 modal 收集新名称/目标,校验在 modal 内完成) |
| P6-28 | 系统级通知 | `tauri-plugin-notification` | 长任务完成通知(应用内通知已用 `@mantine/notifications`) | 🔵 |
| P6-29 | 窗口状态记忆 / 单实例 | `tauri-plugin-window-state` / `tauri-plugin-single-instance` | 记住尺寸位置;禁多开 | 🔵 |
| P6-30 | 默认程序打开 / 资源管理器定位 | `tauri-plugin-opener`(已装)+ `tauri-plugin-dialog`(已装) | 经 host capability 暴露默认关联打开、reveal 与系统文件/目录选择；纳入 `plugin-file-ops` 统一入口 | 🟡 |

### 6C · 质量 / 构建 / 发布工具链(06 §3)

| # | 任务 | 采用工具 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-31 | 前端 lint + format | `Biome` | 配 `biome.jsonc`,纳入 typecheck 脚本与 CI;统一 fmt 门禁 | ✅(全仓 116 文件零诊断;`pnpm lint`/`lint:fix`/`format`/`format:check`;CI 接入随 P6-35) |
| P6-32 | Rust lint + format 门禁 | `clippy` + `rustfmt` | CI 阻断 clippy warning / fmt diff | ✅(全 workspace 零 fmt diff、`-D warnings` 零 clippy 报告;`pnpm lint:rust`/`format:rust`/`format:check:rust`/`test:rust`;CI 接入随 P6-35) |
| P6-33 | 前端单测 | `Vitest` + `@testing-library/react` | 补 **`PluginSlot` 错误边界**渲染测(当前 P5-1 前端无测);基座关键组件覆盖 | ✅(vitest 2 + jsdom + RTL 16;`pnpm --filter shell-ui test`,根 `pnpm test` 聚合;14 测:PluginSlot 错误边界 4 + 命令服务 10) |
| P6-34 | 后端测试运行器 | `cargo-nextest` | 本地/CI 用 nextest 跑快、分组好 | 🔵 |
| P6-35 | CI | GitHub Actions(`actions/checkout`+`Swatinem/rust-cache`+`pnpm`+`tauri-action`) | PR 触发:clippy/fmt/`cargo test`/`contract:check`/`pnpm typecheck`/SDK test;发布 job 出跨平台包 | ✅(`ci.yml` 四 job:web/rust/deny/release;各步骤已在本地逐条复跑全绿,**GH Actions 首次执行要等远端 push**) |
| P6-36 | 供应链 / 许可审计 | `cargo-deny`(+`cargo-audit`)、`pnpm audit` | `deny.toml` 进 CI,拦漏洞与不合规许可 | ✅(`deny.toml` + CI 的 deny job;本地 cargo-deny 0.20.2 四类检查全绿;`pnpm audit --audit-level=high` 在 CI 默认 npm 源上执行) |
| P6-37 | 提交前钩子 | `lefthook` | pre-commit 跑 fmt+lint+typecheck | ✅(lefthook 2.2.1 + `lefthook.yml`:biome `--staged` / typecheck / rustfmt;三 job 实测全绿) |
| P6-38 | 版本 / 变更日志 | `changesets` | 前端包与发布说明的版本流程 | 🔵 |
| P6-39 | E2E(桌面) | `WebDriverIO` + `tauri-driver`(官方),备选 Playwright 连 WebView2 CDP | 端到端冒烟;需显示环境(与 P0-2 类同环境限制) | ⚪ |
| P6-40 | 包体积分析 | `rollup-plugin-visualizer` / `size-limit` | 控插件/宿主产物体积;可选 | ⚪ |

**取证(P6-31 · Biome)**:工具链批次的第一项落地。配置 `biome.jsonc`(注释用于写取舍理由):检查范围是白名单——`apps/shell-ui`、`core-shared/plugin-sdk`、`plugins/*/frontend`,共 116 文件（含后来加入的前端单测与 vitest 配置）,**`.scratch/` 取证脚本与各 `dist/` 产物不入选**(`vcs.useIgnoreFile` 另受 `.gitignore` 约束);formatter 定 `space/2/120` + JS/JSX 双引号、分号常开、尾逗号,`assist.organizeImports` 打开,linter 用 `preset: recommended`。**规则取舍两处**:① `styles.css` 的 23 处 `!important` 是刻意策略(压过 Mantine 运行时注入的组件样式),规则只对该文件 `off` 并要求人工复核——`biome check --unsafe` 的修复会直接删掉 `!important`,严禁对该文件使用(`biome.jsonc` 里已写明);② 其余 `24 errors / 33 warnings` 逐个处理:**真修**——`view-favorites` 的 `live`/`writeStatus` 用 `useCallback` 定型(不定型的话自动修复会把"每次渲染都新建"的函数塞进依赖、导致校验循环重跑)、`capture.ts` 去掉 `any`、`main.tsx` 的 `#root` 非空断言改显式守卫、`dev-mocks` 三处非空断言与一处赋值表达式、两处 `key={index}` 换稳定键(文件历史用 `at+hash`、操作结果明细用来源路径);**定点抑制**(每处都带理由注释):8 处 `noStaticElementInteractions` + 7 处 `useSemanticElements` + 2 处 `useFocusableInteractive` 全在"容器承接点击/空白区右键面/虚拟化行与表头"这类刻意用法上——行与表头是绝对定位的 CSS Grid,换成 `<button>/<table>` 会破坏几何,键盘语义已按 button 补全;5 处 `noDescendingSpecificity` 逐个核对过重叠属性由优先级决定、与顺序无关。**一条必须记住的教训**:`--unsafe` 会改行为——它在 `plugin-preview` 删掉了 `[host, path]` 里"闭包没读、但换焦点必须重置"的 `path`(该 effect 递增 `seqRef` 让旧文件的迟到响应失效,删掉后 A 的迟到答案会画进 B),在 `plugin-file-browser` 删掉表头量宽的 `[rows.length]`,在 `view-favorites` 删掉"增删收藏后补校验"的 `pathsKey`;这些与 `LogPanel` 的 `counts`、`context-menu` 的面板定位依赖都按"原语义 + `biome-ignore` 注明理由"恢复,`--unsafe` 之后必须人读 diff。`styles.css` 被 formatter 从 139 行展开成 591 行标准排版,已用脚本证明与 HEAD 内容等价(仅空白与 `.45`→`0.45` 前导零),23 处 `!important` 全数在位。**同轮门禁**:`biome check .` 116 文件零诊断、`pnpm -r typecheck` 21 项目全绿、`pnpm build:plugins` 19 插件、浏览器实测 `run` 43/43、`run-b` 15/15、`run-c` 11/11、`run-d` 47/47、`run-e` 47/47、`run-f` 125/125、`run-g` 49/49、`run-h` 87/87。

**取证(P6-32 · rustfmt + clippy)**:门禁脚本挂上根 `package.json`——`pnpm lint:rust`(`cargo clippy --workspace --all-targets -- -D warnings`)、`pnpm format:check:rust`(`cargo fmt --check`)、`pnpm format:rust`、`pnpm test:rust`(`cargo test --workspace`)。首次 `cargo fmt --check` 在 25 个文件报 163 处 diff(含批次 9 的未提交改动),`cargo fmt` 一次性收口、复跑零 diff;`cargo clippy` 在 `fm-kernel` 报 7 项(5 处源码 + 2 处测试),全部真修、零抑制:① `file_kind.rs` 手写字符比较 `|c| c == '/' || c == '\\'` → 字符数组模式 `['/', '\\']`(与同函数 `rfind(['/', '\\'])` 对齐);② `fs.rs` `looks_binary` 的 U+FFFD 计数 if/else-if 同块合并为 `ch == '\u{FFFD}' || (… )`;③ `shell_ops.rs` 的 `return match …;` 去 return 与分号(Windows 分支成为函数尾表达式,非 Windows 分支 cfg 掉后各编译期只有其一,互不干扰);④ `shell_ops.rs` `build_result` 里 `items.is_empty()` 与 `engine_failed` 两个同值分支并为一个条件并注明"两者都是 Failed 而非部分成功";⑤ `sys.rs` `volume_root_of` 的 `starts_with("\\\\")` + `&path[2..]` 改 `strip_prefix("\\\\")`;⑥⑦ 测试断言 `!…is_ok()`→`…is_err()`、`…is_dir == false`→`!…is_dir`。**同轮门禁**:`cargo fmt --check` 零 diff、`cargo clippy --workspace --all-targets -- -D warnings` 退出码 0(touch `kernel/src/lib.rs` 强制重检 `fm-kernel`+`fm-host` 复核)、`cargo test --workspace` 117 测全过(94 在 kernel 库内,其余为各 crate 与服务端集成)。

**取证(P6-33 · Vitest)**:`apps/shell-ui/vitest.config.ts` 独立一份、**刻意不复用** `vite.config.ts`——后者把 react/mantine/plugin-sdk 外置成共享单例 URL(只存在于被服务的构建产物里),单测要渲染真组件,得让它们按普通包解析(plugin-sdk 的 workspace 链接直指其 TS 源码)。环境 `jsdom`,include `src/**/*.test.{ts,tsx}`;测试文件落在 `tsconfig` 的 `include: ["src"]` 内,`tsc --noEmit` 门禁与 Biome 白名单天然覆盖,不另开豁免。依赖线:`vitest@2.1.9` + `@testing-library/react@16` + `@testing-library/dom@10` + `jsdom@25`(与 vite 5 匹配)。**PluginSlot 错误边界渲染测 4 条**(P5-1:一个插件渲染抛错只降级该贡献):同槽里坏插件显示占位(含插件名与错误消息)而幸存插件照常渲染、邻槽不受影响;空槽渲染为空;卸载贡献后内容即消失;出错插件被关掉后占位随贡献一起消失。**命令服务单测 10 条**:`parseShortcut` 规范形式与大小写归一、修饰键别名(control/cmd/win/super)、拒绝无修饰键/多主键/非法键;`register` 拒绝空 id/title、重复 id、畸形快捷键与已被占用的快捷键(大小写不敏感);命令面板认领唯一、释放后旧 launcher 失效(commands 空/run false/executing 与 lastError 归零)且他人可再认领;执行中再触发被拒并带"还在执行"提示;错误捕获(Error 前缀剥离、纯字符串原样);`releasePlugin` 清命令/清认领/执行中卸载不卡繁忙标记;全局 keydown 分发:文本框内无修饰键组合不触发、Ctrl 和弦在文本框内也生效、非输入目标上无修饰键组合生效。act 告警归零的一个细节:`act` 从 `@testing-library/react` 导入(裸 `react` 的 act 在未声明 `IS_REACT_ACT_ENVIRONMENT` 时会告警)。**同轮门禁**:`pnpm --filter shell-ui test` 14/14、SDK `node --test` 15/15、根 `pnpm test` 聚合(`pnpm -r test`)通过、`biome check .` 116 文件零诊断(测试与配置天然入 lint)、shell-ui `tsc --noEmit` 通过。

**取证(P6-35/36/37 · CI + 供应链审计 + 提交钩子)**:`ci.yml` 四 job。平台分工即事实:Rust 门禁跑 `windows-latest`(应用是 Windows-only,COM/Shell/注册表都在 `cfg(windows)` 里,与本地取证平台一致),web 与 deny 跑 `ubuntu-latest`。**web**:`pnpm install --frozen-lockfile` → `pnpm audit --audit-level=high` → `pnpm lint` → `pnpm format:check` → `pnpm -r typecheck` → `pnpm test` → `build:shared`/`build:plugins`/`build:shell`。**rust**:`dtolnay/rust-toolchain`(rustfmt+clippy)→ `Swatinem/rust-cache` → `cargo fmt --check` → `cargo clippy --workspace --all-targets -- -D warnings` → `cargo test --workspace` → `node apps/shell-ui/scripts/contract-check.mjs`(脚本内部 `cargo run -p fm-contracts` 取 Rust 侧真值)。**deny**:`EmbarkStudios/cargo-deny-action`。**release**:标签 `v*` 触发,`tauri-action` 以 `projectPath: apps/host` 出 NSIS 草稿版;当前无签名密钥(出未签名包),签名/更新器到时再加 secrets,不动步骤骨架。**GH Actions 本环境跑不了**:取证方式是每个 job 的步骤在本地逐条复跑(数值见文末同轮门禁),release job 只能等推送标签后首次验证——不冒认。**cargo-deny 首跑处置**(本地装 0.20.2):① 许可 5 处 MPL-2.0(cssparser/cssparser-macros/dtoa-short/option-ext/selectors,tauri CSS 栈的传递依赖)→ 加白并注明"文件级 copyleft,作依赖使用无碍";同时裁掉未命中的 ISC/BSL-1.0/Unicode-DFS-2016 三行,让白名单每一行都对得上真实依赖。② wildcard 3 处——内部 crate 的无版本 path 依赖;`allow-wildcard-paths = true` 只对非发布 crate 生效,于是给 fm-contracts/fm-kernel/fm-host/plugin-file-history-backend 补 `publish = false`(spike 早有;内部 crate 本来就不该发布)。③ RUSTSEC-2024-0384:`instant` unmaintained(非漏洞),传递自 notify 7 → notify-types → instant,在非 wasm 目标上只是 `std::time` 透传——ignore 并在 `deny.toml` 写明理由;清除它要升 notify 8,会改文件监视运行时行为,归专门批次、不在本批顺手动。复跑 advisories/bans/licenses/sources 四类全绿。**lefthook**:v2.2.1、`jobs` 格式;pnpm 11 默认拦依赖构建脚本,lefthook 装钩子的 postinstall 需在 `pnpm-workspace.yaml` 以 `allowBuilds.lefthook: true` 放行;根 `package.json` 补 `prepare: lefthook install`(新克隆装依赖即装钩子)与 `packageManager: pnpm@11.6.0`(CI 的 `pnpm/action-setup` 据此选版本)。实测:暂存一个 TS 文件 + 一个 RS 文件后 `lefthook run pre-commit` → biome 1.30s ✔️ / rustfmt 0.68s ✔️ / typecheck 16.85s ✔️,索引随后还原。**同轮门禁**:`cargo deny check` 四类全绿、`cargo fmt --check` 零 diff、clippy 强制重检 5 个 crate 全 0、`cargo test --workspace` 117 测、`pnpm lint` 116 文件零诊断、`pnpm format:check` 全绿、`pnpm test` 29 测(SDK 15 + shell-ui 14)、`build:shared`/`build:shell`/`build:plugins`(19 插件)全过、lefthook pre-commit 三 job 绿。唯一本机跑不了的:GH Actions 本体与 `pnpm audit`(npmmirror 源没有 audit 端点)——前者等推送、后者在 CI 默认 npm 源上生效。

### 6D · cordis 运行时补全(已声明未用的依赖在此转正)

| # | 任务 | 采用库 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-41 | 声明式加载计划 / 注册表生成 | `cordis-loader`(当前在 workspace 声明但**无引用**) | 落地 roadmap P3-5:扫描 manifest 自动生成后端加载计划,消手写 `registry` 漂移;启用后即从"死声明"转为在用 | 🔵 |
| P6-42 | fiber 作用域定时 | `cordis-timer`(当前在 workspace 声明但**无引用**) | 用于 watch debounce / 定期清理 / 进度节流等需要 fiber 生命周期定时器的场景;启用后进代码 | 🔵 |

### 6E · 界面框架与布局(01 §9 / 02 §4.5 / 08 §5.1)

> 务实边界:**外层网格 + 元状态总线留在基座**,只把多变部分插件化;提供嵌套槽的是三个界面框架容器(分栏 / 视图互斥 / 详情)加设置悬浮面板容器 `plugin-settings`。区域与级联状态定义见 01 §9,嵌套槽机制见 02 §4.5,插件清单见 08 §5.1。

| # | 任务 | 落位 | 完成条件 | 状态 | 证据 |
|---|---|---|---|---|---|
| P6-43 | 外层区域网格 + 顶部会话容器 | 基座 `shell-ui`(App.tsx) | 渲染 A/B/C/D + 工具栏 + 状态栏六区;顶部多标签会话,每会话持一份级联快照;面板可折叠、宽度记忆 | ✅ | `vite dev` 实测(`.scratch/6e-shell-regions.png`):六区齐备(A 活动栏 / B 侧栏 / C 工具栏+主视图 / D 详情 / 顶部会话条 / 底部状态栏);新建会话 2 切到 `/demo` 后会话 1 仍为 `/demo/src`(按 `tabId` 隔离目录视图与级联快照);`◧侧栏`/`详情◨` 收起后重载仍记忆(`fm.shell.layout.v1`,含拖拽宽度);关闭活动会话自动激活相邻会话并还原其快照,最后一个标签不可关 |
| P6-44 | 级联元状态 + 协调事件 | 基座 `state.ts`/`eventbus.ts` + SDK | `HostMetaState` 扩为 `{activeTabId,activeSidebarView,sidebarSelection,focusRef,activeDetailTab}`(不透明 `Ref`);发 `tab:activated`/`sidebar:view:changed`/`sidebar:selection:changed`/`focus:changed`/`detail:tab:changed` | ✅ | SDK 新增 `Ref`/`HostMetaState` + 5 个事件名,Rust `HostMetaState` 镜像随 `cargo test -p fm-contracts` 通过;`initCascadeBus()` 把 5 事件接成唯一写入路径(基座 UI 也只用 `publish*`/`activateTab`,不改 store);`pnpm contract:check` = contract OK(9 个前端专有事件列入豁免)。浏览器实测:点选文件 → `focus:changed` 驱动 D 面板、状态栏计数、调试台事件行 |
| P6-45 | 嵌套槽运行时 | 基座 `slots.ts` + SDK `PluginHost` | `provideSlot`/`contributeToSlot`;`slot:registered/reconfigured/disposed` 生命周期;manifest `provides`/`permissions.slots.contribute` gating | ✅ | 每个注册项携带**自己的 gated host**(修掉插件组件拿到未授权基座 host 的越权路径);`provide`/`unprovide` 随 React 挂载/卸载发 `slot:registered`/`slot:disposed`。dev 专用 `plugin-dev-slot-harness` 实测:两个 `dev-pane:<n>` outlet 正常渲染并被级联 `focusRef` 驱动;越权注入 `file-sidebar-zone` 与 `provideSlot("forbidden-prefix:0")` 均被拒并在调试台出现 `[host:plugin-dev-slot-harness] … denied (not in manifest permissions)` |
| P6-46 | `plugin-layout-panes`(C 分栏容器) | 前端插件 | 提供 `pane-slot:<n>`;切 1/左右2/2×2 栏;**稳定 paneId + 按 id 迁移子树**不丢每栏局部状态;分隔条可调 | ✅ | `vite dev` 实测:`mode=4` 时 `localStorage fm.layout-panes.v1` 为 `{"mode":4,"ids":["p0","p1","p2","p3"],"seq":4}`,DOM grid-area 为 `a1/a2/a3/a4` + 2 竖 1 横分隔条;四栏各自路径互不干扰(`/demo/src`、`/demo/src`、`/demo`、`/demo`);4→1→4 后 p1 仍停在 `/demo/src`(单一 keyed 数组 + 隐藏不卸载);拖拽分隔条 `colPct 50→57.09`;`closePane` → `{"mode":2,"ids":["p0","p1","p2"]}` 且只剩 3 个 `<section>`。**按需挂载**:切模式才新增 outlet 并发 `slot:reconfigured{action:'add'}`,容器只管几何 |
| P6-47 | `plugin-inspector`(D 详情容器) | 前端插件 | 占用 `file-sidebar-zone`,提供 `detail-tab:*`/`preview-zone`/`detail-info-zone`/`file-extension-zone`;tab 条 + 焦点 kind 模板(程序/文件夹/标签/文件) | ✅ | `vite dev` 实测:文件焦点下 tab 条 = `信息` + `contributedSlots("detail-tab")` 扫到的 `历史`(标题取贡献者 manifest `label`,见 P6-60),点历史发 `detail:tab:changed` 并只切换显隐(挂载不卸载,切回时状态保留);空槽渲染中文占位(`插件预留：暂无插件注入` 等);folder 焦点走 `file-extension-zone`+`detail-info-zone` 模板(不预览);焦点标题条显示 名称/整路径/类型徽标 |
| P6-48 | 侧栏视图插件化(A+B) | 前端插件 `view-file-tree`/`view-favorites`/`view-tags` | 各贡献 `activity-rail-zone` 图标 + `nav-panel:<viewId>` 面板;A 切换 → B 内容随之换;选中标项 → `sidebar:selection:changed` 驱动 C | ✅ | `vite dev` 实测:A 栏 `目录树/收藏/标签/压力列表` 四图标,同一时刻 B 只有一个可见面板(`H:目录树 \| V:收藏 \| H:标签 \| H:压力列表`),互斥由容器 `plugin-layout-views` 保证而非面板 self-hide;树为 react-arborist 懒加载:未开目录带 `children:[]` 才出箭头,展开才 `fs.list`,空目录显示 `(空目录)`,读失败显示 `(载入失败，重新展开重试)` 且重新展开会重试,文件行 `aria-expanded=false`;切 A 视图往返后 9 个已展开目录仍展开 |
| P6-54 | `plugin-layout-views`(B 互斥容器) | 前端插件 | 占 `nav-zone`,按 `meta.activeSidebarView` 从 `nav-panel:<viewId>` 出口里选一个显示,其余隐藏;**互斥是容器职责**,视图插件不写 self-hide 判断 | ✅ | `plugin-layout-views` 渲染全部已挂载出口并以 `display:none` 隐藏非活动项,活动视图缺失时回落首个面板,`onSlotsChange` 驱动重渲染;三个 `view-*` 插件源码内已无 `if (view !== …) return null` 分支;证据见 P6-48 的可见面板断言 |
| P6-55 | 主浏览能力外置 `plugin-file-browser` | 前端插件 | 基座不含浏览逻辑;`activate` 扫 `providedSlots("pane-slot")` + 订 `slot:registered/disposed`,每栏注入一个独立实例(各自路径/选择/地址栏) | ✅ | `vite dev` 实测:2×2 四栏各有一个独立浏览器实例(地址栏 4 个,路径见 P6-46);后创建的 `pane-slot:p2/p3` 无需重载即被自动注入;基座 `App.tsx` 零业务状态(无地址栏/目录列表/条目计数),`state.ts` 只有 `activateTab` + `initCascadeBus` 两条写入路径;每栏路径按会话记忆在 `fm.file-browser.v1`(`会话\|槽id` 为键),切会话不互串 |
| P6-56 | 基座 Mantine 外壳 + 亮色默认 | 基座 `shell-ui`(`App.tsx`/`main.tsx`) | 外壳控件使用 Mantine；Mantine 主题集中定义色彩、字体、圆角、阴影、焦点与常用组件样式；默认亮色 | ✅ | 暗色由 Mantine scheme 变量驱动；主题定义集中于 `apps/shell-ui/src/theme.ts` |
| P6-57 | `plugin-settings`(A 齿轮 + 设置悬浮面板) | 前端插件 | 主题三选(跟随系统/亮色/暗色)仅在设置页呈现；调用共享 Mantine 配色状态 | ✅ | 设置页即时应用并持久化；顶部不重复放置主题控件 |
| P6-58 | 文本预览进 D(`plugin-preview`) | 前端插件 | 随级联 `focusRef` 经 gated `fs.readText` 读文本,填 inspector 的 `preview-zone`;超长截断(默认 20 万字符) | ✅ | 实测(批次 6 取证,截图 63..85):焦点 `.txt`/`.rs`/`.md` 在 D 的 `preview-zone` 经 gated `fs.readText` 出正文,并带真实编码行 `编码 UTF-8 · 3.4 KiB`;字符上限调小后截断可观察(截图 85) |
| P6-59 | `plugin-file-browser` 增强:每栏历史导航 + 列表/网格 + 统一虚拟滚动 | 前端插件 | 每栏独立历史栈(后退/前进/上级/刷新)、列表或网格按 `会话\|槽id` 持久化、文件夹/文件分组带整路径、类型图标与大小;`@tanstack/react-virtual` 单条流 | ✅ | 实测:`/demo/src →「上级目录」→ /demo →「后退」→ /demo/src`,前进由 `disabled` 转可用;`fm.file-browser.v1 = {"tab-1\|pane-slot:p0":{"cwd":"/demo/src","mode":"grid"},…}`(每栏独立);网格卡片 `lib.rs / RS / 900 B`;分组条底色改取 `var(--mantine-color-body)`,暗色下实测 `rgb(36,36,36)`(原先写死 `gray-0` 会在暗色留白条);插件 vite 配置加 `define: process.env.NODE_ENV`(react-virtual 读它,同 react-arborist 坑) |
| P6-60 | 界面文案中文化 + 槽标签发现面 | SDK/契约 + `plugin-inspector` + 基座 | manifest `frontend.slots[].label`(可选,空白拒) → 注册项携带 → `host.slotLabel(slotId)`;容器用贡献者自己的名字题 tab,D 焦点标题条/区域占位/分栏头全中文,槽 id 只留在 `title` 悬停提示 | ✅ | `cargo test -p fm-contracts`(`label` 往返 `"版本"`、缺省序列化为 Null、空白拒绝)+ SDK `node --test` 10 项(含 label 可选元数据);浏览器实测:D tab 可见文本 `信息`/`历史`(且移除会覆盖可访问名的英文 `aria-label`)、分栏头显示 `栏 1`(悬停 `pane-slot:p0`)、折叠按钮 `折叠侧栏`/`折叠详情`、状态栏 `会话 1 · 文件 /demo/src/main.rs` |
| P6-61 | 契约:`ListEntry.modifiedMs` + `thumb.image`/`ThumbOut` | `fm-contracts` + `plugin-sdk` + `fm-contract-dump` | 列表条目自带 mtime(目录为 null)以免浏览器逐行 `fs.stat`;新增缩略图能力与 DTO,serde 字段 camelCase | ✅ | `cargo test -p fm-contracts` 断言序列化字段集(按字母序)`["isDir","modifiedMs","name","path","size"]`/`["dataUrl","edge","mime"]` + 目录 `modifiedMs` 为 Null 往返;`pnpm -C apps/shell-ui contract:check` → `dto fields ListEntry`/`ThumbOut` 与 TS SDK 一致;SDK `node --test` 11 项 |
| P6-62 | 真实感压力数据集 + 缩略图消费链 | `dev-mocks.ts` + `plugin-file-browser` + `plugin-layout-panes` | ~48 种格式各带真实体积区间/文本或二进制标记/是否出图,`/stress/数据集-{1千,1万,10万,50万}` + `空目录` + `读取失败`;网格卡片按可见性懒取 `thumb.image` + LRU + 负缓存 | ✅ | 实测:10 万条目头部 `9566 目录 · 90434 文件 · 295ms`、50 万 `47769 目录 · 452231 文件 · 472ms`;50 万时列表常驻 214 节点/网格 514 节点(内容高 13,000,048 / 22,369,618px),滚动 1400px/帧 p50 ≈ 26ms;图片卡片显示 `data:image/png` 真缩略图(96×72 原图 → 卡片框 207×62);二进制文件在 D 显示中文 `无法以文本读取 .m4a(二进制格式)`,`读取失败` 目录显示 `—模拟读取失败`(SDK 新增 `errorMessage` 去掉 `Error:` 前缀),`空目录` 显示中文 `空目录` |
| P6-63 | 分栏高度不变量(容器 owner 强制) | `plugin-layout-panes` | 栅格行轨 `minmax(0,1fr)`;栏 `display:flex`+`flex-direction:column`+`min-height:0`;outlet `flex:1`+`overflow:hidden`(滚动归内容插件) | ✅ | 修前:栏 `<section>` 计算样式是 `display:block`(`display: hidden ? "none" : undefined` 被 React 当成"删除该属性"),`flex:1` 失效 → outlet 长到 260,110px → 1 万条目录**挂载 10,002 行**(无窗口化)且被 `overflow:hidden` 静默裁掉;修后实测 `paneDisplay=flex`、outlet 725px、scroller 视口 663px,挂载节点回到数百 |
| P6-64 | 设置改为独立插件的**悬浮面板**(分页 + 启停) | `plugin-settings` + 基座 `loader`/`invoke` + SDK | 齿轮打开 Mantine `Popover` 悬浮面板(不占六区、不再是 B 视图),**面板尺寸固定**、正文各自滚动;面板分页 **软件设置 / 插件设置**;软件设置含主题与**插件启停列表**;各插件的设置页经 `settings-page:<name>` 嵌套槽进入"插件设置";关闭/开启对当前界面即时生效并持久化 | ✅ | `vite dev` @1420 实测:点齿轮 → `aria-expanded=true`、`.mantine-Popover-dropdown` 矩形 `620×560` 且**完全落在视口内**(x=55, y=577);**切换分页/子页外形与位置完全不变**(软件设置 → 插件设置 → 文本预览 → 回软件设置,四次读数都是 `620×560 @55,577`),正文滚动容器 client 477 / scroll 842 → 溢出只出内部滚动条,且滚动位置切回仍在(top 300 → 300);面板 `[role=tab]` = `软件设置`/`插件设置`(子页 `文件浏览`/`文本预览`);**14 行插件**,其中 4 行 `disabled` + `基础插件` 徽标(三容器 + 设置本身);关「文件浏览」→ C 四栏立即无地址栏/条目(`main` 只剩栏头),开回 → 4 个地址栏恢复;关「标签视图」→ A 栏 `标签` 图标消失且 `fm.plugins.disabled.v1=["plugin-view-tags"]`,**重载后仍关闭**(rail 无该图标、列表该行 `checked=false`),开回后图标回归、存储清空;ESC 关闭生效(受控 `opened` + `onChange`);全程控制台 0 错误、14 插件加载日志齐 |
| P6-65 | 插件设置页机制 + 两个样例 | `plugin-settings` 提供 `settings-page`,file-browser / preview 各贡献一页 | 每页内容由贡献插件自持,写自己的 localStorage 偏好键,并经**同插件内的模块级 store**(`useSyncExternalStore`)广播 → 已渲染实例即时跟随;值域在读/写两侧 clamp | ✅ | 实测:`fm.file-browser.prefs.v1={"defaultMode":"grid","thumbnails":true}` — 改「新建栏位的显示方式」为网格 → **四栏全部转网格**(选过模式的栏仍保留自己的选择);关「显示网格缩略图」→ `/stress/数据集-1千` 滚动位置上的 `<img>` 由 7 → **0**,再开 → 7(不重载、不重挂栏);`fm.preview.prefs.v1` — 设置页只有「文本显示字符上限」与「默认适配方式」两条中文控件,上限读写两侧夹在 1 千 ~ 2,000,000、改值即落盘;截断效果实测(截图 85:全文 3.4 KiB、上限 1000 时查看器只吃到截断后的前缀) |
| P6-66 | Windows 系统缩略图能力 | Windows Shell `IThumbnailCache::GetThumbnail` + 系统 handlers | 受权限 gate 的 `shell.thumbnail.read`；`cacheOnly`/`extract` 两种策略；替换 `thumb.image` 图像解码生成和 stress canvas mock；消费者无图时回退类型图标；非 Windows 明确 unsupported | ✅ 能力与消费侧(批次 4)；真实 Shell 缓存出图 🟡。独立开关页插件 `plugin-windows-thumbnails` 仍未落 |
| P6-67 | 本地预览安全数据通道 | Tauri host capability + Open File Viewer 输入适配 | 只读、路径绑定、短时有效的预览句柄与 range/chunk 读取，支持取消/撤销；禁止裸 `file:`/asset 路径和大文件全量 base64；完成离线与敏感文件验证 | ✅(随 P7-20 交付) |
| P6-68 | 统一预览迁移与格式验收 | `plugin-preview` + Open File Viewer | 右侧预览区提供“缩略图 / 文件预览”切换；每个新焦点默认只显示系统缩略图，不初始化 viewer、不读正文；用户点击后才分派文本/图片/PDF/音视频/Office/压缩包；切回或换焦点取消读取并释放资源；不再有独立 Markdown/图片/PDF/媒体预览插件与 `media.thumb` 路线 | ✅（P7-20~22 交付；见批次 6 取证） |
| P6-69 | Lore 文件历史集成可行性与版本锁定 | Lore / LoreGUI 的 `lore-vm` 核心 | 验证 Windows 构建、Rust API/许可、仓库格式、服务端依赖与当前单进程宿主兼容性；固定上游 revision；确定由宿主管理的本地服务生命周期和数据目录 | ✅(=P7-25 决策门,结论**暂缓**:见 05 D21) |
| P6-70 | 文件历史版本操作迁移到 Lore | `plugin-file-history` + `lore.*` host capabilities | 仓库显式初始化/连接；查询文件历史、工作区 dirty 状态、指定版本内容与差异；显式创建版本；恢复前检查未提交改动并确认；恢复结果形成可追踪的新变化；旧 `db.history.*` 只读兼容。版本行显示委托给 P6-71 | ⏸ 不排期(P6-69 暂缓;=P7-26) |
| P6-71 | 历史版本展示信息插件 | `plugin-history-metadata` + `history-record:metadata` 子槽 | 订阅 Lore revision 创建生命周期（含连接同一 Lore 服务的 LoreGUI 创建通知），在版本边界采集并保存系统缩略图、文件大小/类型、图片尺寸和采集状态；独占 `db.historyMetadata.*` 与缩略图 blob；历史行按 revision 查询展示；点击切换只发请求，由 P6-70 的 Lore 适配层确认并执行；插件不得调用 Lore commit/restore | ⏸ 不排期(P6-69 暂缓;=P7-27) |
| P6-72 | 右键菜单框架插件 | `plugin-context-menu` + PluginHost `contextMenu` API | 应用内 Mantine 覆盖面板；统一打开上下文、锚点定位、过滤/分组/键盘操作和插件注册生命周期；定义 `ContextMenuContext` 与插件卸载/ACL 规则；框架不实现具体业务动作 | ✅(批次 3 交付:`.scratch/pw/run.mjs` 43/43 含面板定位/键盘/夹紧/禁用清理断言) |
| P6-73 | 右键功能插件接入 | `plugin-file-ops`、`plugin-file-history`、favorites/tags、file-browser | 各插件用框架 API 自动注册自有菜单项；按文件/目录/空白区/历史版本等上下文筛选；handler 仍由贡献插件调用自身能力；验证禁用/卸载和权限撤销后清理 | ✅(批次 3/5 交付:条目 surface 六动作由 file-ops、空白区三动作由 browser、收藏/标签面板各自动作由对应插件；见 04 批次 3/5 取证) |

> 6E 基座/SDK 落地清单:`App.tsx` 六区网格 + `SessionTabs`/`Toolbar`/`PanelResizer` + `ThemeSwitch` + `useShellLayout` 持久化;`main.tsx` 的 `MantineProvider defaultColorScheme="light"`;`state.ts` 每会话级联快照 + 总线单写;`slots.ts`/`PluginSlot.tsx` 为 provide/contribute 运行时(出口挂载/卸载即 `slot:registered`/`slot:disposed`),注册项携带 `label`;`host.ts` 加 `provides`/`slots.contribute` gating 与 `slotLabel`;`loader.ts` 声明槽走 `contributeToSlot`,卸载时 `releasePlugin`;SDK `matchesPermission`/`slotPrefix`/`Events` + `BaseSlots`,并新增**只寻址不解释**的发现面 `host.name`、`contributedSlots(prefix?)`、`providedSlots(prefix?)`(当前已挂载出口)、`onSlotsChange(cb)`、`slotLabel(slotId)`;`contracts`(Rust)镜像 `frontend.provides`、`permissions.slots` 与 `frontend.slots[].label`。容器侧:`slot:reconfigured{action:'add'|'remove'}` 由**容器**按意图发,框架层负责 registered/disposed。


### 6F · 开发期演示与调试插件(2026-10-08 交付)

> 目的:用**基座外层槽**(topbar/nav/file-sidebar/bottom-drawer)跑通"参考界面的基础信息展示 + 大数据渲染性能观察 + 运行时错误/性能捕获",便于开发期肉眼查看各区样式与调试。这些是开发/演示用途插件,**非发布形态**;正式的分栏/详情容器以 P6-46/47/48 为准。仅出现在浏览器 dev 的 `plugins_list_frontend` 模拟索引中(`dev-mocks.ts`),发布/Tauri 下不装载。6E 容器交付后,这些插件的挂载点已改为容器提供的嵌套槽(见各行落位与下方收尾说明)。

| # | 任务 | 落位 | 采用库/能力 | 完成条件 | 状态 | 证据 |
|---|---|---|---|---|---|---|
| P6-49 | 基础信息插件:文件详情属性 / 校验 | 前端插件 `plugin-file-details` → `detail-info-zone`(D 容器内) | `fs.stat`、`hash.compute`、`fs.home`、`fs.readText` | 选中项经 gated 能力展示 名称/路径/大小/类型/修改时间/BLAKE3;随 `selection:changed` 刷新、无轮询 | ✅ | `vite dev` 实测:焦点 `/demo/src/lib.rs` → 信息 tab 内 `文件详情` 表格显示 大小/类型/修改时间/`mockhash-…-blake3`;同 tab 的 `file-extension-zone` 无注入时显示 `插件预留：暂无插件注入` |
| P6-50 | 快捷导航 + 位置显示(并入 P6-55) | `plugin-view-favorites`(主页/常用位置) + `plugin-file-browser`(每栏地址栏与分组整路径) | `fs.home`、`fs.list` | 独立的 `plugin-file-nav` 不存在:主页与收藏位置归 B 的 `nav-panel:favorites`,当前位置与路径跟随归 C 的每栏浏览器实例 | ✅ | `vite dev` 实测:B「收藏」面板含 `⌂ 主页` + 收藏条目,并可「＋ 焦点」把当前 `focusRef` 加入收藏;每栏顶部是**独立地址栏**(Mantine `TextInput`,`aria-label="当前目录地址"` + 后退/前进/上级目录/刷新 `ActionIcon`),分组条右侧显示该分组所在整路径(如 `/demo/src`) |
| P6-51 | 模拟数据 / 压力测试插件 | 前端插件 `plugin-mock-data` → `activity-rail-zone`/`nav-panel:stress`(B 区视图) | `fs.list`(只读数据集目录) | 插件只做**入口**:列出 `/stress` 下的数据集目录,点击即以不透明引用发 `sidebar:selection:changed`,由 C 区**真实网格**加载;窗口化与计时都在 `plugin-file-browser` 内,dev 侧只有 `/stress` 数据集走标准能力(无自定义 dev 能力) | ✅ | `vite dev` 实测:B「模拟数据」列 `数据集-1千/-1万/-10万/-50万/空目录/读取失败`,点某目录只驱动**当前活动栏**(mousedown 抢栏后点击 → 只有该栏换目录),另一栏保持原路径可左右对比量级 |
| P6-52 | 性能 / 错误日志捕获插件 | 前端插件 `plugin-devtools-log` → 基座 `bottom-drawer` 外层槽 | 原生 `console` 包裹 / `window` 错误 / `unhandledrejection` / `PerformanceObserver(longtask)` | 捕获运行数据入环形缓冲(上限 5000);面板按级别筛选、搜索、新旧序切换、清空、导出 JSON;**在 dev 索引里最先装载**以捕获他插件 console/错误 | ✅ | `vite dev` 实测:捕获整条级联流量(`event:sidebar:view:changed`/`event:focus:changed`/`event:detail:tab:changed`)与 `event:slot:registered`/`slot:reconfigured`/`slot:disposed`;故意排除 React dev 的海量 `measure` 以免淹没缓冲 |
| P6-53 | 嵌套槽验证夹具 | 前端插件(dev) `plugin-dev-slot-harness` → `bottom-drawer` + 自带 `dev-pane:<n>` | `frontend.provides: ["dev-pane"]`、`permissions.slots.contribute: ["bottom-drawer","dev-pane:*"]` | 为 P6-45 提供真实浏览器夹具:注册 `dev-pane` 前缀、渲染两个 `<SlotOutlet>`、卡片随级联 `focusRef` 更新,并**故意**越权注入 `file-sidebar-zone` 与 `provideSlot("forbidden-prefix:0")` 以取证两条 gating 拒绝路径 | ✅ | `vite dev` 实测:`dev-pane:0/1` 渲染并被焦点驱动;调试台只有两条 `… denied (not in manifest permissions)` 告警,控制台 0 错误。**夹具的两个 outlet 是自身演示行为**,不代表 `pane-slot` 的预挂载策略 |

> 6F → 容器化挂载点收尾(2026-10-08):`plugin-file-details` 注入 `detail-info-zone`、`plugin-file-history` 注入 `detail-tab:history`、`plugin-mock-data` 是 B 区视图 `nav-panel:stress` 的压力数据集入口(点击 → `sidebar:selection:changed` → C 真实网格)、`plugin-file-nav` 按上述并入 P6-50/P6-55;取焦点源统一读 `meta.focusRef`(必要时兼容 `selection:changed`);`devtools-log` 订阅覆盖级联 5 事件 + `slot:registered/reconfigured/disposed`。`plugin-dev-slot-harness` 保持原样,仅作 gating 反例夹具。


> 6F 配套基座改动:`App.tsx` 提供 `bottom-drawer` 外层槽 + 可折叠抽屉;`dev-mocks.ts` 含 `/stress` 真实感压力数据集(见 P6-62)与 14 条目开发索引(devtools-log 置首、settings 次末、slot-harness 置末,容器插件须早于其内容插件);`vite.config.ts` 的 dev 插件服务带 `Cache-Control: no-store`,使重建后的插件 JS 重载即生效(修掉一次"缓存旧模块导致渲染死循环"的排查坑)。

---

## Phase 7 · 插件功能实现排期（按开发难度从易到难）

> 目的:把 [09 §8](09-plugin-functional-spec.md) 的"目标行为"和 [`docs/plugin-functional/`](plugin-functional/README.md) 的逐插件缺口,排成**一条可顺序执行、每批都能独立验收**的开发路线。难度序 = 剩余功能缺口 × 是否需要新契约(Rust DTO / PluginHost API) × 是否触碰外部系统(COM / Windows Shell / Lore) × 并发与资源回收复杂度。
>
> 排期原则:①**纯前端补漏先行**,不引入契约变更就能收口的先做;②**契约冻结是闸门**,每个需要新能力名/新 SDK API 的批次,先冻结契约再接功能;③**外部系统依赖殿后**,Windows COM、Lore、索引引擎风险最高,放在基座与前端已稳定之后;④每批收尾都要过 `contract:check` + `pnpm -r typecheck` + `vite dev` 浏览器实测取证(无显示器环境需 GUI 的项标 🟡)。

### 难度图例

| 标记 | 含义 | 典型特征 |
|---|---|---|
| ⭐ | 收口 | 单插件内改动,无新契约,无 I/O 新增 |
| ⭐⭐ | 小缺口 | 需 1 个新能力名或补状态机分支 |
| ⭐⭐⭐ | 主体功能 | 跨插件行为/持久化分区/虚拟化与并发正确性 |
| ⭐⭐⭐⭐ | 新契约 + 外部系统 | 新增 SDK API 或 Windows COM,STA 线程模型,契约须先冻结 |
| ⭐⭐⭐⭐⭐ | 未定方案 + 外部依赖 | 选型未决(⚪)或依赖仓库外组件,存在整链无法开工的风险 |

### 代码现状核对（2026-10-09，读源码所得，用于校准工作量）

已实现、**不需要重做**的部分:`plugin-layout-panes` 的分隔条拖动(`colPct` clamp)+ 按 `activeTabId` 分区持久化 + 稳定 paneId 隐藏不卸载 + `slot:reconfigured` 收发;`plugin-view-file-tree` 的 react-arborist 虚拟化懒加载与失败重新展开重试;`plugin-file-browser` 的每栏独立历史栈(后退/前进/上级/刷新)、列表/网格单条虚拟流、缩略图 LRU + 负缓存;`plugin-inspector` 的 file/folder/未知 kind 模板与贡献 tab 发现;`plugin-file-details` 的目录不哈希、字段独立加载。

核对确认的**真实缺口**（余下批次的依据；已交付批次的缺口随交付移出本表）：

| 位置 | 缺口 |
|---|---|
| `plugin-file-history`(前后端) | 前端仍 `db.history.list`,后端**零 Lore 代码**;workspace 依赖**无 lore crate**(P7-25 决策门) |
| 已注册插件目录 | `plugin-history-metadata`、`plugin-windows-thumbnails` 仍无目录与 manifest |

### 批次 1 · 现有插件纯前端补漏（无契约变更）

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-1 | `plugin-view-favorites` 失效与去重 | ⭐ | 收藏路径不存在时保留记录并标不可用,提供移除入口;同一路径重复收藏更新名称/类型而不新增第二条;存储无法解析时空态 + 中文恢复提示;写入原子化 | ✅ |
| P7-2 | `plugin-view-tags` 重命名与校验 | ⭐ | 重命名保持成员与展开选择一致;名 trim 非空、大小写不敏感去重;同一 `{kind,path}` 在单标签内唯一;删除标签需确认且不删文件 | ✅ |
| P7-3 | `plugin-layout-views` 空态与回退 | ⭐ | 无任何 `nav-panel:*` 贡献时显示中文空侧栏说明;活动视图插件被停用后选有效回退项而非留残留;非活动视图保持挂载不丢局部展开 | ✅ |
| P7-4 | `plugin-settings` 启停 busy 与回滚 | ⭐⭐ | 开关请求期间该行 disabled + loading;失败恢复原值并给原因;核心四插件锁定不可点(不得出现可点但实际关不掉的误导界面) | ✅ |
| P7-5 | `plugin-file-details` 状态与复制路径 | ⭐⭐ | 新增并 gating `clipboard.write` 能力(小契约,Rust↔TS DTO 同步);复制成功轻提示、失败保留可选文本;`modifiedMs` 为 null/坏值不显示 NaN 日期;null 焦点与未知 kind 走通用模板 | ✅ |
| P7-6 | `plugin-inspector` 回退与局部滚动 | ⭐⭐ | 贡献的 tab 被移除时活动 tab 回"信息"或首个有效项;窄栏下内容滚动而标题/tab 不随滚;子贡献失败只影响自身槽 | ✅ |

**取证**:`.scratch/pw/run.mjs` 39/39 + `run-b.mjs` 15/15(headless dev @1420,截图 `.artifacts/shots/06..25`)。要点:失效收藏行标「路径已失效」且点击只给中文提示不改焦点;损坏存储转中文空态并提供清除入口;哈希行独立加载态(「计算中…」→结果,切焦点不回填);文件夹不哈希;复制路径写入系统剪贴板并有中文内联反馈。本批另修出两处真实缺陷并结构性收口:右键菜单自关闭(见 P7-11),以及 `PluginSlot` 用索引做 React key 导致"关另一个插件时设置面板被重挂载丢失状态"——改为注册表分配单调 `seq` 作 key,基座 owner 强制,不靠插件自查。

### 批次 2 · `plugin-file-browser` 正确性收口

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-7 | 请求序号与过期响应 | ⭐⭐⭐ | 每次 `fs.list` 附本地 seq,仅 path/session/pane 全匹配时接纳;卸载与切目录丢弃迟到结果;快速切换不闪回旧数据;焦点目标离开当前目录时发 `null` | ✅ |
| P7-8 | 错误分类与导航栈策略 | ⭐⭐⭐ | 无权限 / 目录消失 / 路径无效 / 读取失败 各给不同中文原因 + 重试;refresh 替换当前历史项不增栈;地址栏 Enter 提交、Escape 还原;重复选当前路径视为显式刷新不建重复栈项 | ✅ |
| P7-9 | 侧栏 Ref 消费规则 | ⭐⭐ | 明确并实现认识的 `kind` 集合(目录/文件),`kind:"tag"` 在未定义 tags 查询契约前给可见的"暂不支持"反馈而非静默忽略 | ✅ |

**取证**:`run.mjs` 断言「快速连续导航：旧响应不覆盖新结果」「无权限目录显示权限专属原因」「非法路径显示参数错误原因」「空目录是独立空态而非错误」「标签引用打开标签视图并列出成员」,错误面板同时提供 重试/返回上级/选择其他目录 三种恢复动作(截图 06..12)。分类依据是 Rust `CapabilityError` 的文案前缀(`permission denied:` / `not found:` / `invalid argument:`),前端只按前缀分派,不自造判断。

### 批次 3 · 右键菜单框架（先冻结 SDK API，再挂动作）

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-10 | `host.contextMenu` API 与契约冻结（=P6-72 前置） | ⭐⭐⭐⭐ | SDK 定 `open(context)` / `registerItem(descriptor)`、`ContextMenuContext{surfaceId,targetKind,targetRef,selectedRefs,sessionId,paneId?,pointer,trigger}`、manifest `contextMenu` 权限段;Rust manifest 镜像 + `contract:check`;重复 id/越权拒绝有测试 | ✅ |
| P7-11 | `plugin-context-menu` 框架实现 | ⭐⭐⭐⭐ | 应用内 Mantine 覆盖层;定位与边缘翻转/收缩、分组与 order、`when/enabled` 过滤、busy 态、ESC/方向键/Enter/Shift+F10、关闭焦点归还触发器、无可用项不弹空菜单;框架不调业务 capability、不持久化 | ✅ |
| P7-12 | 首批贡献者接入（=P6-73） | ⭐⭐⭐ | favorites(打开/定位、移除收藏、空白区"收藏当前焦点")、tags(重命名/删除标签、成员跳转/移除)、file-browser(以 `browser.list.item`/`browser.grid.item`/`browser.empty` 稳定 surface 打开面板,不自绘菜单,动作执行归 file-ops);插件禁用后动作即刻消失 | ✅ |

**取证**:`run.mjs`(菜单 14 项)+`run-b.mjs`(标签贡献 5 项)全绿,截图 13..22。已取证:ESC 关闭且焦点归还、Shift+F10 打开同一面板、小视口自动夹紧不出屏、条目 surface 无适用项时不弹空面板、右键命中已选项保留整个多选集合(命中未选项收敛为单项)、动作由贡献插件执行并落盘。服务面 `apps/shell-ui/src/contextmenu.ts` 为单一 provider:重复 item id 拒绝、`releasePlugin` 撤销在途、会话切换即关闭。本批修出的真实缺陷:菜单在打开的同一次事件里被自己的 outside-click 判定关闭——改为下一任务再挂监听(React 19 discrete event 下的结构性收口,基座 owner 承担)。

### 批次 4 · Windows 系统缩略图（替换应用侧生成）

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-13 | `shell.thumbnail.read` 契约冻结（=P6-66 前置） | ⭐⭐⭐⭐ | DTO 定 `path/edge/policy(仅缓存 \| 允许 Shell 提取)` 与返回 `dataUrl/mime/edge` + 明确的 `unsupported` 类别;非 Windows 返回 unsupported;进 `contracts`↔SDK 并 `contract:check` | ✅ |
| P7-14 | `IThumbnailCache` Rust provider | ⭐⭐⭐⭐ | `windows` crate 经 `IUnknown::cast` 取 `IThumbnailCache::GetThumbnail`;COM 调用固定在专用 STA 线程;不解析系统 cache 文件、不经应用生成;错误分类(未命中/不支持/权限) | ✅ |
| P7-15 | 消费侧迁移并移除 `thumb.image` | ⭐⭐⭐ | `plugin-file-browser` 网格与 `plugin-inspector` 预览区改走 `shell.thumbnail.read`;未命中/失败回退类型图标;偏好关闭后停止新请求并隐藏已有图;删除 `thumb.image`、`image` 解码路径与 stress 的 canvas 生成 mock;停用/切目录取消请求并释放图像资源 | ✅ |

**取证**:`cargo run -p fm-contracts --bin fm-contract-dump` → `node apps/shell-ui/scripts/contract-check.mjs` 输出 `contract OK`(9 项,新增枚举变体串校验:`ThumbnailPolicy` 的 `cacheOnly`/`extract`、`ThumbnailState` 的 9 个 kebab 变体)。消费侧 `.scratch/pw/run-c.mjs` 11/11(截图 26..28):12 次滚动后卡片拿到 `<img>`、图源全为 `data:image/png;base64,` 预置系统样例、界面 `canvas===0`(应用不再生成)、无 handler 格式(svg/heic/mkv)零图片而有类型图标、有 handler 格式(jpg/png/mp4)出图、偏好关闭后 0 张图且落盘 `{"defaultMode":"grid","thumbnails":false}`、重开恢复、控制台不再出现 `thumb.image`。`thumb.image` 与 workspace 的 `image` 解码依赖已删除,`plugin-file-browser` manifest 改声明 `shell.thumbnail.read`。P7-14 的 `core-shared/kernel/src/capabilities/shell_thumb.rs` 已写就(STA 线程 + `ISharedBitmap`→`GetDIBits`→PNG + 分状态分类 + `Mutex`/`Condvar` 并发闸门),`cargo check --workspace --all-targets` 与 `cargo test -p fm-kernel` 通过,闸门测试断言的是"许可必须全部回家"而不是时序巧合。**在真实 Windows Shell 缓存上的命中率与 handler 出图属于"已实现未验证"**:无头环境不能启动 GUI,也不能把系统缩略图缓存当作可复现的测试夹具;出图形状、缓存策略分支与未命中分类都由 dev 侧预置样例图取证(截图 26..28)。

两处范围决定(记录于此,避免后续重复实现):
- **`plugin-inspector` 预览区系统缩略图随 P7-21 一起交付**,本批只迁 `plugin-file-browser` 网格:预览区与"文件预览"切换是同一处 UI,分两次做会让同一个槽出现两种取图实现。
- **`plugin-windows-thumbnails` 的开关页不进批次 4**:契约已含 `policy`(默认 `extract`),消费侧偏好开关已可用;把"仅读取系统已有缓存"作为独立设置页属于该插件自身的交付批次,不应在迁移批里半做。

### 批次 5 · Windows 原生文件操作

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-16 | `shell.*` 能力契约冻结（=P6-2/P6-3/P6-30 前置） | ⭐⭐⭐⭐ | `shell.fileOperation`(copy/move/rename/create/delete,回收站默认)/`openPath`/`revealItemInDir`/`pickFile`/`pickDirectory` 的入参与返回 DTO;后台进度与逐项结果形状进 Rust contracts;`file.kind`(=P6-6) 同期冻结 | ✅ |
| P7-17 | `IFileOperation` provider | ⭐⭐⭐⭐½ | STA 线程 + `SetOperationProgressUI`/`QueryUndoEventPoint` 不接管;不自写复制/移动/删除算法;跨卷 move 是否退化为 copy+delete 须报告;取消只停仍可取消的项并如实报告已完成项 | 🟡 |
| P7-18 | `plugin-file-ops` 前端 | ⭐⭐⭐⭐ | 状态机 `idle→validating→awaiting-confirmation→queued→running(progress)→completed/partial-failure/failed/cancelled`;真实进度或不确定进度,不伪造百分比;部分成功给可复制失败清单;Mantine form/modal 仅收集新名称/目标(=P6-27);完成后经 watcher/显式刷新收敛列表 | ✅ |
| P7-19 | 文本编码探测（=P6-8） | ⭐⭐ | `fs.readText` 非 UTF-8 经 `encoding_rs`+`chardetng` 正确解码;超限/二进制返回可区分的明确结果 | ✅ |

**取证**:`.scratch/pw/run-d.mjs` **47/47**(截图 30..47),`.scratch/pw/run.mjs` 43/43、`run-b.mjs` 15/15、`run-c.mjs` 11/11 同时保持全绿。已取证的界面事实:条目 surface 一次右键得到 打开/在资源管理器中显示/重命名/复制到文件夹/移动到文件夹/移到回收站 六个由 file-ops 贡献的动作(基座只画面板);空白区右键只有 刷新目录/全选/新建文件夹,**新建的目标目录由 browser 作为 surface 自己的 `targetRef` 交出来**,基座不持有任何"当前目录"业务状态;非法名称(`a/b`、`..`)在 modal 内报错且模态不关闭;运行中的状态行是不确定进度文本,**界面全程没有百分比**;同名冲突由 dev 侧的 Shell 规则落名并在汇总里如实写"其中 1 项自动改名";跨卷移动汇总尾部显式写出"跨卷移动:Shell 按复制后删除完成";15 项批量删除返回 `部分完成：成功 13 项，失败 2 项`,详情逐项给"没有权限/找不到项目"的中文原因,复制清单同样是中文逐项文本(内部拼写如 `partial-failure` 不出现在用户可见文本里);1000 项删除运行中可取消,状态行先转"正在取消"再落"已取消：完成 7 项，取消 993 项",运行期间条目 surface 不再提供任何新动作(busy 门)。列表收敛:操作完成后浏览器按 `file:changed` 自动重读——本批把该事件的载荷口径统一为**条目路径**(与 watcher 同一说法),而不是目录,`plugin-file-browser` manifest 相应声明 `file:changed` 订阅权限。dev 侧的清单叠加层把删除记录同时作用于内置清单与会话内新建/改名的条目，因此"失败的项仍在列表、成功的项已消失"这条断言对改名出来的条目同样成立（一次刷新有两帧：清空后的空白帧再到重读结果，断言须等"消失项已消失且保留项仍在"同时成立）。P7-19 的三种文本状态在界面上各自可区分(由批次 6 的 `plugin-preview` 承载):`编码 GBK · 96 B`(非 UTF-8 报真实编码名)、`这不是文本文件（2 KiB），无法按文本预览。`、`文本预览上限 4 MiB，这个文件 9 MiB。`,并断言界面任一处都不再出现 `[object Object]`(消费侧此前把 `ReadTextOut` 当字符串用,本批修掉)。Rust 侧 `cargo test -p fm-kernel` 覆盖 UTF-16 BOM 剥离、GBK 猜测解码、二进制否决(`looks_binary`)、超限返回 `too-large`。

一处遗留限制(记录以免重复讨论):**`plugin-file-browser` 没有订阅 `watch.subscribe`**。`WatchHub` 目前只有 subscribe、没有 unsubscribe,按目录导航去订阅会永久累积 watcher;自动刷新因此只覆盖"本应用自己执行的操作"与已经在分发的外部变更,外部工具的实时变更需要 refresh 或下一次导航才可见。等 `watch` 补上 unsubscribe/引用计数再接。

### 批次 6 · 统一预览

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-20 | 预览安全数据通道（=P6-67） | ⭐⭐⭐⭐½ | 只读、路径绑定、短时有效的资源句柄 + range/chunk 通道,支持取消与撤销;禁止裸 `file:`/asset URL、禁任意远程加载、禁大文件全量 base64 | ✅ |
| P7-21 | `plugin-preview` 实现与 preview-text 接替（=P6-22/24/68） | ⭐⭐⭐⭐½ | Open File Viewer React SDK 接入共享单例/import map;预览区"缩略图 / 文件预览"切换,新焦点默认只显示系统缩略图、不初始化 viewer、不读正文;用户显式点击才分派;`fm.preview.prefs.v1` 只存格式偏好不存模式 | ✅ |
| P7-22 | 格式分类验收与资源回收 | ⭐⭐⭐⭐ | 文本/代码/Markdown、图片、PDF、音视频、Office、压缩包按代表性本地样本逐类取证;不支持/损坏/加密/超限各有可恢复中文状态;切回缩略图或换焦点取消读取、撤销句柄、释放 media/worker/object URL | ✅ |

**取证**:`.scratch/pw/run-f.mjs` **125/125**(截图 63..85)。通道语义 19 条逐项打在真实现上(`cargo test -p fm-kernel` 的 `capabilities::resource::tests` 6 条 + 浏览器侧 dev 镜像同一套语义):空路径与目录 → `invalid argument:`,缺失 → `not found:`,无权 → `permission denied:`;句柄不透明(不含路径/分隔符/文件名);TTL 5 分钟;**过期或已关闭的句柄再读是错误,绝不返回空字节**;1 GiB 单次请求被截到 512 KiB 并在返回里如实标记 `clamped`;`requestToken` 原样回显;2 MiB 用 4 个分片读回且字节精确;越界读是 `eof:true` + 空数据而不是异常;二次 close 返回 `false`;同时最多 16 个活跃句柄,超出即拒。界面侧的关键事实是**默认态零内容读取**:新聚焦文件停在缩略图模式时通道计数为 `{open:0, read:0, close:0, bytes:0, clamped:0, textRead:0}`,无系统图时给 `.TXT` 类型徽标,查看器节点根本不存在;预览区两种模式下几何固定 260 高。12 个代表性本地样本逐类出图(文本/代码/Markdown 走 `fs.readText` 因而带真实编码行 `编码 UTF-8 · 3.4 KiB`,图片/PDF/压缩包/Office/表格/音频走字节通道):PDF 由 pdf.js 真渲染且**全程零外部源请求**,worker 以 `text/javascript` 从本地供给(拒绝 CDN 回退);docx 与 xlsx 是本批手写的合法 OOXML,正文段落被 Office 插件真的解析出来;`password-required` 用真的 R2/RC4-40 加密 PDF 触发,`corrupt` 用真损坏 PDF 触发,两者各有中文状态与出路(加密/损坏/超限/不支持 → "用 Windows 打开",不存在/无权限 → "重试"),查看器自己那张贴在视口里的 `.ofv-fallback` 卡被观察器换成本区状态;70 MB 视频只 open+close 不读正文(>64 MiB 上限),`.svg` 在 open **之前**就被类型门拒掉——这是"不宣称全格式可预览"的实测形态。取消路径:读到一半切走,关闭数与打开数一致且不残留句柄,状态如实写"已取消这次内容读取",半截内容不会被当成 `ready`。`preview:state:changed` 在调试台里成块不交错,序列含 `checking→loading→ready`,mode 只有 `thumbnail|viewer`。偏好只存格式项:`fm.preview-text.prefs.v1` 迁移为 `fm.preview.prefs.v1` 后旧 key 删除,旧 `autoLoad` 没有变成自动预览,1000 字符上限确实截掉了样例尾部。原始英文原因(带线协议前缀)只进 `title`,用户可见文案全中文。**仍未取证的部分**:真 Tauri 窗口内的可视化验证、真实 Windows Shell 缩略图字节、真实 `chardetng` 猜测结果(dev 里是编码名与图片的预置样例),这三处保持 🟡。

### 批次 7 · 空间分析

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-23 | 遍历与磁盘能力（=P6-1/P6-5） | ⭐⭐⭐ | `sys.disk` + 可取消的递归大小统计(并行遍历,不阻塞文件浏览);排除/符号链接/硬链接策略定案 | ✅ |
| P7-24 | `plugin-storage-analysis` | ⭐⭐⭐ | 选根目录→扫描进度→echarts treemap→点击下钻/返回;权限跳过不计入且可见说明;聚合缓存按路径与时间失效;扫描可取消 | ✅ |

**取证**:`.scratch/pw/run-e.mjs` **47/47**(截图 50..62),Rust 侧 `cargo test -p fm-kernel` 的 `capabilities::sys::tests` 14 条。遍历策略在这里是**定案**而不是实现细节:指向目录的符号链接被如实说明并**从不跟随**(循环因此不可能发生),读不了的目录按原因归类跳过且**一个字节都不计入总量**,计数不重复、不遗漏(单测逐项断言"每个计入的条目都被报告"),工作线程数与并发扫描数各有上限且**超出即拒而不是降级**为无界排队;取消只作用于仍在跑的扫描,已终态的返回 `false`。界面侧:选根目录走 `shell.pickDirectory`(dev 答案确定,不弹真实 Shell 对话框);进度分批推进且扫描期间页面仍在出帧,证明遍历跑在时间片/后台线程而不是同步大循环;压力数据集扫完报 `扫描完成 · 81 MiB · 30 项`,总量与条目数与清单里真实大小逐项之和一致,跳过项旁边写明"不计入总量";一个层超过 24 块时合并成"其他"并保留逐项入口,深度上限之外的层如实说明而不是默默截断;点击矩形下钻会同时改面包屑与概览文案,返回上一级两者一起回退,点进没有返回明细的目录时如实说明而不是画空图;同一根目录在有效期内复用聚合结果并写明扫描时刻,兄弟路径的缓存不牵连;`file:changed` 落在根目录下会按路径作废该缓存并写明原因,作废后重扫确实少一项;取消在时间片边界有界停下,终态写明"已取消"且统计不完整,面板尺寸在取消态仍保持不变(几何稳定规则),且取消不留下可用缓存。

### 批次 8 · Lore 文件历史（决策门在前）

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-25 | **Lore 可行性 spike（=P6-69）— 决策门** | ⭐⭐⭐⭐⭐ | 验证 Windows 构建、Rust API 与许可、仓库格式、服务端依赖、与当前单进程宿主的兼容性;固定上游 revision;确定宿主管理的本地服务生命周期与数据目录。**结论未出前 P7-26/27 不开工** | ✅(决策门结论:**暂缓**,见 [05](05-decisions.md) D21) |
| P7-26 | `plugin-file-history` 迁移到 Lore（=P6-70） | ⭐⭐⭐⭐⭐ | `lore.*` 受控能力;仓库显式初始化/连接且范围经用户确认;版本时间线分页、dirty 状态、只读查看、行级 diff(=P6-11/23)、恢复前检查未提交改动并二次确认、恢复形成可追踪的新变化;11 态状态机;请求带 `path+repositoryId+requestToken` 丢弃迟到响应;旧 `db.history.*` 只读兼容 | ⏸ 不排期(P7-25 暂缓) |
| P7-27 | `plugin-history-metadata`（=P6-71） | ⭐⭐⭐⭐½ | 订阅 `lore:revision:*` 生命周期(含同一 Lore 服务的 LoreGUI 创建);采集系统缩略图/大小/类型/图片尺寸与采集状态入独占 `db.historyMetadata.*` + blob;经 `history-record:metadata` 子槽挂载历史行;只发 restore request 不拥有 Lore commit/restore 能力 | ⏸ 不排期(P7-25 暂缓) |

**决策门取证(批次 8)**:spike 结论是**不做**。事实核对(2026-10):上游是 `EpicGames/lore`(pre-1.0),**没有向 crates.io 发布任何 Lore crate**——`lore` 这个名字属于无关的 "Flexible logic programming"(NthTensor 0.1.0),`lore-vm` 直接 404;而文档里设想的解耦层 `lore-vm` 出自第三方 `BiloxiStudios/loregui`,不是 Epic 的接口面。因此接入只能 git 固定 revision 自源码构建,并同时承担三件事:Windows 工具链构建由本仓库兜底、仓库磁盘格式随 pre-1.0 上游漂移、`loreserver` 服务生命周期与 D4"单进程、无 sidecar"正面冲突。相对收益(可恢复到任意历史内容)不足以支付这些代价,决策与复核触发条件写进 [05](05-decisions.md) D21;现有 `plugin-file-history` 的 hash/DB 快照保持现状,不宣称可恢复内容版本。

### 批次 9 · 搜索与命令面板

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-28 | **索引引擎选型（=P6-9）— 决策门** | ⭐⭐⭐⭐⭐ | 实测 FTS5 够用于名称/路径检索（含中文子串），tantivy 不引入；取舍记录进 [D24](05-decisions.md)；`search.query`/`search.status`/`search.index.start`/`search.index.cancel` 四能力 + `SearchQuery*`/`SearchIndex*` DTO + `search:index-progress`/`search:index-done` 两事件冻结；结果不分开发播事件，随分页 `search.query` 返回 | ✅(`core-shared/kernel/tests/search_spike.rs` 6 passed；`cargo test -p fm-contracts` 9 passed；`contract:check` OK；SDK 15/15) |
| P7-29 | 索引后台与查询能力 | ⭐⭐⭐⭐⭐ | 后台分块索引、可取消、增量进度事件；索引可整体重建；查询返回有界部分结果 + 偏移；<3 字走有界子串扫描；不额外存正文副本 | ✅（`core-shared/kernel/src/capabilities/search.rs`；能力与事件两侧冻结，见批次 9 取证） |
| P7-30 | `plugin-search` + 命令注册 API（=P6-14/19） | ⭐⭐⭐⭐ | SDK 补命令注册面与快捷键声明;命令面板 Ctrl+Shift+P 搜索命令与文件,键盘打开,插件卸载后命令即移除,命令错误就地显示;搜索结果打开所在目录并聚焦文件 | ✅（SDK `commands` 面 + 基座命令服务 + `plugin-command-palette`；见 [D25](05-decisions.md) 与批次 9 取证） |

**取证(批次 9 · P7-28~30)**：索引后端落在内核能力层(`search.status`/`search.query`/`search.index.start`/`search.index.cancel` 四能力 + `search:index-progress`/`search:index-done` 两事件,独立可重建的 `search-index.db`,外部内容表 trigram,见 [D24](05-decisions.md))。前端 `plugin-search` 是顶栏入口 + 固定 620×640 浮层:索引进度只有真实条目数与耗时、`partial/failed` 如实显示中文原因且零命中不谎称"没有匹配"、分页"取更多"追加不换页、短于 3 字走逐字扫描、偏好(默认范围/只在当前目录)进 `fm.search.prefs.v1` 与插件设置页;`shell.pickDirectory` 在 dev 走内存替身,自动化路径绝不弹真实对话框。命令面按 [D25](05-decisions.md):`plugin-search` 注册 `search.open`(Ctrl+Shift+F)与 `search.index-current`;`plugin-command-palette` 占 `command-palette` 槽、领取唯一 launcher,并把 `Ctrl+Shift+P` 注册成 `palette.open` 自身命令;面板固定 620×420、列表内部滚动、命令错误就地显示、停用插件后其命令立刻从面板消失。`plugin-dev-slot-harness` 新增三条故意违规(未授权 `commands.provide()`、非法快捷键 `Ctrl+`、重复占用 `Ctrl+Shift+F`)取证拒绝路径。新增取证脚本 `.scratch/pw/run-h.mjs` **87/87**(A~M:空态/索引与进度/取消/分页/重建/错误口径/偏好/命令面板打开·过滤·执行·几何·文件跳转·卸载即移除·越权拒止,截图 100~113)。全部门禁同轮复跑:`pnpm -r typecheck` 21 项目全绿、`contract:check` OK、SDK `node --test` **15/15**、`cargo test -p fm-kernel -p fm-contracts` 全绿(fm-contracts 10/10;fm-kernel 94 项单测 + 集成)、`run` 43/43、`run-b` 15/15、`run-c` 11/11、`run-d` 47/47、`run-e` 47/47、`run-f` 125/125、`run-g` 49/49。

### 批次 10 · 插件内扩展功能（依赖批次 3/5）

| # | 任务 | 难度 | 完成条件 | 状态 |
|---|---|---|---|---|
| P7-31 | 表格视图（=P6-16） | ⭐⭐⭐ | `@tanstack/react-table` 排序/列配置/键盘选择;行模型仍归 `plugin-file-browser` 拥有,不另造插件 | ✅ |
| P7-32 | 标签 chips（跨插件契约） | ⭐⭐⭐⭐ | 定义受权限声明的 tags 查询/批量查询契约(禁 file-browser 读 `fm.view-tags.v1`);卡片显示关联标签并可筛选;删除文件与重复路径的处理策略定案 | ✅ |
| P7-33 | 文件条目拖放 | — | 已从功能范围移除 | ❌ |
| P7-34 | 展示层统一（=P6-20/21/26） | ⭐⭐ | `lucide-react`/`@vscode/codicons` 替换 A 栏残留 emoji;`dayjs`+`pretty-bytes` 统一时间与体积格式;图标与文案走 key 白名单,不泄漏槽 id/存储 key | ✅ |

**取证(批次 10 · P7-34)**:图标侧把 A 栏与工具条里剩下的符号字形全部换成 `lucide-react` 组件(模拟数据集 `▥`→`Database`、收藏/标签行的 `📁/📄`→`Folder`/`File`、分栏与浏览模式下拉的 `⌄`/`✓`、底抽屉的 `▾/▸`、空间分析的 `✕/↖`、调试台的下载/清空),插件依赖表里补 `lucide-react`(每插件自带,不进 import map)。格式侧把四屏共用的显示规则收进 SDK:`formatSize`(`pretty-bytes` + `binary:true`)、`formatDate`/`formatDateTime`/`formatClock`(`dayjs`),`plugin-file-browser`/`plugin-file-details`/`plugin-preview`/`plugin-storage-analysis`/`plugin-file-history`/`plugin-devtools-log` 各自的本地 `formatSize`/`formatBytes`/`Intl.DateTimeFormat` 全部删除,取证脚本 `run-f.mjs` 也改为直接 import SDK 的那一个实现,expected 字符串与渲染字符串不可能再漂移。单位选二进制口径是刻意的:Windows 资源管理器按 1024 报体积,列表里的数字要能和它对上。门禁:`pnpm -r typecheck` 全绿、`contract:check` OK、`pnpm build:shared` 把 `dayjs`/`pretty-bytes` 内联进 `shared/plugin-sdk.js`(prod 与 dev 两个变体都不留裸 `import "dayjs"`)、SDK `node --test` **14/14**、`run.mjs` **43/43**(末尾三条新断言:全程界面文本零 emoji/符号字形、无 `KB/MB/GB` 残留、无 `undefined`/`[object`)、`run-b` 15/15、`run-c` 11/11、`run-d` 47/47、`run-e` 47/47、`run-f` 125/125。**同轮修掉一处文档漂移**:SDK 测试里仍断言 `Capabilities.thumbImage === "thumb.image"`,而该能力在批次 4(P7-15)已被 `shell.thumbnail.read` 取代,即此前记录的"SDK 11 项过"已与 HEAD 不符;断言改为校验新能力名并显式断言 `thumb.image` 不存在。P6-26(i18n)不在本批范围:界面按单一语言中文建设,见 [05](05-decisions.md) D22。

**取证(批次 10 · P7-31 表格视图)**:`plugin-file-browser` 的 `ViewMode` 增 `"table"`,三模式的事实源收敛成一张 `VIEW_MODES` 表(菜单项、当前标签、设置页的默认显示方式都从它生成),表格由 `@tanstack/react-table` **v9**(9.2.8,注意与 v8 API 不同:`tableFeatures()` 注册 `rowSortingFeature`/`columnVisibilityFeature` + `createSortedRowModel()` + `sortFns.alphanumeric`,`createColumnHelper<TFeatures,TData>`,`useTable`,列选项是 `sortFn` 而非 `sortingFn`)驱动排序与列可见性;**行模型、选择集合、右键 surface、虚拟化流仍全部由本插件拥有**,没有为表格另造插件(决策见 [05](05-decisions.md) D23)。要点:①隐藏的 `dir` 列做排序主键(`enableHiding:false`),所以升序降序都是文件夹成组在前,和列表/网格同一口径;用户点出来的排序状态里永远不含 `dir`。②没人点表头时 `sorting` 为空数组 → 走**提供方送来的顺序**,前端不重排(D9),取证直接比对"列表模式顺序 == 表格未排序顺序 == dev 清单原序"。③表级 `sortDescFirst:false`,数值列默认"第一次点击=降序"被压成"第一次=升序",四列行为一致且与资源管理器相同。④列开关(大小/修改时间/类型)写进插件偏好 `fm.file-browser.prefs.v1` 的 `tableColumns`,名称列结构上不可隐藏(设置页没有它的开关)。⑤每栏独立:模式与排序状态都是栏位级的,新栏位跟随偏好而不继承邻栏;排序既不进任何存储也不跨挂载保留(切到列表再切回表格即回到读取顺序)。⑥几何:行高固定 36 让 `estimateSize` 与真实高度相等;表头画在滚动区之外,因此给它补了与 `.fm-entry` 相同的 1px 透明左右边框并按实测滚动条宽度扣 `padding-right`,表头与行的 `grid-template-columns` 计算值严格相等(638px 而非 640px 差 2px)。⑦`vite dev` 加载的是 `frontend/dist/` 的**构建产物**(不是源码),所以插件源码改动必须 `pnpm build:plugins` 后才进浏览器取证。**顺带修掉一处既有缺陷**:每栏记忆(P6-57)恢复出 `cwd` 的栏位,首次挂载时因 `request` 为空、`fs.home` 引导 effect 又因 `cwd` 已存在而提前返回,结果**从不发起 `fs.list`**,永远停在"正在加载目录…";现在初始 `request` 用记住的目录播种(`mode:"step"` 不推进历史栈),`run-g` 的 E5b 断言恢复栏位自己把目录读出来。新增取证脚本 `.scratch/pw/run-g.mjs`(49 项,截图 86~88):结构/内容口径/选择与键盘/右键菜单与列表模式同集/排序三态循环/排序不跨挂载保留/列配置与重载持久/每栏独立/1 千与 1 万条目虚拟化常数/1 万排序 338 ms/表头不随滚动移动/模式切换区域几何不变。全部门禁同轮复跑:`pnpm -r typecheck` 干净、`contract:check` `contract OK`、SDK `node --test` **14/14**、`cargo test -p fm-kernel` **67 passed**、`run` 43/43、`run-b` 15/15、`run-c` 11/11、`run-d` 47/47、`run-e` 47/47、`run-f` 125/125、`run-g` 49/49。

**取证(批次 11 · P7-32 标签)**:存储侧 `plugin-view-tags` 重构为 `db.tags` 的唯一写者(契约与理由见 [05](05-decisions.md) D26、[09 §3.4](09-plugin-functional-spec.md)):key=标签名、value=`{seq,members:[{path,kind}]}`;改名先写新键再删旧键(删失败回滚新键,不留下两个名字的副本)、保 seq/成员/展开态/选择;同名不区分大小写拒绝、去空格后空名拒绝;任何一次写失败都不猜结果——报错并重查库内真值。读侧 SDK `listTags(host)`/`parseTagRows(rows)` 是唯一入口(一次无键 `db.tags.list`;调用方 manifest 必须声明该只读能力):丢弃形状不符的行与成员、名去空格、seq 非数按 0、同标签内同 path 折叠、按 seq 升序(name 平手),因此**库里的脏行不会变成界面的脏数据**。伪造脏行(`坏行:42`、重复 path、缺 kind)的 store 在面板上显示 `甲,丙,乙`(seq 序,而非插入序/名称序),chips 只落在真实成员上。旧键导入:`fm.view-tags.v1` 仅在 store 为空时一次性导入——名去空格、大小写重名合并保首个拼写、垃圾项丢弃并在提示里写"已自动清理"、任一条写失败回滚已写行、全部成功后删旧键、损坏 JSON 只提示不导入也不删;store 非空时旧键原样留存。消费侧 `plugin-file-browser`:模块级 `tagIndex`(path→标签名)在 `activate` 与每次 `tags:updated` 重建,经 `useSyncExternalStore` 订阅(整体替换 Map 引用);列表行/网格卡片/表格标签列共用 `TagChips`(上限 2 + `+N`,悬停给出其余标签名);表格标签列 `enableSorting:false` 且表头按钮 `disabled`;点击 chip 发 `sidebar:selection:changed{kind:"tag"}` 打开标签视图。标签视图是每栏历史栈里的普通项(栈项为 `tag://<encodeURIComponent(name)>`,标题/地址栏显示 `标签「X」`,`tag://` 不外显),没有"上级目录",成员点击发 `focus:changed` 但标签视图本身不因目录导航失效(跨目录透镜),`tags:updated` 到达即重查,标签被删显示 `标签「X」已不存在` + 重试,撤销删除后视图自愈;每栏记忆(`fm.file-browser.v1`)恢复标签视图后重新拉成员。`.scratch/pw/run-i.mjs` **70/70**(截图 200~207)覆盖上述全部,含控制台干净;九套门禁同轮复跑全绿(43/15/11/47/47/125/49/87/70 共 494 项)、`cargo test --workspace` **118 passed**、SDK `node --test` **15/15**、Vitest **14/14**、`contract:check` OK、`pnpm -r typecheck` 与 biome(116 文件)、`cargo fmt --check` 与 clippy `-D warnings`、`build:plugins`+`build:shared` 全部干净(所有插件 dist 均为本轮重构建产物)。**同轮修掉一处既有缺陷**:表头用 v9 恒返回函数的 `getToggleSortingHandler` 判断列可否排序,展示列(标签)因此看起来能点并挂着排序箭头——改用 `getCanSort()`(教训见 [00](00-handover.md) §4.30);另修三处**证据漂移**(`run.mjs` 仍断言"标签筛选暂未支持"、`run-c.mjs` 的缩略图定位扫描停在旧卡片高度 156、`run-g.mjs` 的列数期望停在 4 列)。

### 并行支撑项（不属于插件功能，但每批验收要用）

批次 1 起即应建立:前端 lint/format(P6-31 **已落地**,见上方 6C 取证)、Rust 门禁(P6-32 **已落地**,clippy+fmt)、前端单测含 `PluginSlot` 错误边界(P6-33 **已落地**,Vitest)、CI(P6-35 **已落地**)、供应链审计(P6-36 **已落地**,cargo-deny)、提交钩子(P6-37 **已落地**,lefthook)。E2E(P6-39) 需显示环境,本环境仍以 `vite dev` @1420 的 DOM/console 断言 + 需 GUI 项标 🟡 的方式取证。

---

## 风险登记

| # | 风险 | 级别 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | cordis-rs 与 Tauri v2 异步运行时集成方式未知 | **高**(已退役) | 内核无法在宿主进程内驱动 | 已由 P0-3 spike + `fm-kernel` 无头测试证实可行;集成落于 `apps/host` setup |
| R2 | cordis-rs 属早期活跃依赖(v3 线,更新频繁),API 可能变动 | 中 | 后端 SDK 反复返工 | 锁定 crate 版本;`core-shared/contracts` 做薄封装隔离其类型,插件只依赖封装 |
| R3 | WebView 本地 `import()` ESM 的协议/CORS/React 单例问题 | 中(已大幅退役) | 前端插件加载失败或多实例 | import map + 双变体共享单例已在浏览器实测;`plugin://` 段待窗口验证 |
| R4 | 后端插件静态内置 → 第三方无法运行时注入后端代码 | 已接受 | 后端扩展性受限于构建期 | 视为**架构边界**而非缺陷;运行时扩展集中在前端 ESM + 已内置能力(见 05 决策) |
| R5 | 前端插件在 WebView 内可调用 host 能力,恶意插件滥用 | 中 | 越权访问文件/DB | 权限白名单 + 能力最小化 + 插件来源限本地可信目录 + 装载校验 |
| R6 | 多插件并发写 sqlite | 低-中 | 写冲突/锁 | 每 `store` 独立分区;WAL 模式;写串行化 |
| R7 | 大文件哈希/目录遍历性能 | 中 | UI 卡顿、体验差 | 能力层用流式分块 + 多线程(rayon);重活留在 Rust,不进 WebView |
| R8 | **Lore 在 Windows 上的可用性与 Rust 集成形态未证**(workspace 依赖当前无 lore crate,`plugin-file-history/backend` 186 行零 Lore 代码) | 已退役(P7-25 结论:暂缓) | 批次 8(P7-25~27) 整条链不再排期,历史功能停留在旧 hash/DB 快照——这是**已接受的现状**,不是缺陷 | 决策门已做完:上游不发布 crates.io crate、`lore-vm` 属第三方,接入需 git 自建且服务生命周期与 D4 冲突,结论落 [05](05-decisions.md) D21;三条复核触发条件写在同一处,任一成立才重开 |
| R9 | 全文检索索引引擎选型未定(FTS5 vs tantivy) | 已退役(P7-28 定案) | — | 已定 **SQLite FTS5 + trigram**、不引 tantivy,契约与实现均已落地;见 [05](05-decisions.md) D24 与批次 9 取证 |
| R10 | Windows Shell COM(`IThumbnailCache`/`IFileOperation`)与 Tauri 异步运行时的线程模型冲突 | 中-高 | 缩略图/文件操作卡死或崩溃宿主 | COM 调用固定走专用 STA 线程且不与 tokio 共享句柄;P7-14/17 各自先做最小 spike 再接 UI |
| R11 | `host.contextMenu` / 命令注册 API 一旦定错会波及 5 个贡献者(favorites/tags/browser/history/search) | 已退役(两者均已定稿并落地) | — | 两个 API 都按"先冻结 API 形状 + 权限段 + 卸载清理测试,再逐插件挂动作"落地:右键见 P7-10/[D19](05-decisions.md),命令见 P7-30/[D25](05-decisions.md);框架插件不含任何业务动作 |

---

## 明确不做(Out of Scope / 已否决)

以下方向经评估**明确不采用**,列入此处防止后续被重新引入(理由见 [05-decisions.md](05-decisions.md)):

- ❌ **Node/Deno sidecar 承载后端**:后端是原生 Rust,无需独立 JS 进程。
- ❌ **嵌入式 JS 引擎(QuickJS/V8)跑后端插件**:后端插件即 Rust,不需要 JS 引擎。
- ❌ **Module Federation**(`@originjs/vite-plugin-federation` 已停维护;`@module-federation/vite` 对桌面本地场景过重):前端插件用普通 ESM + `import()`。
- ❌ **后端插件运行时二进制动态加载(cdylib/libloading 或 WASM)**:本期不做。后端插件静态内置;运行时安装仅前端 ESM。这是已接受的边界(R4)。
- ❌ **Rust 能力层写业务逻辑**:能力层只做原子操作。
- ❌ **基座持有业务状态**:基座只有元状态。
- ❌ **插件间物理 import**:只经事件/能力/Service 契约。
