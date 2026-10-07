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
│  │   · 布局骨架:侧边栏 / 顶栏 / 主视图区                            │ │
│  │   · <PluginSlot name=... />  插槽                                │ │
│  │   · 全局元状态 (currentFileId ...)                               │ │
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
- 基座维护的全局元状态(如 `currentFileId`)变化时,通过前端事件总线广播;前端插件订阅。**基座不把元状态推给后端**,后端若需要,由插件显式 `invoke` 上报。

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
   - 基座不知道"文件有历史版本""文件可上云"等业务概念。基座只维护 `currentFileId` 这类**全局元状态**。业务数据全部由插件订阅元状态后自行维护。

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
