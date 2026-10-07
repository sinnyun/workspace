# 03 · 目录结构与工具链

本文定义 Monorepo 的目标布局、双工作区(cargo + pnpm)、构建工具链与共享依赖策略。

> 下面是**目标形态**,当前仓库尚未初始化任何工程。落地顺序见 [04-roadmap.md](04-roadmap.md)。

---

## 1. Monorepo 策略:双工作区

后端是 Rust、前端是 TS,天然需要两套包管理。用**同一个仓库、两个工作区**:

- **cargo workspace**:统管宿主、后端 SDK 契约、所有后端插件 crate。后端插件是 workspace 成员,静态编进宿主。
- **pnpm workspace**:统管前端基座、前端 SDK 契约、所有前端插件。前端插件独立构建为 ESM。

两个工作区在 `plugins/<name>/` 下**物理共存**:同一插件的 `backend/` 属 cargo 工作区、`frontend/` 属 pnpm 工作区,互不干扰。

---

## 2. 目标目录树

```
my-file-manager/
├── Cargo.toml                     # cargo workspace 根
├── package.json                   # pnpm workspace 根(仅工作区声明与脚本)
├── pnpm-workspace.yaml
│
├── apps/
│   ├── host/                      # Tauri v2 宿主(Rust)
│   │   ├── Cargo.toml             # 依赖各后端插件 crate + core-shared/contracts
│   │   ├── build.rs               # 扫描 plugins/*/manifest.json → 生成后端注册表与加载计划
│   │   ├── tauri.conf.json        # frontendDist 指向 apps/shell-ui/dist
│   │   └── src/
│   │       ├── main.rs            # Tauri 入口 + setup 引导
│   │       ├── capabilities/      # 原子能力:fs / hash / db / watch(#[tauri::command])
│   │       ├── kernel/            # cordis-rs:Context 引导、loader 接入、fiber 管理
│   │       ├── bridge/            # 事件桥:cordis Event ↔ Tauri emit ↔ 前端总线
│   │       └── pluginsrv/         # 前端插件下发:扫描目录 + plugin:// 协议 + 权限校验
│   │
│   └── shell-ui/                  # 前端基座(React 19 + Vite)
│       ├── package.json
│       ├── index.html             # 含 import map:react/react-dom/@mantine/* → 宿主单例
│       └── src/
│           ├── main.tsx
│           ├── layout/            # 侧边栏 / 顶栏 / 主视图区骨架
│           ├── PluginSlot.tsx     # 通用插槽组件
│           ├── loader.ts          # 读 manifest → import() 前端插件 → 挂载
│           ├── eventbus.ts        # 前端事件总线(含 Tauri 事件订阅)
│           ├── host.ts            # 构造注入给插件的 PluginHost
│           └── state.ts           # 全局元状态(currentFileId ...)
│
├── core-shared/
│   ├── plugin-sdk/                # TS 契约包(pnpm):PluginHost / SlotProps / 事件负载类型
│   │   ├── package.json           # 包名 @my-file-manager/plugin-sdk
│   │   └── src/index.ts
│   └── contracts/                 # Rust 契约包(cargo):Event / Capability 类型、Service 定义
│       ├── Cargo.toml
│       └── src/lib.rs
│
├── plugins/
│   └── plugin-file-history/
│       ├── manifest.json
│       ├── backend/               # Rust crate(cargo workspace 成员,静态编进 host)
│       │   ├── Cargo.toml         # 依赖 core-shared/contracts + cordis-rs
│       │   └── src/lib.rs         # impl Plugin
│       └── frontend/              # React ESM(pnpm workspace 成员,Vite lib 构建)
│           ├── package.json       # 依赖 plugin-sdk;react/@mantine/* 为 external
│           ├── vite.config.ts     # build.lib → dist/index.js(ESM),externalize react/@mantine
│           └── src/
│               ├── index.tsx      # export activate + 具名组件
│               └── HistoryPanel.tsx
│
└── docs/                          # 本文档集(事实源)
```

---

## 3. 各部分职责

| 路径 | 工作区 | 职责 |
|---|---|---|
| `apps/host` | cargo | Tauri 宿主:能力层 + cordis-rs 内核引导 + IPC/事件桥 + 前端插件下发。**唯一可执行体** |
| `apps/shell-ui` | pnpm | React 基座:布局、插槽、元状态、事件总线、前端插件加载器 |
| `core-shared/plugin-sdk` | pnpm | 前端插件唯一允许依赖的契约包(类型 + 少量运行时 helper) |
| `core-shared/contracts` | cargo | 后端插件唯一允许依赖的契约包(Event/Capability/Service 类型) |
| `plugins/*/backend` | cargo | 后端插件,静态编进 host |
| `plugins/*/frontend` | pnpm | 前端插件,独立构建为 ESM,运行时加载 |

---

## 4. 构建工具链

> 各层具体用哪些开源库(遍历/哈希/DB/UI 组件/虚拟化/查看器…)见 [06-open-source-stack.md](06-open-source-stack.md);本节只讲构建方式。

### 4.1 后端(Rust)
- **cargo workspace** 统一构建。`apps/host` 依赖每个 `plugins/*/backend` crate。
- **启用/禁用**:后端插件以 cargo **feature** 门控(如 `plugin-file-history`),构建期决定哪些插件编入;运行期的启用/禁用(已编入的插件)由 cordis-loader 的加载计划 + fiber dispose 完成。
- **注册表生成**:`apps/host/build.rs` 扫描 `plugins/*/manifest.json`,生成"manifest 名 → Plugin 构造 + 默认 config"的注册表,以及 loader 的加载计划。避免手写、防漂移。
- **无 tsup / 无 Node**:后端不产出 JS,不涉及任何 JS 打包器。

### 4.2 前端基座(React)
- **Vite**(app 模式)构建为静态资源,`tauri.conf.json` 的 `frontendDist` 指向 `apps/shell-ui/dist`,由 Tauri 打进包。

### 4.3 前端插件(ESM)
- **Vite**(library 模式)构建:输出单个 `dist/index.js`(ESM 格式),`react`/`react-dom`/`@mantine/*`/`@my-file-manager/plugin-sdk` 全部 **external**(不打进产物)。
- **无 Module Federation**:插件就是普通 ESM,由基座 `import()` 运行时加载。
- 构建产物随插件目录分发;运行时 host 扫描插件目录,经 `plugin://` 自定义协议把 `dist/index.js` 交给 WebView。

### 4.4 一键脚本(pnpm 根 `package.json`)
- `dev`:并发起 Vite(shell-ui)+ `tauri dev`。
- `build:plugins`:构建所有 `plugins/*/frontend`。
- `build`:构建前端插件 → 构建 shell-ui → `tauri build`(cargo 编入后端插件)。

---

## 5. 共享依赖策略(前端插件的关键)

前端插件运行时 `import 'react'` 必须解析到**宿主基座的同一个 React 实例**,否则会多实例、hooks 报错。UI 组件库 **Mantine** 同理:必须与基座共用一个实例,主题(CSS 变量)才一致、浮层 portal 才正常。方案:

- 在 `apps/shell-ui/index.html` 里放 **import map**,把 `react`、`react-dom`、`react/jsx-runtime`、`@mantine/core`、`@mantine/hooks`(及其它用到的 `@mantine/*` 子包)、`@my-file-manager/plugin-sdk` 映射到基座暴露的单例 URL。
- 前端插件构建时把这些依赖标记为 external,产物里保留裸 `import 'react'` / `import { Button } from '@mantine/core'`,运行时经 import map 落到宿主单例。
- 结果:插件产物极小(只含自己的代码),React 与 Mantine 全局唯一,插件 UI 与基座风格统一。

> `plugin-sdk` 只放**类型 + 无状态 helper**;凡是需要访问基座内部的能力,一律通过 `host` 对象注入,不进 sdk 运行时,避免 sdk 与基座版本耦合。Mantine 组件不算"基座内部能力",插件可直接从共享单例 import 使用。

---

## 6. 契约的单一事实源(TS ↔ Rust)

事件负载与能力参数需要**前端 TS 类型**和**后端 Rust 类型**两端对齐,又不能各写各的导致漂移:

- **当前策略(简单优先)**:在 `core-shared` 里各维护一份(`plugin-sdk` 的 TS 类型 / `contracts` 的 Rust 类型),用一个**契约测试**校验两端的事件名与字段集合一致(测试读同一份 `contracts/events.schema.json`)。
- `events.schema.json` 是事件/能力命名的单一清单源,双端类型都由它对齐;是否上代码生成(TS/Rust codegen)留到确有需要时再决定,初期不引入。

---

## 7. 命名约定

| 对象 | 约定 | 例 |
|---|---|---|
| 插件目录/名 | `plugin-<kebab-name>` | `plugin-file-history` |
| 后端 crate | `plugin-<name>-backend` | `plugin-file-history-backend` |
| 前端包 | `plugin-<name>-frontend` | `plugin-file-history-frontend` |
| 能力 | `domain.action` | `fs.readChunk` / `db.history.list` |
| 事件 | `domain:action`(过去式) | `file:changed` / `history:updated` |
| 插槽 | `<zone>-zone` 或语义名 | `file-sidebar-zone` |

---

## 8. 插件如何被发现

| 端 | 发现时机 | 机制 |
|---|---|---|
| 后端 | **构建期** | cargo workspace 成员 + `build.rs` 扫描 manifest 生成注册表;编入 host 二进制 |
| 前端 | **运行期** | host 扫描插件目录(资源目录 + 用户可写数据目录),经 `plugin://` 协议下发 ESM,基座 `import()` |

这条差异是架构的直接结果:后端插件是原生 Rust,只能构建期内置;前端插件是 ESM,可运行期加载。用户"安装插件"= 放入前端插件目录(可即时生效)+ 依赖已内置的后端能力。详见 [05-decisions.md](05-decisions.md)。
