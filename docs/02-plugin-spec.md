# 02 · 插件规范与 SDK 契约

本文定义"一个插件如何描述自己、如何接入基座"。这是插件作者(含未来的你)唯一需要遵守的契约。

> 代码片段均为**契约示意**。cordis-rs 的确切泛型/错误类型签名以 Phase 0 锁定的 crate 版本为准(见 [04-roadmap.md](04-roadmap.md));前端 host API 的确切类型以 `core-shared` 里最终导出的 `plugin-sdk` 为准。本文定义的是**形状与约束**,不是逐字 API。

> 本文是插件运行时与机器接口规范。逐个插件的完整用户流程、交互状态、动效、持久化及跨插件数据流见 [09-plugin-functional-spec.md](09-plugin-functional-spec.md)；插件职责、插槽与依赖库目录见 [08-plugin-catalog.md](08-plugin-catalog.md)。

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
      { "id": "detail-tab:history", "export": "HistoryPanel", "label": "历史" }
    ],
    "provides": []
  },

  "permissions": {
    "capabilities": ["fs.readChunk", "hash.compute", "db.history.*"],
    "events": {
      "subscribe": ["file:changed", "selection:changed"],
      "emit": ["history:updated"]
    },
    "slots": { "contribute": ["detail-tab:history"] }
  }
}
```

> `provides` 与 `permissions.slots` 是**容器/嵌套槽**才需要精确填写的字段(见 §4.5)。普通插件留空 `provides`;注入他插件提供的嵌套槽时,`permissions.slots.contribute` 列目标 id 或前缀通配(`pane-slot:*`)。外壳槽注入(`main-view-zone` 等)同样要在 `contribute` 里授权。

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
| `frontend.slots[]` | | 声明要挂载的**基座外层槽**或**容器嵌套槽**:`id`=槽名,`export`=从 entry 导出的组件名,`label`=该贡献的**展示名**(可选,如 `"历史"`;容器用它给 tab/入口题名,见 §4.5) |
| `frontend.provides[]` | | **容器插件**声明它提供的**嵌套槽前缀**(如 `pane-slot`、`nav-panel`、`detail-tab`、`preview-zone`、`file-extension-zone`、`settings-page`);普通插件省略或空数组 |
| `permissions.capabilities` | ✓ | 允许调用的能力白名单,支持 `*` 通配 |
| `permissions.events.subscribe/emit` | ✓ | 允许订阅/发出的事件白名单 |
| `permissions.slots.contribute[]` | | 允许注入的槽(含他插件提供的嵌套槽)前缀白名单;注入未声明的槽被拒 |
| `permissions.contextMenu.open/contribute` | | 规划字段；分别授权表面插件请求右键面板、业务插件注册右键动作；默认拒绝，插件卸载时撤销注册 |

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
  readonly name: string;            // 本插件 manifest 名 = 发布 Ref 时的 sourcePlugin

  // —— UI:注入基座外层槽(既有)——
  registerSlot(slotId: string, component: React.ComponentType<SlotProps>): () => void;

  // —— UI:嵌套槽(容器插件提供 / 内容插件注入,见 §4.5)——
  // 容器插件:声明并渲染一个动态槽出口(返回一个 React 出口组件),id 形如 `pane-slot:p0`
  provideSlot(id: string): React.ComponentType<{ id: string }>;
  // 内容插件:把组件注入某个槽(基座外层槽或他插件的嵌套槽)
  contributeToSlot(id: string, component: React.ComponentType<SlotProps>): () => void;

  // —— UI:运行时寻址(只返回槽 id 或标签字符串,不返回组件或数据)——
  contributedSlots(prefix?: string): string[];   // 已有内容的槽(容器的 tab 条据此生成)
  providedSlots(prefix?: string): string[];       // 容器当前已挂载的出口(内容插件据此逐栏注入)
  onSlotsChange(cb: () => void): () => void;      // 注册表变化(挂载/卸载/注入/移除)
  slotLabel(slotId: string): string | undefined;  // 贡献者为自己那个槽声明的显示名(manifest `slots[].label`)

  // —— UI:应用级右键菜单(规划，见 P6-72；动作回调归注册插件所有)——
  contextMenu: {
    open(context: ContextMenuOpenContext): void; // 内容区域请求框架显示面板
    registerItem(item: ContextMenuItem): () => void; // 返回卸载句柄
  };

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

interface ContextMenuContext {
  surfaceId: string;
  targetKind: string;
  targetRef: Ref | null;
  selectedRefs: Ref[];
  sessionId: string;
  paneId?: string;
  anchor: { x: number; y: number };
  trigger: 'pointer' | 'keyboard' | 'accessibility';
}
type ContextMenuOpenContext = Omit<ContextMenuContext, 'trigger'> & { trigger?: ContextMenuContext['trigger'] };
interface ContextMenuItem {
  id: string;
  label: string;
  icon?: string;
  group?: string;
  order?: number;
  when(context: ContextMenuContext): boolean;
  enabled(context: ContextMenuContext): boolean | { enabled: false; reason: string };
  execute(context: ContextMenuContext, signal: AbortSignal): void | Promise<void>;
}

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
- **UI 样式统一**:UI 统一用 Mantine(共享单例);颜色、字体、圆角、阴影、焦点与常用控件风格由基座 Mantine 主题集中管理。插件交互优先使用 Mantine 组件，专用内容/虚拟行的局部结构与状态样式引用 Mantine 主题变量。布局 CSS 负责几何、滚动与响应式规则；插件不得另造全局调色板或全局组件皮肤。不用 Shadow DOM 包裹插槽(Mantine 浮层经 portal 渲染到 body,会丢样式)。
- **主题**:亮/暗由基座的 `MantineProvider` 管(`defaultColorScheme="light"`),插件直接用 `useMantineColorScheme`——React/Mantine 是单例,所以插件与基座读的是**同一份**配色状态,无需自定义事件。颜色一律取 Mantine CSS 变量(`var(--mantine-color-body)`、`var(--mantine-color-dimmed)`…),**不得**写死亮色专属值(如 `--mantine-color-gray-0`),否则暗色下错位。

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

### 4.5 嵌套槽与容器插件(已落地)

默认模型是"基座预留外层槽、插件注入"(§4.1 的 `registerSlot`)。界面级联(01 §9)需要**容器插件再向下提供槽**给别的插件,故引入受控的**嵌套槽**——目前只有四个容器用到(三个界面框架容器 + 设置悬浮面板容器),不开放给一般业务插件滥用。

**角色**
- **容器插件**:在 manifest `frontend.provides` 声明它提供的**槽前缀**(现为 `pane-slot`、`nav-panel`、`detail-tab`/`preview-zone`/`detail-info-zone`/`file-extension-zone`、`settings-page`)。运行时用 `host.provideSlot('pane-slot:p0')` 拿到一个出口组件并渲染;出口 id 由容器自己生成并可动态增长。
- **内容插件**:用 `host.contributeToSlot('pane-slot:p0', Comp)` 注入。目标槽若是他插件提供的嵌套槽,须在 `permissions.slots.contribute` 里列出该前缀(如 `pane-slot:*`),否则被拒。

**生命周期事件(基座总线,前端内)**
| 事件 | 源 | 负载 | 语义 |
|---|---|---|---|
| `slot:registered` | **基座槽运行时**(随出口挂载) | `{ slotId }` | 出口已存在,内容插件可注入 |
| `slot:disposed` | **基座槽运行时**(随出口卸载) | `{ slotId }` | 出口消失,注入方须干净退场 |
| `slot:reconfigured` | **容器插件**(按意图) | `{ slotId, action:'add'\|'remove' }` | 分栏/tab 集合增删的**业务声明**;容器不需要订阅 registered/disposed,也不必在 manifest 里声明前两者 |

registered/disposed 由框架发(它们就是挂载事实),reconfigured 由容器发(它是容器意图)——两侧来源不同,内容插件因此只需观察挂载事实即可自动跟随,不需要理解容器的布局语义。

**发现而非轮询(内容插件的跟随模式)**
```ts
// plugin-file-browser:每栏一个独立实例
const offs = [
  host.on<SlotRegisteredArgs>(Events.slotRegistered, (e) => adopt(e.slotId)),
  host.on<SlotDisposedArgs>(Events.slotDisposed, (e) => drop(e.slotId)),
];
for (const id of host.providedSlots("pane-slot")) adopt(id);   // 已存在的栏
// adopt 内:slotPrefix(id) === host 授权前缀 且 id 尚未持有本插件实例时才注入
```
容器侧同理:`host.contributedSlots("detail-tab")` 生成 tab 条,`onSlotsChange` 驱动重渲染。**这三面只返回/通知槽地址,不暴露组件或数据**,内容插件不得反过来扒容器 React 内部。

**标题由贡献者声明(不靠容器硬编码)**:tab/入口叫什么,是内容插件自己的元信息,写在 manifest `frontend.slots[].label`(可选,空白值装载期即拒),基座把它随注册项一起带进注册表,容器经 `host.slotLabel('detail-tab:history')` 取用;缺 `label` 时容器才回落槽名。这样**加一个 tab 不需要改容器**,而容器也无需读任何业务数据——标签是寻址层的元信息,不属于内容。同理,槽内**区域**的中文名(如 `插件预留`/`预览`/`属性信息`)由容器自己声明,因为那些区域是容器提供的。

**出口按需挂载(lazy outlet)**
容器**不得**预先把所有可能的出口都挂上(例如预建 4 个隐藏 `pane-slot`)。用户切到 2×2 时才 `provideSlot('pane-slot:p2'/'p3')`,并同时发 `slot:reconfigured{action:'add'}`;关闭栏时移出口并发 `{action:'remove'}`。隐藏 ≠ 未挂载:布局收缩期真正不可见的栏仍保留出口与实例,只是 `display:none`。

**稳定 paneId 与子树迁移(切换不丢状态)**
- 分栏容器为每栏分配**稳定 `paneId`**(`p0/p1/…`,只增不复用);状态里持久化 `ids[]` + `mode`,布局用**同一个 keyed 子节点数组**渲染所有活跃面板,由 `grid-area` 决定位置,不可见者靠 `display:none` 退出布局。React 按 key 移动子树而非销毁重建 → 每栏局部状态(滚动、选择、当前目录)保留。
- 关闭某栏 → 该栏出口卸载并发 `slot:disposed`,其内容插件实例退场;其余栏不受影响。
- **会话隔离**:面板出口集合按 `activeTabId` 归属(`key={tabId}` 的网格),两个会话不会共享同一个 `pane-slot:p0`;内容插件的每栏路径记忆也必须以 `会话|槽id` 为键,不然切会话会串。

**互斥由容器负责,不靠面板 self-hide**
B 区一次只显示一个视图,这是**容器 `plugin-layout-views` 的职责**:它渲染所有 `nav-panel:<viewId>` 出口,把 `meta.activeSidebarView` 之外的一律 `display:none`。视图插件**不得**再写 `if (view !== "…") return null`——那种写法一旦有插件忘写就破坏互斥,且互斥规则散落在各插件里。同理 D 的 tab 显隐由 `plugin-inspector` 负责。

**边界**:容器插件只管**几何与承载**(栏数、宽高、tab 条、出口),不碰内容插件的业务数据;内容插件不感知自己处在哪一分栏布局,只认 `slotId`。基座红线 2(不持业务状态)要求下,地址栏、目录列表、选择集一类的内容状态必须住在内容插件里(如 `plugin-file-browser` 的 `fm.file-browser.v1`),而非基座。


---

## 5. 能力 API(Atomic Capabilities)

能力是 Rust 暴露的原子操作,**无业务策略**。每个能力有两个投影:
- 对**前端**:`#[tauri::command]`,经 `host.invoke(name, args)` 调用,名字用点号 `domain.action`。
- 对**后端**:以 cordis-rs `Service` 提供的进程内函数,后端插件经 DI 获取后直接调用(非 IPC)。

### 5.1 命名与初始清单(基座内置)
| 能力 | 前端 invoke 名 | 参数 | 返回 | 说明 |
|---|---|---|---|---|
| 主目录 | `fs.home` | `{}` | `path` | 起始目录(provider 决定) |
| 列目录 | `fs.list` | `{path, recursive?}` | `Entry[]` | **provider 负责顺序**(自然序、忽略大小写)与 `modifiedMs`,浏览器不再排序 |
| 文件元信息 | `fs.stat` | `{path}` | `Stat` | size/mtime/... |
| 读分块 | `fs.readChunk` | `{path, offset, len}` | `bytes/base64` | 大文件分块读 |
| 读文本 | `fs.readText` | `{path}` | `text` | 二进制格式直接 reject,由 UI 显示中文错误 |
| 计算哈希 | `hash.compute` | `{path, algo}` | `hex` | 流式分块,md5/blake3... |
| Windows 系统缩略图 | `shell.thumbnail.read` | `{path, edge, cacheOnly?}` | `ThumbnailOut{resource,edge,state}`（DTO 待冻结） | Windows Shell `IThumbnailCache`/系统 handler；不由应用解码或生成；非 Windows 返回 unsupported |
| 监听变更 | `watch.subscribe` | `{path}` | 建立监听,变更走 `file:changed` 事件 | 基于 notify |
| DB 查询 | `db.<store>.list/get` | store 相关 | JSON | 各插件的存储分区 |
| DB 写入 | `db.<store>.put/append` | store 相关 | ack | |

> `db.<store>.*` 中的 `<store>` 是插件命名空间(如 `db.history.*`),由内核做存储隔离与权限校验。能力清单会随基座演进;**新增能力属于基座变更,需重新构建宿主**。
>
> 缩略图一律走 `shell.thumbnail.read`(受 `permissions.capabilities` 门控)，通过 Windows Shell 读取系统缩略图；不得使用裸 `file:`/asset URL 或应用生成图像。统一预览内容另使用路径绑定、只读、短时授权的预览资源句柄，详情见 [`plugin-preview`](plugin-functional/plugin-preview.md)。

### 5.2 约束
- 能力函数**必须无副作用策略**:只做 IO/计算,不做"如果是历史插件就……"这类判断。
- 能力**必须可 JSON 序列化**参数与返回(跨 IPC)。
- 能力名与权限白名单使用同一套 `domain.action` 命名。

### 5.3 基座前端能力(不跨 IPC,不进 Rust 契约)

有极少量能力的**提供方就是前端基座自己**——它们要读写的状态只存在于浏览器运行态里,后端无从知道。它们与内核能力**同名规则、同一套门控**(`permissions.capabilities` 白名单 + `host.invoke`),只是 `invokeCapability` 先查基座注册表,命中就不走 Tauri `invoke`:

| 能力 | 参数 | 返回 | 提供方 | 说明 |
|---|---|---|---|---|
| `plugins.list` | `{}` | `PluginInfo[]`(`{name, displayName?, version, description?, enabled, protected}`) | `shell-ui` 的 `loader` | 列出已发现的前端插件及其**运行态**(是否装载) |
| `plugins.setEnabled` | `{name, enabled}` | `PluginInfo[]`(新列表) | 同上 | 关闭 = 调用该插件的卸载钩子并回收其槽;开启 = 立即装载,**对当前界面即时生效**并持久化 `fm.plugins.disabled.v1`,下次启动仍然有效 |

- **`protected` 由基座判定**(三个界面框架容器 + 设置面板容器不可关闭),**不来自 manifest**——否则任何插件都能声明自己豁免,破坏"基座最小、其余皆可插拔"的边界。
- 这两项住在 SDK 的 `FrontendCapabilities` / `PluginInfo` / `PluginSetEnabledArgs`,**故意不并进 `Capabilities`**:`contract:check` 拿 Rust `capability::names` 与 `Capabilities` 做全等比对,基座前端能力没有(也不该有)Rust 对应物。名字稳定性由 SDK 单测守住。
- 新增此类能力属于**基座变更**(改 `loader`/`invoke`),不需要重建 Rust 宿主。

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
| `slot:registered` / `slot:disposed` | 基座槽运行时(出口挂载/卸载) | `{ slotId }` | 嵌套槽生命周期事实,见 §4.5 |
| `slot:reconfigured` | 容器插件 | `{ slotId, action }` | 容器声明的分栏/tab 集合增删意图 |

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
| 能力名 | `fs.home`/`fs.list`/`fs.stat`/`fs.readChunk`/`fs.readText`/`hash.compute`/`thumb.image`（迁移替换为 `shell.thumbnail.read`）/`watch.subscribe`/`db.<store>.*`(基座前端能力另列,见 §5.3) | Rust `fm_contracts::capability::names`;TS SDK `Capabilities` |
| 事件名 + 负载 | `file:changed`、`history:updated`(前端另有 `selection:changed`) | Rust `fm_contracts::events`(`Service`/`Event` 的 `const NAME` + args 结构);TS SDK 事件类型 |
| DTO 形状 | `ListEntry`(含 `modifiedMs`)/`StatOut`/`ReadChunkOut`/`ThumbOut`(camelCase) | Rust serde 结构;TS SDK 接口 |

**漂移防护**:`apps/shell-ui/scripts/contract-check.mjs`(`pnpm -C apps/shell-ui contract:check`)以 Rust `fm-contract-dump` 为权威、静态解析 TS SDK,比对事件名/负载、能力名、DTO 字段;不一致即退出非零。新增/改名契约项时,两侧同步后跑该命令作为冻结回归。

**v1 内的向后兼容增补**(不升 `schemaVersion`,但 `validate` 须接受其缺省):
- manifest 新增可选字段 `frontend.provides`、`permissions.slots.contribute`(缺省=空)。
- `HostMetaState` 由 `{ currentFileId }` 扩为 `{ activeTabId, activeSidebarView, sidebarSelection, focusRef, activeDetailTab }`(§4.2);`selection:changed` 保留。
- `PluginHost` 加**只寻址**的发现面 `name`/`contributedSlots(prefix?)`/`providedSlots(prefix?)`/`onSlotsChange(cb)`(§4.2、§4.5);它们不改变任何已冻结形状,容器与内容插件靠它们跟随动态槽,无需理解彼此内部。
- §6.4 的**级联协调事件**与 §4.5 的**嵌套槽生命周期事件**是**前端总线专用**,只在 `plugin-sdk`(TS)定义,不进 Rust 契约、不参与 `contract:check`(该命令只管跨 IPC 的能力/领域事件/DTO)。
- §5.3 的**基座前端能力**(`plugins.list`/`plugins.setEnabled`)同上:提供方在前端,没有 Rust 对应物,故住在独立的 `FrontendCapabilities` 常量里而非 `Capabilities`——`Capabilities` 必须继续与 `capability::names` 全等。附带新增的 `PluginInfo`/`PluginSetEnabledArgs` 也只是 TS 侧形状。

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
| `invoke` 启停他人 | `plugins.setEnabled` 的 `name` 若是基座判定的**核心插件**(三容器 + 设置面板),loader 直接返回中文错误,不执行 |
| 运行时 `emit/on` | event ∈ 白名单,否则忽略并告警 |
| 卸载 | 调用前端卸载钩子 / dispose 后端 fiber,校验 Effect 全部回收 |
