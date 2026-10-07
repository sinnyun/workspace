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

**代价**:隔离弱于 iframe,需靠 host API 收口 + 权限白名单 + 样式隔离(Mantine 共享单例 + CSS Modules;不用 Shadow DOM,因 Mantine 浮层走 portal)兜底(→ R5)。共享依赖(React/Mantine)版本靠 import map 约定。

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
