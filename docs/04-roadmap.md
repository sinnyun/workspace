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

## Phase 6 · 既定开源栈落地(能力扩展 + 功能插件 + 工具链)

> 目的:把 [06-open-source-stack.md](06-open-source-stack.md) 已选型的开源库**真正接入**,而不是停在清单。每项注明**用哪个库**、**装在哪(隔离层)**、**完成条件**。新增后端能力一律落在 `core-shared/kernel/src/capabilities/*`(对外只经 `db.<store>.*` / 能力名契约);新增前端功能一律做成**插件**(运行时 `import()`),共享依赖走 import map 单例。跨层新数据形状先加 `core-shared/contracts`↔`plugin-sdk` 并跑 `contract:check`。
>
> **这些库按插件的分布(哪个插件拉起哪些 P6 任务、占哪些插槽、声明哪些能力/事件)见 [08-plugin-catalog.md](08-plugin-catalog.md)。** 下面 6A/6B/6C/6D/6E 是"按库/任务"视角,08 是"按插件"视角,同一批工作两种切面。

### 6A · 后端能力层扩展(Rust,走 capabilities 隔离层)

| # | 能力 / 任务 | 采用库 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-1 | 并行目录遍历 + 大目录基准(收口 P1-7) | `ignore`(尊重 gitignore)或 `jwalk`(纯并行更快) + `rayon` | `fs.list` 并行遍历;10万级目录基准达预期;`fs.readChunk`/`hash.compute` 流式分块 | 🔵 |
| P6-2 | 回收站删除 | `trash` | 能力 `fs.trash`(跨平台回收站,非硬删) | 🔵 |
| P6-3 | 复制 / 移动 + 进度 | `fs_extra`(目录级)+ 自写分块进度 | 能力 `fs.copy`/`fs.move`,大文件进度事件 | 🔵 |
| P6-4 | 文件名自然排序 | `natord` | 列表/排序 "2 file" < "10 file" | ✅(`fs.list` 出参按 `natord::compare_ignore_case` 排好,provider 负责顺序,浏览器不再排序;dev mock 生成序与之对齐) |
| P6-5 | 磁盘/系统信息 | `sysinfo` | 能力 `sys.disk`(剩余空间、占用统计) | 🔵 |
| P6-6 | 类型识别(MIME) | `infer`(魔数)+ `mime_guess`(扩展名兜底) | 能力 `file.kind`,供预览/图标插件消费 | 🔵 |
| P6-7 | 图像缩略图 | `image`(default-features off:png/jpeg/gif/bmp/webp/tiff)+ `base64` | 能力 `thumb.image`:内核解码 → 等比缩放(`FilterType::Triangle`,edge ≤ 512)→ PNG data URL,按 mtime 键缓存(`capabilities/thumb.rs`,3 个单测);不走 `file:`/asset URL,权限仍由 `permissions.capabilities` 门控 | ✅(`fast_image_resize` 未引:当前缩放质量与耗时足够,量大再评估) |
| P6-8 | 文本编码探测 | `encoding_rs` + `chardetng` | `fs.readText` 非 UTF-8 正确预览 | 🔵 |
| P6-9 | 全文检索(内容搜索插件) | `tantivy`(大)/ SQLite **FTS5**(小数据,零额外依赖) | 搜索插件后端索引 + `search.query` 能力;**先评估 FTS5 是否够用**再定 tantivy | ⚪ |
| P6-10 | 归档浏览 | `zip` / `tar`+`flate2` / `sevenz-rust` | 只读浏览/解压能力,封进归档插件 | 🔵 |
| P6-11 | 文本差异(file-history 内容 diff) | `similar` | 后端算行 diff,前端 `react-diff-view`(见 P6-20)展示 | 🔵 |
| P6-12 | DB schema 迁移 + 并发池 | `refinery`(版本化迁移)+ `r2d2_sqlite`(多线程池) | 当出现 schema 演进即引入 refinery;当前 rusqlite 单连接直连为已知延后项 | 🔵 |
| P6-13 | 增量版本存储(块级历史,可选) | `fastcdc`(内容定义分块) | 仅在做块级去重历史时启用;否则不引 | ⚪ |

### 6B · 前端功能插件(React + Mantine 生态 + 专用库)

| # | 功能 / 任务 | 采用库 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-14 | 命令面板(Ctrl+Shift+P) | `@mantine/spotlight` | 基座命令总线 + 插件可注册命令 | 🔵 |
| P6-15 | 大文件列表虚拟滚动 | `@tanstack/react-virtual` | 十万级列表不卡 | ✅(已接进 `plugin-file-browser`:列表与网格合并成**一条**虚拟化流,`estimateSize` 按行/头/卡片区分;浏览器实测 50 万条目常驻 DOM ~200(列表)/~500(网格)节点,见 P6-62) |
| P6-16 | 表格视图(排序/列/选择) | `@tanstack/react-table` | 详情列表模式 | 🔵 |
| P6-17 | 目录树 | `react-arborist`(或 TanStack Virtual 自绘) | 虚拟化树 + DnD/重命名/键盘 | 🟡(虚拟化树 + 自写懒加载已交付并实测,见 P6-48;DnD/重命名未做) |
| P6-18 | 拖拽(移动/排序) | `@dnd-kit/core`(+`sortable`) | 拖文件到目录;无障碍 | 🔵 |
| P6-19 | 快捷键 | `react-hotkeys-hook` | 基座级键位,插件可声明 | 🔵 |
| P6-20 | 图标 | `lucide-react`(+ 文件类型图标 `@vscode/codicons`) | 基座与插件统一图标源,替换现有内联/emoji | 🟡(基座顶栏/折叠/会话、D 焦点标题、browser 文件类型图标已用 lucide;A 栏活动图标仍是 emoji) |
| P6-21 | 日期 & 文件大小格式化 | `dayjs` + `pretty-bytes` | 时间线/列表展示 | 🔵(现为插件内自写 `toLocaleString`/`formatSize`) |
| P6-22 | 代码/文本查看器(预览插件) | `@uiw/react-codemirror`(CodeMirror 6)+ `shiki`(静态高亮) | 只读预览插件;需 VS Code 级编辑再上 Monaco(重,独立插件) | 🟡(`plugin-preview-text` 已交付纯文本只读预览并接 `preview-zone`,见 P6-58;CodeMirror/Shiki 高亮未接) |
| P6-23 | 版本 diff 面板 | `react-diff-view` | 消费 P6-11 后端 diff | 🔵 |
| P6-24 | Markdown / PDF / 图片预览 | `react-markdown`+`remark-gfm` / `react-pdf`(`pdfjs-dist`)/ `react-photo-view` | 各做成独立预览插件按需装载 | 🔵 |
| P6-25 | 磁盘占用 treemap | `echarts`(`echarts-for-react`) | 消费 P6-5 `sys.disk` + 遍历数据 | 🔵 |
| P6-26 | i18n | `i18next` + `react-i18next` | 基座+插件文案 | 🔵 |
| P6-27 | 模态 / 表单 | `@mantine/modals` + `@mantine/form` | 设置面板、重命名对话框等 | 🔵 |
| P6-28 | 系统级通知 | `tauri-plugin-notification` | 长任务完成通知(应用内通知已用 `@mantine/notifications`) | 🔵 |
| P6-29 | 窗口状态记忆 / 单实例 | `tauri-plugin-window-state` / `tauri-plugin-single-instance` | 记住尺寸位置;禁多开 | 🔵 |
| P6-30 | 用默认程序打开(增强) | `tauri-plugin-opener`(已装)+ `tauri-plugin-dialog`(已装) | 系统关联打开、原生对话框——验证并接线到能力层 | 🟡 |

### 6C · 质量 / 构建 / 发布工具链(06 §3)

| # | 任务 | 采用工具 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-31 | 前端 lint + format | `Biome` | 配 `biome.json`,纳入 typecheck 脚本与 CI;统一 fmt 门禁 | 🔵 |
| P6-32 | Rust lint + format 门禁 | `clippy` + `rustfmt` | CI 阻断 clippy warning / fmt diff | 🔵 |
| P6-33 | 前端单测 | `Vitest` + `@testing-library/react` | 补 **`PluginSlot` 错误边界**渲染测(当前 P5-1 前端无测);基座关键组件覆盖 | 🔵 |
| P6-34 | 后端测试运行器 | `cargo-nextest` | 本地/CI 用 nextest 跑快、分组好 | 🔵 |
| P6-35 | CI | GitHub Actions(`actions/checkout`+`Swatinem/rust-cache`+`pnpm`+`tauri-action`) | PR 触发:clippy/fmt/`cargo test`/`contract:check`/`pnpm typecheck`/SDK test;发布 job 出跨平台包 | 🔵 |
| P6-36 | 供应链 / 许可审计 | `cargo-deny`(+`cargo-audit`)、`pnpm audit` | `deny.toml` 进 CI,拦漏洞与不合规许可 | 🔵 |
| P6-37 | 提交前钩子 | `lefthook` | pre-commit 跑 fmt+lint+typecheck | 🔵 |
| P6-38 | 版本 / 变更日志 | `changesets` | 前端包与发布说明的版本流程 | 🔵 |
| P6-39 | E2E(桌面) | `WebDriverIO` + `tauri-driver`(官方),备选 Playwright 连 WebView2 CDP | 端到端冒烟;需显示环境(与 P0-2 类同环境限制) | ⚪ |
| P6-40 | 包体积分析 | `rollup-plugin-visualizer` / `size-limit` | 控插件/宿主产物体积;可选 | ⚪ |

### 6D · cordis 运行时补全(已声明未用的依赖在此转正)

| # | 任务 | 采用库 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-41 | 声明式加载计划 / 注册表生成 | `cordis-loader`(当前在 workspace 声明但**无引用**) | 落地 roadmap P3-5:扫描 manifest 自动生成后端加载计划,消手写 `registry` 漂移;启用后即从"死声明"转为在用 | 🔵 |
| P6-42 | fiber 作用域定时 | `cordis-timer`(当前在 workspace 声明但**无引用**) | 用于 watch debounce / 定期清理 / 进度节流等需要 fiber 生命周期定时器的场景;启用后进代码 | 🔵 |

### 6E · 界面框架与布局(01 §9 / 02 §4.5 / 08 §5.1)

> 务实边界:**外层网格 + 元状态总线留在基座**,只把多变部分插件化;分栏容器与详情容器是仅有的两个"提供嵌套槽"的框架插件。区域与级联状态定义见 01 §9,嵌套槽机制见 02 §4.5,插件清单见 08 §5.1。

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
| P6-56 | 基座外壳 Mantine 化 + 亮色默认与主题切换 | 基座 `shell-ui`(`App.tsx`/`main.tsx`) | 外壳控件一律 Mantine(会话标签、折叠 `ActionIcon`、主题 `SegmentedControl`、`Divider`、状态栏);`MantineProvider defaultColorScheme="light"`;亮/暗/跟随系统即时生效并持久化 | ✅ | `vite dev` 实测:切「暗色」→ `data-mantine-color-scheme=dark`、body `rgb(255,255,255)`→`rgb(36,36,36)`,切回亮色还原;持久化键 `mantine-color-scheme-value`;`shell-ui` 与 14 个插件 frontend(共 15 包)统一到 `@mantine/* ^7.17.8`,`pnpm build:shared` 重建两套变体后插件仍共用同一 Mantine 实例(hooks 无多实例错,控制台 0 错误) |
| P6-57 | `plugin-settings`(A 齿轮 + B 设置面板) | 前端插件 | 主题三选(跟随系统/亮色/暗色)外置给插件;插件用 `useMantineColorScheme` 直接操作基座的那份配色状态 | ✅ | 实测:点基座顶栏「暗色」后,设置面板内 `input[value=dark].checked===true`,两处控件读同一 Mantine 配色值(`localStorage mantine-color-scheme-value=dark`)——**共享单例的直接收益,不需要任何自定义事件**;齿轮固定在 A 栏底部(`marginTop:auto`) |
| P6-58 | `plugin-preview-text`(文本预览进 D) | 前端插件 | 随级联 `focusRef` 经 gated `fs.readText` 读文本,填 inspector 的 `preview-zone`;超长截断(20 万字符) | ✅ | 实测:焦点 `/demo/src/main.rs` → 信息 tab 内 `预览` 区显示该文件内容;`file-extension-zone` 无注入时显示中文占位 `插件预留：暂无插件注入`;manifest 只授权 `fs.readText`,越权能力路径未变 |
| P6-59 | `plugin-file-browser` 增强:每栏历史导航 + 列表/网格 + 统一虚拟滚动 | 前端插件 | 每栏独立历史栈(后退/前进/上级/刷新)、列表或网格按 `会话\|槽id` 持久化、文件夹/文件分组带整路径、类型图标与大小;`@tanstack/react-virtual` 单条流 | ✅ | 实测:`/demo/src →「上级目录」→ /demo →「后退」→ /demo/src`,前进由 `disabled` 转可用;`fm.file-browser.v1 = {"tab-1\|pane-slot:p0":{"cwd":"/demo/src","mode":"grid"},…}`(每栏独立);网格卡片 `lib.rs / RS / 900 B`;分组条底色改取 `var(--mantine-color-body)`,暗色下实测 `rgb(36,36,36)`(原先写死 `gray-0` 会在暗色留白条);插件 vite 配置加 `define: process.env.NODE_ENV`(react-virtual 读它,同 react-arborist 坑) |
| P6-60 | 界面文案中文化 + 槽标签发现面 | SDK/契约 + `plugin-inspector` + 基座 | manifest `frontend.slots[].label`(可选,空白拒) → 注册项携带 → `host.slotLabel(slotId)`;容器用贡献者自己的名字题 tab,D 焦点标题条/区域占位/分栏头全中文,槽 id 只留在 `title` 悬停提示 | ✅ | `cargo test -p fm-contracts`(`label` 往返 `"版本"`、缺省序列化为 Null、空白拒绝)+ SDK `node --test` 10 项(含 label 可选元数据);浏览器实测:D tab 可见文本 `信息`/`历史`(且移除会覆盖可访问名的英文 `aria-label`)、分栏头显示 `栏 1`(悬停 `pane-slot:p0`)、折叠按钮 `折叠侧栏`/`折叠详情`、状态栏 `会话 1 · 文件 /demo/src/main.rs` |
| P6-61 | 契约:`ListEntry.modifiedMs` + `thumb.image`/`ThumbOut` | `fm-contracts` + `plugin-sdk` + `fm-contract-dump` | 列表条目自带 mtime(目录为 null)以免浏览器逐行 `fs.stat`;新增缩略图能力与 DTO,serde 字段 camelCase | ✅ | `cargo test -p fm-contracts` 断言序列化字段集(按字母序)`["isDir","modifiedMs","name","path","size"]`/`["dataUrl","edge","mime"]` + 目录 `modifiedMs` 为 Null 往返;`pnpm -C apps/shell-ui contract:check` → `dto fields ListEntry`/`ThumbOut` 与 TS SDK 一致;SDK `node --test` 11 项 |
| P6-62 | 真实感压力数据集 + 缩略图消费链 | `dev-mocks.ts` + `plugin-file-browser` + `plugin-layout-panes` | ~48 种格式各带真实体积区间/文本或二进制标记/是否出图,`/stress/数据集-{1千,1万,10万,50万}` + `空目录` + `读取失败`;网格卡片按可见性懒取 `thumb.image` + LRU + 负缓存 | ✅ | 实测:10 万条目头部 `9566 目录 · 90434 文件 · 295ms`、50 万 `47769 目录 · 452231 文件 · 472ms`;50 万时列表常驻 214 节点/网格 514 节点(内容高 13,000,048 / 22,369,618px),滚动 1400px/帧 p50 ≈ 26ms;图片卡片显示 `data:image/png` 真缩略图(96×72 原图 → 卡片框 207×62);二进制文件在 D 显示中文 `无法以文本读取 .m4a(二进制格式)`,`读取失败` 目录显示 `—模拟读取失败`(SDK 新增 `errorMessage` 去掉 `Error:` 前缀),`空目录` 显示中文 `空目录` |
| P6-63 | 分栏高度不变量(容器 owner 强制) | `plugin-layout-panes` | 栅格行轨 `minmax(0,1fr)`;栏 `display:flex`+`flex-direction:column`+`min-height:0`;outlet `flex:1`+`overflow:hidden`(滚动归内容插件) | ✅ | 修前:栏 `<section>` 计算样式是 `display:block`(`display: hidden ? "none" : undefined` 被 React 当成"删除该属性"),`flex:1` 失效 → outlet 长到 260,110px → 1 万条目录**挂载 10,002 行**(无窗口化)且被 `overflow:hidden` 静默裁掉;修后实测 `paneDisplay=flex`、outlet 725px、scroller 视口 663px,挂载节点回到数百 |

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
