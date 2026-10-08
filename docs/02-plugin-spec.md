# 02 · 插件规范与 SDK 契约

本文定义"一个插件如何描述自己、如何接入基座"。这是插件作者(含未来的你)唯一需要遵守的契约。

> 代码片段均为**契约示意**。cordis-rs 的确切泛型/错误类型签名以 Phase 0 锁定的 crate 版本为准(见 [04-roadmap.md](04-roadmap.md));前端 host API 的确切类型以 `core-shared` 里最终导出的 `plugin-sdk` 为准。本文定义的是**形状与约束**,不是逐字 API。

---

## 1. 插件的构成

一个插件是一个独立工程,包含三部分(后两者可选,但至少有一个):

```
plugin-<name>/
├── manifest.json      # 必需:自我描述
├── backend/           # 可选:Rust crate(静态编译进宿主)
│   ├── Cargo.toml
│   └── src/lib.rs
└── frontend/          # 可选:React/ESM(运行时 import 加载)
    ├── package.json
    └── src/index.tsx
```

- **纯后端插件**:只有业务逻辑、无 UI(如后台索引、定时清理)。
- **纯前端插件**:只有 UI、复用已内置能力(如一个纯展示的主题面板)。
- **全栈插件**:前后端都有(如 file-history)。前后端**不共享代码/内存**,只经事件与能力契约通信。

> **要建哪些插件、每个插件用哪些开源库**,见 [08-plugin-catalog.md](08-plugin-catalog.md);库该归"基座 / 能力层 / 后端插件 / 前端共享单例 / 前端插件自带"哪一层的规则,见 [01-architecture.md](01-architecture.md) §8。本文只定**单个插件怎么写**(manifest、契约、权限)。

---

## 2. manifest.json 规范

### 2.1 完整示例
```json
{
  "schemaVersion": 1,
  "name": "plugin-file-history",
  "version": "1.0.0",
  "displayName": "文件历史",
  "description": "记录文件内容变更,提供历史时间线",
  "author": "you",
  "minHostVersion": "0.1.0",

  "backend": {
    "crate": "plugin-file-history-backend",
    "enabledByDefault": true,
    "config": { "maxEntriesPerFile": 100 }
  },

  "frontend": {
    "entry": "frontend/dist/index.js",
    "slots": [
      { "id": "file-sidebar-zone", "export": "HistoryPanel" }
    ],
    "provides": []
  },

  "permissions": {
    "capabilities": ["fs.readChunk", "hash.compute", "db.history.*"],
    "events": {
      "subscribe": ["file:changed", "selection:changed"],
      "emit": ["history:updated"]
    },
    "slots": { "contribute": ["file-sidebar-zone"] }
  }
}
```

> `provides` 与 `permissions.slots` 是**容器/嵌套槽**才需要的字段(见 §4.5)。普通插件留空 `provides`,并只在 `permissions.slots.contribute` 里列它注入的基座槽。

### 2.2 字段说明

| 字段 | 必需 | 说明 |
|---|---|---|
| `schemaVersion` | ✓ | manifest 结构版本,当前为 `1`。基座据此做兼容解析 |
| `name` | ✓ | 全局唯一 ID,kebab-case,建议 `plugin-` 前缀 |
| `version` | ✓ | 插件 semver |
| `displayName` / `description` / `author` | | 展示用元信息 |
| `minHostVersion` | | 要求的最低宿主版本;低于则拒绝装载 |
| `backend.crate` | 后端插件✓ | 编译进宿主的 Rust crate 名(与 cargo workspace 成员一致) |
| `backend.enabledByDefault` | | 是否默认启用(用户可在运行时禁用 → dispose fiber) |
| `backend.config` | | 传给 `Plugin::prepare()` 的初始配置 |
| `frontend.entry` | 前端插件✓ | ESM 入口相对路径(相对插件根) |
| `frontend.slots[]` | | 声明要挂载的**基座外层槽**:`id`=槽名,`export`=从 entry 导出的组件名 |
| `frontend.provides[]` | | **容器插件**声明它提供的**嵌套槽前缀**(如 `pane-slot`、`detail-tab`、`preview-zone`、`file-extension-zone`);普通插件省略或空数组 |
| `permissions.capabilities` | ✓ | 允许调用的能力白名单,支持 `*` 通配 |
| `permissions.events.subscribe/emit` | ✓ | 允许订阅/发出的事件白名单 |
| `permissions.slots.contribute[]` | | 允许注入的槽(含他插件提供的嵌套槽)前缀白名单;注入未声明的槽被拒 |

> **权限即契约**:未在 `permissions` 声明的能力调用或事件收发,一律被基座/内核拒绝。这既是安全边界,也让插件依赖关系可静态审计。

---

## 3. 后端插件契约(cordis-rs)

后端插件是一个 Rust crate,实现 cordis-rs 的 `Plugin` trait。生命周期:
```
Config ──prepare()──▶ Input ──Context::spawn()──▶ Fiber(运行中) ──dispose()──▶ Effect 清理
```

### 3.1 必须遵守
- **入口是 `Plugin` 实现**:`type Config`(来自 manifest `backend.config`)、`type Input`(prepare 产物,如已解析的 db 句柄)、`prepare()`(同步、类型化校验)、`apply(ctx, input)`(异步,注册监听/服务)。
- **只能通过 `ctx` 交互**:
  - 订阅事件:`ctx.on::<E, _>(observer)` —— 返回的监听器作为 **Effect** 归属当前 generation,插件 dispose 时自动清理,**禁止手动缓存后不释放**。
  - 发出事件:`ctx.emit::<E>(payload)`。
  - 获取能力:通过 `Service`(依赖注入)拿到能力层句柄,**禁止**直接 `use` 另一个插件的类型。
- **无阻塞**:耗时操作用异步;`apply` 内不得阻塞内核线程。
- **确定性清理**:所有句柄/监听经由 Effect 归属管理,依赖 fiber 卸载自动回收。

### 3.2 骨架示意
```rust
// plugins/plugin-file-history/backend/src/lib.rs  (契约示意)
use cordis_rs::{Context, Plugin};

pub struct FileHistoryPlugin;

pub struct FileHistoryInput {
    db: DbHandle,        // prepare 阶段解析好的能力句柄
}

impl Plugin for FileHistoryPlugin {
    type Config = FileHistoryConfig;   // 反序列化自 manifest.backend.config
    type Input = FileHistoryInput;
    type ApplyError = HistoryError;

    fn prepare(&self, cfg: Self::Config) -> Result<Self::Input, PrepareError> {
        Ok(FileHistoryInput { db: open_history_db(&cfg)? })
    }

    async fn apply(&self, ctx: Context, input: &Self::Input) -> Result<(), Self::ApplyError> {
        let db = input.db.clone();
        // 订阅 file:changed;监听器随本 fiber 的 generation 自动清理
        let _listener = ctx.on::<FileChanged, _>(observer(move |_, payload| {
            let hash = capabilities::hash_compute(&payload.path, "md5")?;
            if db.last_hash(&payload.path)? != Some(hash.clone()) {
                db.append_entry(&payload.path, hash)?;
                ctx.emit::<HistoryUpdated>(HistoryUpdated { path: payload.path });
            }
            Ok(())
        }))?;
        Ok(())
    }
}
```

### 3.3 注册到内核
后端插件不"自己启动",而是被内核按配置 `spawn`。装载计划由 `cordis-rs-loader` 从各插件 manifest 汇总(启用/禁用、config),内核遍历计划 `ctx.spawn(PreparedPlugin::from_input(plugin, input))`。禁用某插件 = 对其 `FiberHandle` 执行 `dispose().await`。

---

## 4. 前端插件契约(ESM + host API)

前端插件是一个 ESM 模块,运行时被基座 `import()`。它**不直接访问** Tauri/React 内部,只通过基座注入的 `host` 对象交互。

### 4.1 入口导出
```ts
// 每个前端插件的 entry 必须导出 activate
export function activate(host: PluginHost): void | (() => void): void;
// 可选:导出在 manifest.slots[].export 里声明的 React 组件
export const HistoryPanel: React.ComponentType<SlotProps>;
```
- `activate(host)` 在插件装载时调用一次。返回值若是函数,作为**卸载钩子**(插件禁用时调用,用于退订/清理)。
- 组件既可在 `activate` 里用 `host.registerSlot` 动态挂载,也可作为具名导出由基座按 `manifest.slots` 挂载。二选一,推荐具名导出(更可静态审计)。

### 4.2 PluginHost API(基座注入)
```ts
interface PluginHost {
  // —— UI:注入基座外层槽(既有)——
  registerSlot(slotId: string, component: React.ComponentType<SlotProps>): () => void;

  // —— UI:嵌套槽(容器插件提供 / 内容插件注入,见 §4.5)——
  // 容器插件:声明并渲染一个动态槽出口(返回一个 React 出口组件),id 形如 `pane-slot:0`
  provideSlot(id: string): React.ComponentType<{ id: string }>;
  // 内容插件:把组件注入某个槽(基座外层槽或他插件的嵌套槽)
  contributeToSlot(id: string, component: React.ComponentType<SlotProps>): () => void;

  // —— 事件(前端总线,含桥接来的后端事件)——
  on<T = unknown>(event: string, handler: (payload: T) => void): () => void; // 返回退订
  emit(event: string, payload?: unknown): void;

  // —— 能力(受 permissions 白名单约束)——
  invoke<T = unknown>(capability: string, args?: Record<string, unknown>): Promise<T>;

  // —— 元状态(只读)——
  getState(): HostMetaState;
  onStateChange(cb: (s: HostMetaState) => void): () => void;
}

interface SlotProps { host: PluginHost; slotId: string; }   // 插槽组件拿到的 props

// 基座只存不透明引用,不解释 kind 的业务含义(见 01 §9.2)
interface Ref { kind: string; id: string; sourcePlugin: string; }
interface HostMetaState {
  activeTabId: string;                    // 顶部浏览会话
  activeSidebarView: string;              // A 选中的侧栏视图
  sidebarSelection: Ref | null;           // B 选中项(驱动 C)
  focusRef: Ref | null;                   // C 最后交互对象(驱动 D)
  activeDetailTab: string;                // D 当前 tab
}
```

### 4.3 必须遵守
- **只经 host**:不得 `import` 另一个插件;不得直接调 `window.__TAURI__`;不得持有全局可变状态污染基座。
- **能力受白名单约束**:`host.invoke` 的 capability 必须在 manifest `permissions.capabilities` 内,否则 reject。
- **清理由自己负责**:`on` / `registerSlot` / `onStateChange` 返回的退订函数,必须在卸载钩子里调用。
- **样式隔离**:UI 统一用 Mantine(共享单例);插件自定义样式走 CSS Modules。不用 Shadow DOM 包裹插槽(Mantine 浮层经 portal 渲染到 body,会丢样式)。

### 4.4 骨架示意
```tsx
// plugins/plugin-file-history/frontend/src/index.tsx  (契约示意)
import type { PluginHost, SlotProps } from '@my-file-manager/plugin-sdk';
import { HistoryPanel } from './HistoryPanel';

export function activate(_host: PluginHost) {
  // 组件走具名导出,由基座按 manifest.slots 挂到 file-sidebar-zone
}
export { HistoryPanel };

// HistoryPanel.tsx
export function HistoryPanel({ host }: SlotProps) {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    const file = host.getState().focusRef?.id;                // 焦点文件(不透明引用)
    const reload = () => file && host.invoke<Entry[]>('db.history.list', { path: file }).then(setEntries);
    reload();
    const off1 = host.on('history:updated', reload);          // 后端事件驱动刷新
    const off2 = host.onStateChange(reload);                  // 焦点变化时刷新
    return () => { off1(); off2(); };                          // 必须清理
  }, [host]);
  return <Timeline entries={entries} />;
}
```

### 4.5 嵌套槽与容器插件(务实版)

默认模型是"基座预留外层槽、插件注入"(§4.1 的 `registerSlot`)。界面级联(01 §9)需要**容器插件再向下提供槽**给别的插件,故引入受控的**嵌套槽**——仅两个框架容器用到,不开放给一般业务插件滥用。

**角色**
- **容器插件**:在 manifest `frontend.provides` 声明它提供的**槽前缀**(如 `pane-slot`、`detail-tab`、`preview-zone`、`file-extension-zone`)。运行时用 `host.provideSlot('pane-slot:0')` 拿到一个出口组件并渲染;出口 id 可动态生成。
- **内容插件**:用 `host.contributeToSlot('pane-slot:0', Comp)` 注入。目标槽若是他插件提供的嵌套槽,须在 `permissions.slots.contribute` 里列出该前缀,否则被拒。

**生命周期事件(基座总线,前端内)**
| 事件 | 源 | 负载 | 语义 |
|---|---|---|---|
| `slot:registered` | 容器 | `{ slotId }` | 出口挂载,内容插件可注入 |
| `slot:reconfigured` | 容器 | `{ slotId, action:'add'\|'remove' }` | 分栏增删 / tab 增删 |
| `slot:disposed` | 容器 | `{ slotId }` | 出口卸载,注入方须干净退场 |

**稳定 paneId 与子树迁移(切换不丢状态的关键)**
- 分栏容器为每栏分配**稳定 `paneId`**;切换 `layoutMode`(1↔2↔4 栏)时按 `paneId` **复用/移动 React 子树**,不销毁重建 → 每栏局部状态(滚动、选择、当前路径)保留。
- 关闭某栏 → 发 `slot:disposed`,该栏内容插件卸载;其余栏不受影响。这是"各区域各管各状态、切换不混乱"的落地保证。

**边界**:容器插件只管**几何与承载**(栏数、宽高、tab 条、出口),不碰内容插件的业务数据;内容插件不感知自己处在哪一分栏布局,只认 `slotId`。

---

## 5. 能力 API(Atomic Capabilities)

能力是 Rust 暴露的原子操作,**无业务策略**。每个能力有两个投影:
- 对**前端**:`#[tauri::command]`,经 `host.invoke(name, args)` 调用,名字用点号 `domain.action`。
- 对**后端**:以 cordis-rs `Service` 提供的进程内函数,后端插件经 DI 获取后直接调用(非 IPC)。

### 5.1 命名与初始清单(基座内置)
| 能力 | 前端 invoke 名 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| 读分块 | `fs.readChunk` | `{path, offset, len}` | `bytes/base64` | 大文件分块读 |
| 列目录 | `fs.list` | `{path, recursive?}` | `Entry[]` | 多线程遍历 |
| 文件元信息 | `fs.stat` | `{path}` | `Stat` | size/mtime/... |
| 计算哈希 | `hash.compute` | `{path, algo}` | `hex` | 流式分块,md5/blake3... |
| 监听变更 | `watch.subscribe` | `{path}` | 建立监听,变更走 `file:changed` 事件 | 基于 notify |
| DB 查询 | `db.<store>.list/get` | store 相关 | JSON | 各插件的存储分区 |
| DB 写入 | `db.<store>.put/append` | store 相关 | ack | |

> `db.<store>.*` 中的 `<store>` 是插件命名空间(如 `db.history.*`),由内核做存储隔离与权限校验。能力清单会随基座演进;**新增能力属于基座变更,需重新构建宿主**。

### 5.2 约束
- 能力函数**必须无副作用策略**:只做 IO/计算,不做"如果是历史插件就……"这类判断。
- 能力**必须可 JSON 序列化**参数与返回(跨 IPC)。
- 能力名与权限白名单使用同一套 `domain.action` 命名。

---

## 6. 事件约定

### 6.1 命名
`domain:action`,action 用过去式动词,表示"已发生的事实":
- `file:changed`、`file:created`、`file:deleted`
- `selection:changed`(前端元状态)
- `history:updated`(插件领域事件)

### 6.2 负载
- 必须可 JSON 序列化。
- 建议每个事件在 `core-shared` 里定义 TS 类型 + Rust 类型,双端对齐(单一 schema 源,见 [03-project-layout.md](03-project-layout.md))。

### 6.3 后端事件 ↔ 前端事件
- 后端 `ctx.emit::<E>()` 的领域事件,由内核**事件桥**转成 Tauri 事件,前端总线以**同名**字符串广播。
- 前端 `host.emit()` 的事件默认只在前端总线内传播;若需通知后端,须走 `invoke` 一个显式能力/命令,不得隐式穿到后端。

### 6.4 内置事件(基座保证存在)
| 事件 | 源 | 负载 | 说明 |
|---|---|---|---|
| `selection:changed` | 前端基座 | `{ fileId: string \| null }` | 旧元状态事件(等价 `focus:changed` 的文件子集,保留兼容) |
| `file:changed` | 能力层 watch | `{ path, kind }` | 文件系统变更 |

**级联协调事件(前端总线,基座搬运不透明引用;见 01 §9.2 / §4.5)**——仅在前端传播,不跨 IPC,故只落在 `plugin-sdk`(TS),不需 Rust 契约:
| 事件 | 源 | 负载 | 说明 |
|---|---|---|---|
| `tab:activated` | 基座(顶部会话) | `{ tabId }` | 切换浏览会话,整组快照还原 |
| `sidebar:view:changed` | A 活动栏 | `{ viewId }` | 选侧栏视图 → 决定 B 内容 |
| `sidebar:selection:changed` | B 侧栏 | `Ref \| null` | B 选中项 → 驱动 C |
| `focus:changed` | C 主视图 | `Ref \| null` | 最后交互对象 → 驱动 D |
| `detail:tab:changed` | D 容器 | `{ tabId }` | D 当前 tab |
| `slot:registered` / `slot:reconfigured` / `slot:disposed` | 容器插件 | 见 §4.5 | 嵌套槽生命周期 |

`Ref = { kind, id, sourcePlugin }`。`kind` 的取值(`file`/`folder`/`tag`/`collection`/`program`…)是**业务语义**,由解释它的插件约定,基座不枚举。

---

## 7. 版本与兼容

- `manifest.schemaVersion`:结构版本,基座按版本解析。
- `minHostVersion`:插件要求的最低宿主版本。
- **能力 API 版本**:能力清单是宿主的一部分;前端插件只能依赖其 `minHostVersion` 对应宿主已提供的能力。运行时 `invoke` 未知能力 → reject 并报清晰错误。
- cordis-rs 属**早期活跃**依赖(v3 线,更新频繁),后端 SDK 需在 `core-shared` 里做一层薄封装隔离其 API 变动(见 roadmap 风险登记)。

### 7.1 契约冻结 v1

以下面在 v1 冻结,变更须走版本流程(提升 `schemaVersion` 并保持旧版本可解析),不得静默改形状:

| 契约面 | v1 冻结内容 | 事实源(改代码即改这里) |
|---|---|---|
| manifest 结构 | `schemaVersion == 1`;字段见 §2.2 | Rust `fm_contracts::manifest::SCHEMA_VERSION` + `PluginManifest::validate`;TS `MANIFEST_SCHEMA_VERSION` + `validateManifest` |
| 能力名 | `fs.home`/`fs.list`/`fs.stat`/`fs.readChunk`/`fs.readText`/`hash.compute`/`watch.subscribe`/`db.<store>.*` | Rust `fm_contracts::capability::names`;TS SDK `Capabilities` |
| 事件名 + 负载 | `file:changed`、`history:updated`(前端另有 `selection:changed`) | Rust `fm_contracts::events`(`Service`/`Event` 的 `const NAME` + args 结构);TS SDK 事件类型 |
| DTO 形状 | `ListEntry`/`StatOut`/`ReadChunkOut`(camelCase) | Rust serde 结构;TS SDK 接口 |

**漂移防护**:`apps/shell-ui/scripts/contract-check.mjs`(`pnpm -C apps/shell-ui contract:check`)以 Rust `fm-contract-dump` 为权威、静态解析 TS SDK,比对事件名/负载、能力名、DTO 字段;不一致即退出非零。新增/改名契约项时,两侧同步后跑该命令作为冻结回归。

**v1 内的向后兼容增补**(不升 `schemaVersion`,但 `validate` 须接受其缺省):
- manifest 新增可选字段 `frontend.provides`、`permissions.slots.contribute`(缺省=空)。
- `HostMetaState` 由 `{ currentFileId }` 扩为 `{ activeTabId, activeSidebarView, sidebarSelection, focusRef, activeDetailTab }`(§4.2);`selection:changed` 保留。
- §6.4 的**级联协调事件**与 §4.5 的**嵌套槽生命周期事件**是**前端总线专用**,只在 `plugin-sdk`(TS)定义,不进 Rust 契约、不参与 `contract:check`(该命令只管跨 IPC 的能力/领域事件/DTO)。

---

## 8. 校验点(基座/内核强制)

| 时机 | 校验 |
|---|---|
| 装载后端插件 | crate 在编译期已内置;manifest 与 loader 计划一致;config 反序列化通过 |
| spawn 前 | `permissions` 合法;事件/能力白名单解析 |
| 装载前端插件 | `schemaVersion` 支持;`minHostVersion` 满足;entry 可 import;slots 目标存在 |
| 容器 `provideSlot` | 槽前缀 ∈ 本插件 manifest `frontend.provides`,否则拒绝提供 |
| 内容 `contributeToSlot` | 目标槽前缀 ∈ `permissions.slots.contribute`(他插件嵌套槽须显式授权),否则拒绝注入 |
| 运行时 `invoke` | capability ∈ 白名单,否则 reject |
| 运行时 `emit/on` | event ∈ 白名单,否则忽略并告警 |
| 卸载 | 调用前端卸载钩子 / dispose 后端 fiber,校验 Effect 全部回收 |
