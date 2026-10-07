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
| P2-5 | 样式隔离 | 插件样式不污染基座(Mantine 共享单例 + CSS Modules;不用 Shadow DOM) | ✅ | 浏览器实测插件与基座共用 Mantine 主题,无样式串扰 |
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
