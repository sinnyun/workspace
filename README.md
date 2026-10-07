# 本地文件管理器(完全插件化版)

一个运行在桌面的本地文件管理器。核心设计目标是**完全插件化**:基座(host)不含任何业务概念,所有功能(文件历史、云同步、预览、批量重命名……)都以插件形式接入。插件分为**后端**(Rust,承载业务逻辑)与**前端**(React/ESM,承载 UI),二者通过事件与能力契约通信,物理上不互相导入。

> 本文档集是这个项目的**事实源**。所有架构与选型决定以这里为准;代码实现必须与文档保持一致,任何决定变更先改文档再改代码。

---

## 技术栈基线(已定案)

| 层 | 选型 | 职责 |
|---|---|---|
| 客户端外壳 | **Tauri v2 (Rust)** | 原生窗口、进程守护、能力层(原子 fs/hash/db 命令)、前后端 IPC 桥 |
| 后端内核 | **cordis-rs**(Cordis v3 运行时的原生 Rust 实现,tokio) | 插件生命周期、依赖注入(Service)、类型化事件管道、Effect 确定性清理、Fiber 隔离 |
| 后端插件 | **静态编译的 Rust crate**(内置/官方) | 业务逻辑;通过 cordis-rs 的 `Plugin` trait 接入 |
| 前端基座 | **React 19 + TypeScript + Vite + Mantine** | 骨架布局、`<PluginSlot>` 插槽、全局元状态、事件总线 |
| 前端插件 | **本地 ESM**,运行时 `import()` 动态加载 | UI 面板;经自定义 Tauri 协议下发,可运行时 drop-in |

**进程模型**:单一 Tauri 进程。Rust 侧同时承载「能力层」与「cordis-rs 内核」;WebView 侧承载 React 基座与前端插件。**没有 Node,没有 sidecar,没有嵌入式 JS 引擎。**

**关键取舍(一句话)**:后端插件是编译进宿主的原生 Rust——安全、快、简单,但新增后端*代码*需要重新构建宿主;真正的运行时可安装扩展放在**前端 ESM + 稳定的 Rust 能力 API** 这一侧。详见 [决策记录](docs/05-decisions.md)。

---

## 文档导航

| 文档 | 内容 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 分层架构、进程模型、cordis-rs 与 Tauri 集成、数据流与事件桥接、解耦红线 |
| [docs/02-plugin-spec.md](docs/02-plugin-spec.md) | 插件规范:manifest、后端 Plugin 契约、前端 activate 契约、能力 API、事件命名、权限模型、全栈示例 |
| [docs/03-project-layout.md](docs/03-project-layout.md) | Monorepo 目录结构、cargo/pnpm 工作区、构建工具链、共享依赖策略 |
| [docs/04-roadmap.md](docs/04-roadmap.md) | 里程碑与任务表(完成条件 + 状态 + 证据)、风险登记、明确不做清单 |
| [docs/05-decisions.md](docs/05-decisions.md) | 关键选型表与决策记录:理由、代价、后果 |
| [docs/06-open-source-stack.md](docs/06-open-source-stack.md) | 分层开源方案选型清单(后端 Rust / 前端 React / 工具链):推荐库 + 理由 + 隔离层原则 |
| [docs/07-cordis-api-memo.md](docs/07-cordis-api-memo.md) | cordis-core API 事实备忘(签名/生命周期/panic 语义);依赖源码仅作 API 参考 |
| [docs/08-plugin-catalog.md](docs/08-plugin-catalog.md) | 插件目录与库分布:每个开源库归到哪个插件/层、插件清单与 manifest 草案、实现顺序 |
| [docs/00-handover.md](docs/00-handover.md) | **开发交接文档**:当前进度快照、已验证证据、在跑任务、剩余任务流程、关键坑与命令 |

---

## 当前仓库状态

代码工程已初始化并跑通主链路(不再是"只有文档")。双工作区(cargo + pnpm)就位,后端内核/能力层、前端基座/插槽/加载器、manifest/SDK/契约/权限、首个全栈插件 file-history 均已落地并有测试或浏览器证据。实现进度与逐项证据以 [docs/04-roadmap.md](docs/04-roadmap.md) 为准;**后续要建的插件生态与库分布见 [docs/08-plugin-catalog.md](docs/08-plugin-catalog.md)**;新对话接手请先读 [docs/00-handover.md](docs/00-handover.md)。

```
workspace/
├── README.md
├── docs/                    # 项目文档集(事实源)
├── Cargo.toml               # cargo 工作区
├── pnpm-workspace.yaml      # pnpm 工作区
├── core-shared/             # contracts(Rust) / kernel(Rust) / plugin-sdk(TS)
├── apps/                    # host(Tauri Rust) / shell-ui(React 前端)
├── plugins/plugin-file-history/  # 首个全栈插件(backend Rust + frontend ESM + manifest)
└── plugins/(规划)file-browser、file-ops、search、preview-*、archive、storage-analysis … 见 08
```

常用命令:

```bash
cargo test --workspace                         # 后端无头测试
pnpm --filter shell-ui build:shared            # 重建共享单例(改 SDK/依赖后)
pnpm --filter shell-ui dev                     # 浏览器 dev(http://localhost:1420)
pnpm --filter shell-ui contract:check          # TS↔Rust 契约一致性
pnpm --filter @my-file-manager/plugin-sdk test # SDK 纯函数单测
```

---

## 术语约定

- **基座 / host**:不含业务概念的最小运行框架(前端 React 骨架 + 后端 Rust 能力层与内核引导)。
- **插件 / plugin**:实现某个业务功能的独立工程,含后端(Rust)与/或前端(ESM)两部分。
- **能力 / capability**:Rust 暴露的原子操作(如 `fs.read_chunk`、`hash.compute`),无业务策略。
- **插槽 / slot**:基座预留的 UI 挂载点(如 `file-sidebar-zone`),前端插件向其注入组件。
- **元状态 / meta-state**:基座唯一持有的一类全局状态(如 `currentFileId`),不含业务语义。
