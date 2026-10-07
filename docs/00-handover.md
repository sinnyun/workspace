# 00 · 开发交接文档

> 本文件是**新对话/新成员接手的单一入口**:当前进度快照、已验证证据、在跑任务、剩余任务流程、关键坑与命令速查。
> 逐项任务状态以 [04-roadmap.md](04-roadmap.md) 为准;架构/规范/选型以 01/02/03/05/06 为准。本文件只描述**当前形态**。

---

## 1 · 项目定位与硬约束

一个**完全插件化的本地文件管理器**桌面应用。基座只持有最小运行框架与元状态,一切业务功能由插件提供。

不可动摇的约束(违反即返工):

- **全新项目**:不参考本机其他项目的资料/路径/结论。`cordis-rs` 仓库仅作为外部依赖 cordis-core 的 **API 事实参考**,不作设计来源。
- **后端 = 原生 Rust + cordis-core(v0.6)**,不是 Node+Cordis。后端插件**静态编译进宿主**(边界 R4:新增后端代码需重建宿主;运行时可安装扩展只在前端 ESM 侧)。
- **前端 = React 19 + Mantine 7 + 本地动态 `import()` 加载 ESM 插件**,不用 Module Federation。
- **优先用开源库**,重依赖外面包一层隔离层(见 06)。
- 能力层只做原子操作、不写业务;基座只持有元状态、不持有业务状态;插件间不物理 import,只经事件/能力/Service 契约。

---

## 2 · 技术栈与模块骨架

**双工作区**:cargo(Rust)+ pnpm(TS/前端)。

| 模块 | 路径 | 职责 |
|---|---|---|
| `fm-contracts` | `core-shared/contracts` | 跨内核↔插件边界的 Rust 单一事实源:typed `Event`、原子能力 trait + `Service` marker + DTO、`manifest::PluginManifest`、`capability::names`、`bin/fm-contract-dump` |
| `fm-kernel` | `core-shared/kernel` | **无 Tauri 依赖**的后端内核:能力实现(fs/hash/db + `watch::WatchHub`)、`Kernel` 引导、后端插件 `registry`、cordis `Logger`→`tracing` 桥(`logger.rs`)。可无头测试 |
| `fm-host` | `apps/host` | 薄 Tauri 壳:`#[command] invoke_capability`、`plugin://` 协议、`EventBridge`(cordis→Tauri emit)、`PluginServer`(前端插件发现/下发) |
| `plugin-file-history-backend` | `plugins/plugin-file-history/backend` | 首个后端插件:订阅 `file:changed`→`hash.compute`→写 `db.history`→`emit history:updated`(幂等) |
| `@my-file-manager/plugin-sdk` | `core-shared/plugin-sdk` | 前端插件**唯一**可依赖包:类型 + `Events`/`Capabilities` + `validateManifest`/`matchesPermission`/`disposer` |
| `shell-ui` | `apps/shell-ui` | React 基座:布局、`PluginSlot`+错误边界、`eventbus`、`slots` 注册表、`loader`、`host`(权限 gating)、`invoke`、共享单例构建 |
| `plugin-file-history/frontend` | 同名 | 首个前端插件:导出 `HistoryPanel`(Mantine Timeline),经插槽挂载 |

**共享单例机制**(前端头号风险点):`scripts/build-shared.mjs` 把 React/Mantine/SDK 预构建成固定名 ESM,`index.html` 的 import map 是**唯一解析点**;宿主与插件都把裸 import 外部化到这些 URL → 全局**一个** React、一个 Mantine。产物分**两套模式一致的变体**:`shared-dist/`(production)与 `shared-dist-dev/`(development)。`vite dev` 经 `devImportMap()` 改写指向 dev 变体;`vite build` 只把 prod 变体 emit 进 `dist/shared/`。

---

## 3 · 当前进度快照

Phase 0–4 主线打通且有证据;Phase 5 基本完成(仅余需显示环境的窗口端到端确认)。

| 阶段 | 状态 | 关键证据(命令) |
|---|---|---|
| Phase 0 基线+风险 | 基本 ✅(P0-2/P0-6 待窗口) | `cargo run -p cordis-boot`;浏览器实测 `import()` 插件+单例 |
| Phase 1 内核+能力 | 核心 ✅(P1-1/3/4/7 待窗口/基准) | `cargo test -p fm-kernel`(backend_slice) |
| Phase 2 前端基座 | ✅ | `vite dev` 浏览器实测(见 §4) |
| Phase 3 规范+SDK+契约+权限 | ✅(P3-5/3-6 未做) | `contract:check`、`plugin-sdk test`、`cargo test -p fm-host` |
| Phase 4 file-history | 前后端各自 ✅(P4-3/4-5 待窗口) | 后端 `backend_slice`;前端浏览器 Timeline 渲染 |
| Phase 5 加固+打包 | 基本 ✅(打包/可观测/契约冻结/权限拒绝/后端错误隔离 均有证据;前端边界待窗口) | `tauri build` 出 NSIS 包;`cargo test -p fm-kernel`(panic_isolation + logger_bridge);`contract:check` |

### 已验证(有可复现证据)

- **后端垂直切片无头测试**:`cargo test -p fm-kernel` 3 项过——`backend_slice`(真内核+真能力+真插件+事件:emit file:changed→写历史→hash 与 `hash.file` 一致→重复 emit 幂等→shutdown 后 `fiber_count==0`);`panic_isolation`(插件 `apply` panic 经 cordis `contained.rs` 收敛为 `Failed`→`spawn_transient` 返回 Err、失败 fiber 不入 roster、同 Kernel 的 file-history 兄弟仍能响应 `file:changed`);`logger_bridge`(经 cordis 原生 `add_exporter`/`Logger` 面注册的 exporter 同步收到带 level/channel/text 的记录,即 P5-3 桥接管道可用)。
- **打包**:`cd apps/host && npx tauri build` 成功产出 `target/release/bundle/nsis/File Manager_0.1.0_x64-setup.exe`(~3.9MB),`fm-host.exe` 16.9MB,`dist/shared/*`(9 文件)随包。
- **manifest schema 校验**:`cargo test -p fm-host --test manifest_schema` 4 项过(内置 manifest 解析+校验;坏 schemaVersion/缺 backend&frontend/缺 permissions 均被拒)。
- **TS↔Rust 契约一致性**:`pnpm --filter shell-ui contract:check` 全 ok(事件名/事件字段/能力名/DTO 字段);**负向验证**:改 SDK 能力名后正确 FAIL。
- **SDK 纯函数单测**:`pnpm --filter @my-file-manager/plugin-sdk test` 5 项过(`matchesPermission` 精确/`.*`/`*`/拒绝、`validateManifest`、`disposer`)。
- **前端基座浏览器实测**(`vite dev` @1420):五区渲染;运行时 `import()` 加载 file-history ESM;选中文件→元状态→`selection:changed`→插件面板经 gated `db.history.list` 渲染 Mantine Timeline(2 条历史);单 React/Mantine 实例(hooks 跨 host/插件不报错)。
- **生产构建**:`vite build` 宿主 bundle 仅 ~16KB(库全外部化),`dist/shared/*` 随包产出;`vite preview` 用 prod 单例正常渲染;插件源缺失时按插件**隔离降级**并 `console.error`,基座继续运行。

### 未验证(诚实标注:本环境无显示器)

Tauri 窗口内的可视化与跨进程段尚未跑通验证,相关项在 04 里标 🟡:P0-2 窗口、P0-6 `plugin://` 本体、P1-1 真 invoke 往返、P1-3 cordis→Tauri→前端跨进程事件、P1-4 真实文件系统触发、P4-3 端到端自动刷新。这些**代码已写、编译通过**,缺 GUI 侧确认。

---

## 4 · 关键工程决策与踩过的坑(接手必读)

1. **共享单例不能放 `public/`**:vite 禁止源码 import `public/` 下文件。改为 `shared-dist(-dev)/` + dev 中间件伺服 + build 时 `generateBundle` emit。
2. **CJS 包要显式命名再导出**:react/react-dom/react-dom/client/jsx-runtime/jsx-dev-runtime 是 CJS,rollup `export *` 不产出静态命名导出 → 构建期枚举运行时 key 生成 `export const X = __d["X"]`。Mantine/SDK 是 ESM,`export *` 即可。
3. **React dev/prod 内部不兼容**:dev 的 `jsxDEV` 依赖 `dispatcher.getOwner`,prod react 没有 → **必须模式一致**。曾把 dev 变体 jsx-dev-runtime 配 prod react,报 `jsxDEV is not a function` / `dispatcher.getOwner is not a function`。解法:两套变体,dev 全 dev、prod 全 prod。宿主 dev 用 `react/jsx-dev-runtime`,prod 用 `react/jsx-runtime`。
4. **`optimizeDeps.noDiscovery`**:否则 vite 预扫描会把外部 `/shared/*` URL 当文件读盘报错。
5. **notify watcher 是 Send 非 Sync**:`WatchHub` 在专用 OS 线程持有 `Debouncer`,只有 mpsc `Sender`(Send+Sync)进 Tauri `State`。
6. **`HostState` 的 PhantomData 用 `fn() -> R`**:`PhantomData<Wry>` 会让 `HostState` 丢 Send+Sync(Wry 非 Sync)。
7. **db 能力名是动态的**(`db.<store>.<op>`),不在 `capability::names` 里;`invoke_capability` 用 `DB_PREFIX` 前缀切分。`watch.subscribe` 已实现(此前 SDK 声明但宿主未路由,是真实契约缺口,已补)。
8. **`eventbus.bridgeBackend` 在非 Tauri 环境要 try/catch 降级**,否则 `listen()` reject 会阻断渲染。
9. **cordis-core 不发 `tracing`/`log`,用自己的 `Logger`**:其诊断(contained panic、dispatch/lifecycle/effect 错误)走 Runtime 级 exporter 集(`Context::add_exporter`)。可观测做法=注册一个把 `LogRecord` 转 `tracing` 事件的 exporter(`fm-kernel::logger::TracingBridge`),由 `LogBridgePlugin` 作为**首个** fiber 发布;注册须在活跃 fiber 的 `apply` 内(root ctx 非活跃),exporter 随该 fiber generation 回收。**注意:插件 `apply`/listener 的 panic 是以 `Err`/`Failed` 形式返回,不走 logger**;只有无返回通道的 fire-and-forget 站点才产 log 记录。

---

## 5 · 当前状态与剩余流程

### 在跑

无。`tauri build`(nsis)已成功产出安装包(见 §3);Phase 5 的代码类子项(错误隔离后端、可观测、契约冻结、权限拒绝路径)均已实现并有证据。

### 剩余任务(建议顺序)

> **既定开源栈接入 backlog = roadmap Phase 6**(见 [04-roadmap.md](04-roadmap.md)):2026-10-08 审计把 [06-open-source-stack.md](06-open-source-stack.md) 的选型逐项转成可执行任务(6A 后端能力 / 6B 前端功能插件 / 6C 质量工具链 / 6D cordis 运行时)。**这些库按插件的分布、要建哪些插件见 [08-plugin-catalog.md](08-plugin-catalog.md)**(库归属分层规则见 [01-architecture.md](01-architecture.md) §8)。以后开发**按 Phase 6 / 08 选用对应开源库**,不自研轮子;新增能力落 `kernel/capabilities` 隔离层、新功能做成前端插件、新契约先两侧同步再跑 `contract:check`。

1. **窗口内端到端(P0-2/P0-6/P1-1/P1-3/P1-4/P4-3/P5-1 前端边界)**:这是**本环境(无显示器)唯一无法验证的一类**。有显示环境时 `cd apps/host && npx tauri dev`,验证 `plugin://` 下发、真 invoke 往返、真实文件改动→watcher→`file:changed`→后端写历史→`history:updated`→Tauri emit→前端总线→Timeline 自动刷新,并加载一个故意抛错的示例插件确认 `PluginErrorBoundary` 只降级该插槽。这是把 §3 里 🟡 项转 ✅ 的唯一途径。
2. **工程化补票(P6-41 / P3-5 / P3-6)**:用 `cordis-loader` 生成声明式加载计划 + `build.rs` 扫描 manifest 自动生成后端注册表(去掉手写 `registry` 漂移;当前仅 1 个后端插件收益有限故暂缓),插件脚手架模板。注:`cordis-loader`/`cordis-timer` 现已在 workspace 声明但**零引用**,这两项转正后消除死声明。
3. **质量工具链(P6-31…40)**:目前**无任何 CI / 提交钩子 / 前端 lint / 依赖审计**。优先补两项——前端 `Biome`(lint+format)与 GitHub Actions(clippy/fmt/`cargo test`/`contract:check`/`typecheck`,发布用 `tauri-action`);再补 `Vitest` 测 `PluginSlot` 错误边界、`cargo-deny` 审计、`lefthook` 钩子。
4. **产品功能扩展(6A + 6B)**:基座文件浏览器是最小可用版,首个插件是 file-history。复制/移动/删除(`trash`/`fs_extra`)、并行遍历(`ignore`+`rayon`)、缩略图(`image`+`fast_image_resize`)、搜索(`tantivy` 或 SQLite FTS5)、预览(`codemirror`/`shiki`/`react-markdown`)、大列表/树(`@tanstack/react-virtual`/`react-arborist`)、命令面板(`@mantine/spotlight`)等——均应以**插件**形式落地并接入 Phase 6 指定库,持续验证架构。

> 注:`tauri.conf.json` 里**没有** `build.windows.staticVCRuntime` 键(该 CLI 版本不接受;`STATIC_VCRUNTIME` 警告是 tauri-build 自身默认,无害)。

---

## 6 · 命令速查

```bash
# 后端
cargo test --workspace                      # 无头测试(backend_slice + manifest_schema)
cargo build -p fm-host                      # 编译宿主
cd apps/host && npx tauri dev               # 真窗口开发(需显示器)
cd apps/host && npx tauri build             # 打包(nsis)

# 前端
pnpm --filter shell-ui build:shared         # 改 SDK/依赖后重建共享单例(两套变体)
pnpm --filter shell-ui dev                  # 浏览器 dev @1420(带 mock + /dev-plugins)
pnpm --filter shell-ui build                # 生产构建(tsc -b + vite build)
pnpm --filter shell-ui preview              # 预览 dist(验证 prod 单例)
pnpm --filter shell-ui typecheck            # tsc --noEmit

# 契约/单测
pnpm --filter shell-ui contract:check                        # TS↔Rust 契约一致性
pnpm --filter @my-file-manager/plugin-sdk test               # SDK 纯函数单测

# 本环境 Windows 沙箱注意(见 user memory)
#   杀端口进程:node -e "process.kill(<PID>)";查端口:netstat -ano | grep :1420(勿加 -p tcp)
```

---

## 7 · 文件地图(高频改动点)

- 契约(改事件/能力/DTO 必**两侧同步** + 跑 `contract:check`):
  `core-shared/contracts/src/{events,capability,manifest}.rs` ↔ `core-shared/plugin-sdk/src/index.ts`
- 共享单例构建:`apps/shell-ui/scripts/build-shared.mjs`、`apps/shell-ui/vite.config.ts`、`apps/shell-ui/index.html`
- 前端加载/权限/插槽:`apps/shell-ui/src/{loader,host,slots,PluginSlot,eventbus,invoke,state}.ts(x)`
- 后端命令/协议/桥:`apps/host/src/{commands,pluginsrv,bridge,lib}.rs`
- 内核/能力/监听:`core-shared/kernel/src/{kernel,registry,logger,capabilities/*}.rs`
- 首个全栈插件:`plugins/plugin-file-history/{manifest.json,backend/src/*,frontend/src/*}`
