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
| `fm-kernel` | `core-shared/kernel` | **无 Tauri 依赖**的后端内核:能力实现(fs/hash/thumb/db + `watch::WatchHub`)、`Kernel` 引导、后端插件 `registry`、cordis `Logger`→`tracing` 桥(`logger.rs`)。可无头测试 |
| `fm-host` | `apps/host` | 薄 Tauri 壳:`#[command] invoke_capability`、`plugin://` 协议、`EventBridge`(cordis→Tauri emit)、`PluginServer`(前端插件发现/下发) |
| `plugin-file-history-backend` | `plugins/plugin-file-history/backend` | 首个后端插件:订阅 `file:changed`→`hash.compute`→写 `db.history`→`emit history:updated`(幂等) |
| `@my-file-manager/plugin-sdk` | `core-shared/plugin-sdk` | 前端插件**唯一**可依赖包:类型 + `Events`/`Capabilities` + `validateManifest`/`matchesPermission`/`disposer`/`errorMessage` |
| `shell-ui` | `apps/shell-ui` | React 基座:布局、`PluginSlot`+错误边界、`eventbus`、`slots` 注册表、`loader`、`host`(权限 gating)、`invoke`、共享单例构建 |
| `plugin-file-history/frontend` | 同名 | 首个前端插件:导出 `HistoryPanel`(Mantine Timeline),注入 `plugin-inspector` 的 `detail-tab:history`(`label:"历史"`) |

**前端插件共 14 个**(`plugins/*/frontend`,全部 `@mantine/* ^7.17.8` 走 import map 单例):三个框架容器(`layout-panes`/`layout-views`/`inspector`)、内容插件(`file-browser`/`file-details`/`file-history`/`settings`/`preview-text`)、三个侧栏视图(`view-file-tree`/`view-favorites`/`view-tags`)、三个仅 dev 装载的开发期插件(`mock-data`/`devtools-log`/`dev-slot-harness`)。清单与槽位见 08 §2/§5。

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
| Phase 6 · 6E 界面框架与布局 | ✅(P6-43~48/54/55) | `vite dev` 浏览器实测六区 + 三分栏容器 + B 互斥 + D tab 容器 + 懒加载目录树 + 每栏独立实例(证据见 04 6E 表) |
| Phase 6 · 6E 第二轮(界面收口) | ✅(P6-56~60) | 基座外壳全 Mantine + 亮色默认与三态主题切换(基座顶栏与 `plugin-settings` 共用同一 Mantine 配色值)、槽标签发现面 `slots[].label`→`host.slotLabel`、每栏独立地址栏+历史导航与列表/网格虚拟滚动、D 焦点标题条与全中文文案;`cargo test -p fm-contracts` + SDK 10 项 + `contract:check` + `-r typecheck` 全绿,14 插件 0 控制台错误 |
| Phase 6 · 6F 开发期插件 | ✅(P6-49~53) | dev 索引 14 插件 0 控制台错误;调试台捕获级联/槽事件与两条越权拒绝 |
| Phase 6 · 6B 已起步 | 🟡 | 已落:`plugin-settings`(主题)、`plugin-preview-text`(纯文本预览)、file-browser 列表/网格虚拟滚动与每栏历史导航、**网格卡片缩略图(`thumb.image` 内核实现 + 可见性懒取 + 负缓存)**、**`/stress` 真实感压力数据集(1千~50万,经真实插件路径消费)**;未落:CodeMirror/Shiki 高亮、表格视图、file-ops/search/preview 其余成员 |
| Phase 6 · 6A 已起步 | 🟡 | 已落:`thumb.image`(`image`+`base64`,P6-7)、`fs.list` 自然序与 mtime(`natord`,P6-4/P6-11);未落:`fs.copy/move/trash/mkdir/rename`、`file.kind`、`sys.disk`、搜索索引 |
| Phase 6 · 6A/6C/6D | 🟡 6A 起步(见上一行)/ 6C·6D 🔵 未开始 | 工具链(6C)、cordis 转正(6D) |

### 已验证(有可复现证据)

- **后端垂直切片无头测试**:`cargo test -p fm-kernel` 3 项过——`backend_slice`(真内核+真能力+真插件+事件:emit file:changed→写历史→hash 与 `hash.file` 一致→重复 emit 幂等→shutdown 后 `fiber_count==0`);`panic_isolation`(插件 `apply` panic 经 cordis `contained.rs` 收敛为 `Failed`→`spawn_transient` 返回 Err、失败 fiber 不入 roster、同 Kernel 的 file-history 兄弟仍能响应 `file:changed`);`logger_bridge`(经 cordis 原生 `add_exporter`/`Logger` 面注册的 exporter 同步收到带 level/channel/text 的记录,即 P5-3 桥接管道可用)。
- **打包**:`cd apps/host && npx tauri build` 成功产出 `target/release/bundle/nsis/File Manager_0.1.0_x64-setup.exe`(~3.9MB),`fm-host.exe` 16.9MB,`dist/shared/*`(9 文件)随包。
- **manifest schema 校验**:`cargo test -p fm-host --test manifest_schema` 4 项过(内置 manifest 解析+校验;坏 schemaVersion/缺 backend&frontend/缺 permissions 均被拒)。
- **TS↔Rust 契约一致性**:`pnpm --filter shell-ui contract:check` 全 ok(事件名/事件字段/能力名/DTO 字段);**负向验证**:改 SDK 能力名后正确 FAIL。
- **SDK 纯函数单测**:`pnpm --filter @my-file-manager/plugin-sdk test` 11 项过(`matchesPermission` 精确/`*`/槽 id 冒号后缀、`slotPrefix`、`validateManifest` 含 `provides`+`slots.contribute`+`slots[].label` 可选元数据与空白拒绝、`disposer`、`errorMessage` 去 `Error:` 前缀、`Events`/`BASE_SLOT_IDS` 字面量稳定)。
- **前端基座浏览器实测**(`vite dev` @1420):六区渲染(A/B/C/D + 顶部会话条 + 状态栏 + dev 抽屉);运行时 `import()` 加载 14 个 dev 插件 0 错误;级联链路 `sidebar:view:changed → nav-panel 互斥可见 → sidebar:selection:changed → 每栏 focus:changed → detail:tab:changed`;`plugin-file-details` 经 gated 能力显示属性 + BLAKE3;单 React/Mantine 实例(hooks 跨 host/插件不报错)。
- **主题与中文文案实测**:默认亮色(`defaultColorScheme="light"`),顶栏 `SegmentedControl` 切「暗色」→ `data-mantine-color-scheme=dark`、body 底色 `rgb(36,36,36)`,**`plugin-settings` 面板内同一项自动 `checked`**(共用 Mantine 单例的配色值,无自定义事件);D 的 tab 显示 `信息`/`历史`(标题来自 `host.slotLabel`),分栏头显示 `栏 N` 而槽 id 只作悬停提示。
- **每栏导航实测**:地址栏 后退/前进/上级目录/刷新 独立生效(`/demo/src →上级→ /demo →后退→ /demo/src`,前进由 disabled 转可用);列表/网格切换与路径按 `会话|槽id` 存进 `fm.file-browser.v1`,网格卡片显示 扩展名徽标 + 大小。
- **大数据压力实测(`vite dev` @1420,双栏)**:B「模拟数据」点 `数据集-10万` → C 头部 `9566 目录 · 90434 文件 · 295ms`;`数据集-50万` → `47769 目录 · 452231 文件 · 472ms`,内容高 13,000,048px(列表)/22,369,618px(网格)而**常驻 DOM 只有 ~214(列表)/~514(网格)节点**;滚动 1400px/帧时 p50 ≈ 26ms(调试抽屉打开时 ≈ 90ms,是 dev 面板自身的成本);图片卡片显示 `data:image/png` 真缩略图,二进制文件在 D 显示中文 `无法以文本读取 .m4a(二进制格式)`,`空目录`/`读取失败` 各显示中文 `空目录`/`—模拟读取失败`。
- **容器/嵌套槽实测**:`plugin-layout-panes` 1/2/2×2 切换保持每栏路径(4→1→4 后 p1 仍 `/demo/src`)、拖拽改 `colPct`、`closePane` 只退该栏;`plugin-file-browser` 靠 `providedSlots("pane-slot")` + `slot:registered/disposed` 自动为后建栏注入实例;`plugin-inspector` 的 tab 条来自 `contributedSlots("detail-tab")`,空槽显示占位;越权路径仍在调试台留两条 `denied (not in manifest permissions)`。
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
10. **react-arborist 的可展开性看 `children` 键的"存在"而非内容**:未展开目录必须带 `children: []` 才出箭头,叶子**不能**带该键(`isLeaf = !Array.isArray(children)`)。库 v3.16 无 lazy API,懒加载要自己挂 `onToggle`,并用 `loaded`/`opened` 集合区分 `(空目录)` 与 `(载入失败，重新展开重试)`;`onToggle` 对叶子也会触发,先判 `isDir`。详见 06 §2.2 注。
11. **浏览器 ESM 里的 `process.env`**:`react-arborist` 打包的 react-dnd/react-window/redux 在模块作用域读 `process.env.NODE_ENV`,纯 ESM 运行时没有 `process` → 该插件的 Vite 配置必须 `define: { "process.env.NODE_ENV": JSON.stringify("production") }`(产物里 `grep -c process.env` 应为 0)。
12. **"切换不丢状态"要靠结构,不靠自觉**:分栏容器只在**一个 keyed 子节点数组**里渲染所有活跃面板,不可见者 `display:none`(见 §4.19 的 React 样式坑),切模式只改 `grid-area`;预先把 4 个隐藏 outlet 挂上是错的——outlet 必须按需新增并按 `slot:reconfigured{add}` 声明。B 视图互斥同理,由容器 `plugin-layout-views` 隐藏非活动面板,视图插件不得 self-hide。
13. **会话隔离两件套**:面板网格 `key={activeTabId}`(两个会话不得共享同一个 `pane-slot:p0`),内容插件的每栏路径/最后交互栏都要以**会话**为键(`fm.file-browser.v1` 的 `会话|槽id`),否则切会话会出现"别的会话的选中的项把我这栏导航走"。
14. **浏览器自动化取证限制**:本环境 `take_screenshot` 报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`,证据落在 DOM/console 断言;`mcp__browser-use__click` 对插件自写按钮不触发时,用 `evaluate_script` 派发真实 `.click()` / `MouseEvent` / `PointerEvent`(该工具拒绝 IIFE,需写函数声明;拖拽分隔条要先 stub `Element.prototype.setPointerCapture`)。
15. **Mantine 锁 7.17.8 的 API 差异**:`Unstyled` 不再导出(用原生元素 + reset 样式);`Tabs` 没有 `size`(改 `styles={{ tab: … }}`);`ScrollArea` 没有 `maxHeight`(改 `styles={{ viewport: { maxHeight } }}`);`Code` 没有 `withCopyButton`。**改任何共享依赖版本后必须 `pnpm build:shared` 重建两套变体**,否则 `/shared/*` 里仍是旧版本实现,而 `tsc` 按 node_modules 的新类型通过 → 运行时与类型漂移。
16. **颜色只走主题变量**:写死亮色专属值(如 `--mantine-color-gray-0`)在暗色下留白条;吸附的分组条要用 `var(--mantine-color-body)`(暗色实测 `rgb(36,36,36)`)。主题状态不要自建:`useMantineColorScheme` 拿到的就是基座那份(共享单例),`defaultColorScheme="light"` 在 `MantineProvider` 上设。
17. **`aria-label` 会覆盖可见文本成为可访问名**:给已显示中文的 tab 加英文 `aria-label`(槽名 `info`)会让无障碍树读出英文,`take_snapshot` 里直接暴露。带文本的控件不要再加 id 类 aria-label。
18. **浏览器取证:Mantine 控件怎么点**:`SegmentedControl` 的选项**不是** `[role="radio"]`,直接点里面的隐藏 `input` 也不会触发 React onChange;要 `.click()` 整个 `.mantine-SegmentedControl-label`,选中态读其内 `input[type=radio].checked`。实测里 `input.value` 是 `"list"/"grid"` 这类内部值,不是中文标签,按文本找按钮会找不到。
19. **React 会"删除"值为 `undefined` 的内联样式属性**:`style={{ ...paneStyle, display: hidden ? "none" : undefined }}` 不是"保留 paneStyle 的 flex",而是把 `display` 整个去掉 → `<section>` 回到默认 `display:block` → 子元素 `flex:1` 失效 → outlet 长到内容高度 → **虚拟列表静默挂载全部行**(1 万条时 10,002 行、26 万像素高),且被 `overflow:hidden` 裁掉看不见。条件显隐要把两种状态都写全(`display: hidden ? "none" : "flex"`)。
20. **"栏高有界"是容器 owner 的不变量**:栅格行轨写 `minmax(0,1fr)`(auto 行轨会被内容撑到无限高)、栏本身 `display:flex`+`min-height:0`、outlet `flex:1`+`overflow:hidden`(滚动权归内容插件)。内容插件只写 `height:100%` 就能拿到确定视口,不需要各自探测父高。
21. **改 `plugin-sdk` 源码也要 `pnpm build:shared`**:`build:plugins` 只重建插件 dist,而插件运行时 import 的是 `shared-dist(-dev)/plugin-sdk.js` 预打包件 → 新增导出后插件加载期报 `does not provide an export named 'errorMessage'`(基座 loader 会隔离该插件并记 error,其余插件继续跑)。类型检查与测试都读源码,不会暴露这个漂移。
22. **`String(err)` 会把 `Error:` 前缀带进中文界面**:provider 的中文消息经 `String(new Error("模拟读取失败"))` 变成 `"Error: 模拟读取失败"`。UI 显示错误统一走 SDK 的 `errorMessage(err)`(取 `err.message` 并去掉类名前缀)。


---

## 5 · 当前状态与剩余流程

### 在跑

无。`tauri build`(nsis)已成功产出安装包(见 §3);Phase 5 的代码类子项(错误隔离后端、可观测、契约冻结、权限拒绝路径)均已实现并有证据。

### 剩余任务(建议顺序)

> **既定开源栈接入 backlog = roadmap Phase 6**(见 [04-roadmap.md](04-roadmap.md)):2026-10-08 审计把 [06-open-source-stack.md](06-open-source-stack.md) 的选型逐项转成可执行任务(6A 后端能力 / 6B 前端功能插件 / 6C 质量工具链 / 6D cordis 运行时 / 6E 界面框架与布局 ✅ / 6F 开发期演示与调试插件 ✅)。**这些库按插件的分布、要建哪些插件见 [08-plugin-catalog.md](08-plugin-catalog.md)**(库归属分层规则见 [01-architecture.md](01-architecture.md) §8)。以后开发**按 Phase 6 / 08 选用对应开源库**,不自研轮子;新增能力落 `kernel/capabilities` 隔离层、新功能做成前端插件、新契约先两侧同步再跑 `contract:check`。

1. **窗口内端到端(P0-2/P0-6/P1-1/P1-3/P1-4/P4-3/P5-1 前端边界)**:这是**本环境(无显示器)唯一无法验证的一类**。有显示环境时 `cd apps/host && npx tauri dev`,验证 `plugin://` 下发、真 invoke 往返、真实文件改动→watcher→`file:changed`→后端写历史→`history:updated`→Tauri emit→前端总线→Timeline 自动刷新,并加载一个故意抛错的示例插件确认 `PluginErrorBoundary` 只降级该插槽。这是把 §3 里 🟡 项转 ✅ 的唯一途径。
2. **工程化补票(P6-41 / P3-5 / P3-6)**:用 `cordis-loader` 生成声明式加载计划 + `build.rs` 扫描 manifest 自动生成后端注册表(去掉手写 `registry` 漂移;当前仅 1 个后端插件收益有限故暂缓),插件脚手架模板。注:`cordis-loader`/`cordis-timer` 现已在 workspace 声明但**零引用**,这两项转正后消除死声明。
3. **质量工具链(P6-31…40)**:目前**无任何 CI / 提交钩子 / 前端 lint / 依赖审计**。优先补两项——前端 `Biome`(lint+format)与 GitHub Actions(clippy/fmt/`cargo test`/`contract:check`/`typecheck`,发布用 `tauri-action`);再补 `Vitest` 测 `PluginSlot` 错误边界、`cargo-deny` 审计、`lefthook` 钩子。
4. **产品功能扩展(6A + 6B)**:基座**不含任何浏览逻辑**——六区外壳 + 三个框架容器(分栏/视图互斥/详情)+ 每栏 `plugin-file-browser` 实例(独立地址栏与历史导航、列表/网格虚拟滚动、缩略图卡片)已插件化交付,首个全栈插件是 file-history,另有 `plugin-settings`(主题)与 `plugin-preview-text`(纯文本预览)。下一步按 08 §5.2 落业务:复制/移动/删除(`trash`/`fs_extra`,**同时补 `fs.copy/move/trash/mkdir/rename` 能力与进度事件**)、并行遍历(`ignore`+`rayon`)、视频缩略图(`ffmpeg-next`,独立媒体插件)、搜索(`tantivy` 或 SQLite FTS5)、预览高亮(`codemirror`/`shiki`)、表格视图(`@tanstack/react-table`)、命令面板(`@mantine/spotlight`)——挂载点已稳定,新内容插件只需在 `permissions.slots.contribute` 授权目标嵌套槽(标题写自己的 `slots[].label`)。
5. **卡片上的标签 chip(仍待做)**:标签数据住在 `plugin-view-favorites`/`plugin-view-tags` 自己的 localStorage 里,浏览器插件跨插件读它会破插件隔离——要做就走 `db.<store>.*` 能力,不自建共享状态。(修改时间已解决:`ListEntry.modifiedMs` 随 `fs.list` 返回,列表日期列零额外往返。)

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
pnpm -r typecheck                           # 全仓类型检查(基座 + 14 个插件 frontend)
pnpm build:plugins                          # 构建所有 plugins/*/frontend → dist/index.js

# 契约/单测
pnpm --filter shell-ui contract:check                        # TS↔Rust 契约一致性
pnpm --filter @my-file-manager/plugin-sdk test               # SDK 纯函数单测
cargo test -p fm-contracts                                   # Rust manifest 校验/DTO 测试

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
