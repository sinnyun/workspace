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
> **Phase 6 已立**:2026-10-08 开源库使用审计后,把 [06](06-open-source-stack.md) 的既定选型逐项转成可执行任务(6A 能力 / 6B 前端插件 / 6C 工具链 / 6D cordis 运行时),后续开发按 Phase 6 接入并使用这些库。审计中 cordis-rs 侧发现的**已声明未用**依赖(`cordis-loader`/`cordis-timer`)不删除,由 P6-41/P6-42 转正启用。

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
> **这些库按插件的分布(哪个插件拉起哪些 P6 任务、占哪些插槽、声明哪些能力/事件)见 [08-plugin-catalog.md](08-plugin-catalog.md)。** 下面 6A/6B/6C/6D 是"按库/任务"视角,08 是"按插件"视角,同一批工作两种切面。

### 6A · 后端能力层扩展(Rust,走 capabilities 隔离层)

| # | 能力 / 任务 | 采用库 | 完成条件 | 状态 |
|---|---|---|---|---|
| P6-1 | 并行目录遍历 + 大目录基准(收口 P1-7) | `ignore`(尊重 gitignore)或 `jwalk`(纯并行更快) + `rayon` | `fs.list` 并行遍历;10万级目录基准达预期;`fs.readChunk`/`hash.compute` 流式分块 | 🔵 |
| P6-2 | 回收站删除 | `trash` | 能力 `fs.trash`(跨平台回收站,非硬删) | 🔵 |
| P6-3 | 复制 / 移动 + 进度 | `fs_extra`(目录级)+ 自写分块进度 | 能力 `fs.copy`/`fs.move`,大文件进度事件 | 🔵 |
| P6-4 | 文件名自然排序 | `natord` | 列表/排序 "2 file" < "10 file" | 🔵 |
| P6-5 | 磁盘/系统信息 | `sysinfo` | 能力 `sys.disk`(剩余空间、占用统计) | 🔵 |
| P6-6 | 类型识别(MIME) | `infer`(魔数)+ `mime_guess`(扩展名兜底) | 能力 `file.kind`,供预览/图标插件消费 | 🔵 |
| P6-7 | 图像缩略图 | `image` + `fast_image_resize` | 能力 `thumb.image`(解码+高质量缩放);重依赖,按需启用 | 🔵 |
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
| P6-15 | 大文件列表虚拟滚动 | `@tanstack/react-virtual` | 十万级列表不卡 | 🔵 |
| P6-16 | 表格视图(排序/列/选择) | `@tanstack/react-table` | 详情列表模式 | 🔵 |
| P6-17 | 目录树 | `react-arborist`(或 TanStack Virtual 自绘) | 虚拟化树 + DnD/重命名/键盘 | 🔵 |
| P6-18 | 拖拽(移动/排序) | `@dnd-kit/core`(+`sortable`) | 拖文件到目录;无障碍 | 🔵 |
| P6-19 | 快捷键 | `react-hotkeys-hook` | 基座级键位,插件可声明 | 🔵 |
| P6-20 | 图标 | `lucide-react`(+ 文件类型图标 `@vscode/codicons`) | 基座与插件统一图标源,替换现有内联/emoji | 🔵 |
| P6-21 | 日期 & 文件大小格式化 | `dayjs` + `pretty-bytes` | 时间线/列表展示 | 🔵 |
| P6-22 | 代码/文本查看器(预览插件) | `@uiw/react-codemirror`(CodeMirror 6)+ `shiki`(静态高亮) | 只读预览插件;需 VS Code 级编辑再上 Monaco(重,独立插件) | 🔵 |
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
