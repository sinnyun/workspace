# 06 · 开源方案选型清单

本文按"能不自研就不自研"的原则,为每一层列出成熟开源方案:**用途 → 候选 → 推荐 → 理由/代价**。目标是让实现阶段直接装库,而不是从零写轮子。

> - 具体版本号在 Phase 0/1 落地时用 lockfile 锁定;本文只定"用哪个",不定"哪个版本"。
> - 标 **★** 的是已定/推荐默认选型;前端 UI 组件库**已定为 Mantine**(见 §2.1)。
> - 所有"大颗粒依赖"都要经**隔离层**接入(见 §5),便于日后替换。

---

## 0. 推荐默认栈(一眼版)

| 层 | 默认选型 |
|---|---|
| 外壳/IPC | Tauri v2 + 官方插件(fs/dialog/notification/log/window-state/context-menu/clipboard/opener) |
| 异步/并行 | tokio(cordis-rs 自带)+ rayon |
| 遍历/监听 | `ignore`(或 `jwalk`)+ `notify` |
| 哈希 | `blake3`(+ `md-5`/`sha2` 兼容需求) |
| 存储 | `rusqlite`(bundled SQLite,WAL)+ `refinery` 迁移 |
| 检索 | `tantivy`(全文)+ SQLite FTS5(轻量场景) |
| 类型/缩略图 | `image` + `base64`(已用,`thumb.image`)；`infer` + `fast_image_resize`(待评估) |
| 后端插件运行时 | cordis-rs(+ loader/logger/timer) |
| 前端框架 | React 19 + Vite + TypeScript |
| UI 组件库 | **Mantine ★(已定)**:core/hooks/spotlight/notifications/dates/modals/form |
| 大列表/表格/树 | TanStack Virtual + TanStack Table + react-arborist |
| 状态 | zustand |
| 代码/diff 查看 | CodeMirror 6 ★ + react-diff-view + Shiki;需 VS Code 级编辑再上 Monaco |
| 图表(磁盘占用) | ECharts(treemap) |
| 质量工具 | Biome / clippy+rustfmt / Vitest / cargo-nextest / WebDriverIO+tauri-driver |

---

## 1. 后端(Rust)

### 1.1 运行时与并行
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 异步运行时 | `tokio` | ★ tokio | cordis-rs 与 Tauri 都基于它,统一 |
| CPU 并行 | `rayon`、`async-task` | ★ rayon | 目录遍历/批量哈希的数据并行 |
| 未来/流工具 | `futures`、`tokio-stream` | ★ futures | 组合异步流 |

### 1.2 文件系统
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 并行遍历 | `ignore`、`jwalk`、`walkdir` | ★ `ignore`(需尊重忽略规则)/ `jwalk`(纯并行、更快) | `ignore` 是 ripgrep 同款,内建并行 + gitignore;`jwalk` 更轻更快 |
| 文件监听 | `notify`(+`notify-debouncer-full`) | ★ notify | 跨平台事实标准;debouncer 合并抖动事件 |
| 复制到回收站 | `trash` | ★ trash | 跨平台回收站,删除更安全 |
| 带进度复制/移动 | `fs_extra`、自行 `tokio::fs` | ★ fs_extra(目录级)+ 自写进度 | 大文件进度需自行分块 |
| 路径处理 | `dunce`(Windows)、`path-absolutize`、`unicode-normalization` | ★ 按需 | Windows 路径前缀、规范化 |
| 文件名自然排序 | `natord`、`human-sort` | ★ natord | "2 file" 排在 "10 file" 前 |
| 磁盘/系统信息 | `sysinfo` | ★ sysinfo | 剩余空间、磁盘占用统计 |

### 1.3 哈希 / 差异 / 版本
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 快速哈希 | `blake3`、`xxhash-rust` | ★ blake3 | 内容指纹/去重首选,支持并行 |
| 兼容哈希 | `md-5`、`sha2`(RustCrypto) | ★ RustCrypto | 需要 md5/sha256 对外兼容时 |
| 文本差异 | `similar`、`imara-diff` | ★ similar | 文本文件版本 diff |
| 内容分块去重 | `fastcdc` | ★ fastcdc | 增量版本存储(内容定义分块),仅在做块级历史时 |

### 1.4 存储 / 检索
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 嵌入式 DB | `rusqlite`(bundled)、`sqlx`、`redb`、`sled` | ★ rusqlite | 同步、成熟、bundled SQLite 免系统依赖;开 WAL |
| 异步 DB | `sqlx`(sqlite) | 备选 sqlx | 想要编译期校验 SQL + 异步时 |
| 连接池 | `r2d2_sqlite` | ★ r2d2_sqlite | rusqlite 的多线程池 |
| 迁移 | `refinery`、`sqlx::migrate!` | ★ refinery | 版本化 schema 迁移 |
| 全文检索 | `tantivy` | ★ tantivy | Lucene 级全文索引,内容搜索插件用 |
| 轻量全文 | SQLite **FTS5** | 备选 | 数据量小、不想引入 tantivy 时 |

### 1.5 类型识别 / 预览 / 媒体
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| MIME(按魔数) | `infer`、`tree_magic_mini` | ★ infer | 内容嗅探,快 |
| MIME(按扩展名) | `mime_guess` | ★ mime_guess | 兜底 |
| 图像/缩略图 | `image`、`fast_image_resize`、`thumbnailer` | ★ image(`base64` 配套) | 已用 `image` 做 `thumb.image`(default-features off + 5 种格式,`FilterType::Triangle` 缩放);`fast_image_resize` 待评估:当前缩放质量与耗时够用 |
| 视频缩略图 | `ffmpeg-next`(需系统 ffmpeg) | 可选 | 体积/依赖大,做成独立媒体插件 |
| PDF 解析/渲染 | `pdfium-render`(需 pdfium 库)、`lopdf` | ★ pdfium-render(渲染)/ lopdf(纯解析) | 渲染走 pdfium;仅取元数据用 lopdf |
| 文本编码探测 | `encoding_rs`、`chardetng` | ★ encoding_rs + chardetng | 非 UTF-8 文本预览 |

### 1.6 归档 / 压缩
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| zip | `zip`、`async-compression` | ★ zip | 浏览/解压 zip |
| tar/gz | `tar` + `flate2` | ★ tar+flate2 | |
| 7z | `sevenz-rust` | ★ sevenz-rust | 纯 Rust 7z |
| zstd/brotli | `zstd`、`brotli` | 按需 | |

### 1.7 内核 / 基础设施
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 插件运行时 | `cordis-rs` + `cordis-core` | ★ cordis-rs | 见 [05-decisions.md](05-decisions.md) D1 |
| 插件加载/配置 | `cordis-rs-loader`、`cordis-rs-include` | ★ loader | 声明式加载计划 |
| 热重组 | `cordis-rs-hmr` | ★ hmr | 事务式热替换 |
| 日志 | `tracing` + `tracing-subscriber` | ★ tracing | 结构化日志。**定案(2026-10-08)**:不引 `cordis-rs-logger-console`;cordis-core 不发 `tracing`/`log`,诊断走其原生 `Logger`/`add_exporter`(Runtime 级 exporter),用一层 exporter 桥接(见 `fm-kernel/logger.rs`)把 cordis 记录转发进 `tracing`。 |
| 计时器 | `cordis-rs-timer` | ★ timer | fiber 作用域定时 |
| 错误 | `thiserror`(库)/ `anyhow`(应用) | ★ 二者搭配 | |
| 序列化 | `serde` + `serde_json` + `toml` | ★ serde | |
| 配置聚合 | `figment`、`config` | ★ figment | 多来源配置合并 |
| 应用目录 | `directories`(或 Tauri path resolver) | ★ Tauri resolver | 统一数据/配置目录 |

### 1.8 Tauri v2 官方插件(开箱即用,优先于自研)
来自官方 `plugins-workspace`,直接用即可:

| 插件 | 用途 |
|---|---|
| `tauri-plugin-fs` | 前端受控文件访问(带 scope 权限) |
| `tauri-plugin-dialog` | 原生打开/保存/确认对话框 |
| `tauri-plugin-notification` | 系统通知 |
| `tauri-plugin-log` | 前端日志转发到 Rust/文件 |
| `tauri-plugin-window-state` | 记忆窗口位置/尺寸 |
| `tauri-plugin-context-menu` | 原生右键菜单 |
| `tauri-plugin-clipboard-manager` | 剪贴板 |
| `tauri-plugin-opener` / `-shell` | 用默认程序打开文件/目录 |
| `tauri-plugin-store` | 轻量 KV 持久化(前端设置) |
| `tauri-plugin-single-instance` | 单实例 |
| `tauri-plugin-autostart` | 开机自启 |
| `tauri-plugin-updater` | 应用自更新 |
| `tauri-plugin-deep-link` | `file://`/自定义协议唤起 |

> **注意**:`tauri-plugin-sql` 会把 SQL 直接暴露给前端,与本架构"能力层原子化 + 权限白名单 + 业务在后端插件"的原则冲突。**默认不用它**,DB 一律走能力层 `db.<store>.*`(rusqlite 实现)。`tauri-plugin-fs` 可作为前端受控读写的便利层,但重活(遍历/哈希)仍走自定义能力命令以保性能与权限收口。

### 1.9 架构参考实现(读源码胜过造轮子)
- **yazi**(`sxyazi/yazi`,Rust 终端文件管理器):tokio + notify + image 预览 + 插件化,是后端架构、异步 IO、预览/缩略图管线的优秀参考。
- **ripgrep / `ignore`**:大规模并行遍历的范式。
- **Zed**(`zed-industries/zed`):Rust 高性能编辑器,可参考其 CRDT/diff、渲染与插件思路。

---

## 2. 前端(React + TypeScript)

### 2.1 UI 组件库(★ 已定:Mantine)

**决定**:采用 **Mantine**。理由:电池最全(表格/日期/通知/命令面板/表单/模态一应俱全),主题走 CSS 变量 + CSS Modules,对插件样式隔离友好,密集型桌面应用开发最快。

采用的 Mantine 生态包:
- `@mantine/core` + `@mantine/hooks`(基础组件与 hooks)
- `@mantine/spotlight`(命令面板,替代 cmdk)
- `@mantine/notifications`(应用内通知)
- `@mantine/dates` + `dayjs`(日期/时间线)
- `@mantine/modals`(命令式模态)、`@mantine/form`(表单)

> Mantine 作为**共享单例**经 import map 提供给前端插件(见 [03-project-layout.md](03-project-layout.md) §5),插件 UI 与基座风格统一、且各自不重复打包。因 Mantine 浮层(Modal/Menu/Tooltip/Notifications)经 portal 渲染到 `document.body`,**插槽不用 Shadow DOM 包裹**(否则浮层丢样式),隔离由 CSS Modules + Mantine CSS 变量承担。

| 候选(已评估) | 风格 | 隔离友好度 | 电池 | 结论 |
|---|---|---|---|---|
| **Mantine** | CSS 变量 + CSS Modules | 高 | 很全 | ★ 采用 |
| shadcn/ui + Radix/Base UI + Tailwind | 复制进仓库、无头 | 中高(Tailwind 需 prefix) | 中 | 备选(若日后要极致定制) |
| MUI | Emotion 运行时 CSS-in-JS | 中 | 很全 | 未采用 |
| Chakra UI / HeroUI | 现代、主题化 | 中 | 全 | 未采用 |

### 2.2 布局 / 大列表 / 树
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 虚拟滚动(列表/网格) | `@tanstack/react-virtual`、`react-window`、`react-virtuoso` | ★ TanStack Virtual | 十万级文件列表不卡;headless 易定制 |
| 表格(排序/列/选择) | `@tanstack/react-table`、`ag-grid` | ★ TanStack Table | headless;ag-grid 太重 |
| 目录树 | `react-arborist`、自绘(TanStack Virtual) | ★ react-arborist | 虚拟化树,内置 DnD/重命名/键盘 |

> **react-arborist 3.16.0 实测约束(懒加载靠这些事实)**:v3 **没有** `loadChildren`/lazy API,展开时按需取数据要自己挂 `onToggle`。可展开性由**`children` 键的存在性**决定(`Node.isLeaf = !Array.isArray(children)`、`accessChildren = data.children ?? null`),所以未展开目录必须在数据里带 `children: []`(空数组也行)才出箭头,**叶子节点不得带该键**。"展开后为空"与"未展开"数据形状相同,故须用本地 `loaded`/`opened` 集合区分占位行:`(空目录)` 与 `(载入失败，重新展开重试)`(失败时从 `loaded` 移除,重新展开即重试)。`onToggle(id)` 对**叶子**也会触发,须先判 `isDir` 再加载。库自带 react-dnd/react-window/redux 且在模块作用域读 `process.env.NODE_ENV`,浏览器 ESM 场景要在 Vite 里 `define` 该常量。

### 2.3 状态 / 数据
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 全局状态 | `zustand`、`jotai`、`valtio` | ★ zustand | 轻、无 Provider 地狱、适合插件隔离 |
| 异步缓存(invoke 结果) | `@tanstack/react-query` | 可选 | 需要缓存/重试/失效时 |
| 表单 + 校验 | `react-hook-form` + `zod` | ★ 二者 | 设置面板/重命名等 |
| schema 校验 | `zod` | ★ zod | 校验后端事件负载/manifest(前端侧) |

### 2.4 交互 / 导航
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 命令面板 | `@mantine/spotlight`、`cmdk`、`kbar` | ★ @mantine/spotlight | VS Code 式 Ctrl+Shift+P,随 Mantine 生态 |
| 快捷键 | `react-hotkeys-hook`、`tinykeys` | ★ react-hotkeys-hook | |
| 拖拽 | `@dnd-kit/core`(+`sortable`)、`react-dnd` | ★ dnd-kit | 拖文件/排序,现代无障碍 |
| 右键菜单 | UI 库自带 / `tauri-plugin-context-menu`(原生) | ★ 视需求 | 需要系统级菜单用 Tauri 插件 |
| 通知/Toast | `@mantine/notifications`、`sonner`、`react-hot-toast` | ★ @mantine/notifications | 随 Mantine 生态 |
| 图标 | `lucide-react`、`@tabler/icons-react` | ★ lucide-react | |
| 文件类型图标 | `@vscode/codicons`、`file-icons-js`、`vscode-icons` | ★ 按需 | 文件树/列表的类型图标 |
| 动画 | `motion`(Framer Motion) | 可选 | 过渡动效 |

### 2.5 内容预览(多为独立前端插件)
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 代码/文本查看+编辑 | CodeMirror 6(`@uiw/react-codemirror`)、Monaco(`@monaco-editor/react`) | ★ CodeMirror 6(轻)/ Monaco(全) | 只读预览用 CodeMirror;要 VS Code 级用 Monaco(重) |
| 语法高亮(静态只读) | `shiki`、`highlight.js`、`prismjs` | ★ Shiki | VS Code 同款语法,输出静态 HTML |
| 代码 diff | `react-diff-view`、`diff2html`、Monaco diff | ★ react-diff-view | 版本对比面板 |
| Markdown | `react-markdown` + `remark-gfm` + `rehype-*` | ★ react-markdown | |
| PDF | `react-pdf`(`pdfjs-dist`) | ★ react-pdf | |
| 图片 lightbox | `react-photo-view`、`yet-another-react-lightbox` | ★ react-photo-view | |
| 音视频 | 原生 `<video>` / `react-player` / `plyr` | ★ 原生(或 plyr) | |
| 时间线(file-history) | UI 库自绘 / `react-chrono` | ★ 自绘 | 简单,不必引库 |

### 2.6 可视化 / 国际化 / 工具
| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 图表/磁盘占用 treemap | `echarts`(`echarts-for-react`)、`visx`、`recharts` | ★ ECharts | treemap 画磁盘占用最省事 |
| i18n | `i18next` + `react-i18next`、`lingui` | ★ i18next | |
| 日期 | `dayjs`、`date-fns` | ★ dayjs | 轻 |
| 文件大小格式化 | `pretty-bytes`、`filesize` | ★ pretty-bytes | |
| 样式方案(隔离) | Mantine CSS 变量 + CSS Modules(Vite 内置) | ★ CSS Modules | 配合 Mantine;不用 Shadow DOM(portal 浮层),见 [01-architecture.md](01-architecture.md) §7 |
| 路由(若需多视图) | `@tanstack/react-router`、`react-router` | 可选 | 文件管理器多半不需要重路由 |

---

## 3. 构建 / 质量 / 发布工具链

| 用途 | 候选 | 推荐 | 说明 |
|---|---|---|---|
| 前端构建 | Vite | ★ Vite | 基座 app 模式;插件 lib 模式出 ESM |
| 后端构建 | cargo(workspace) | ★ cargo | |
| 桌面打包 | `@tauri-apps/cli` | ★ tauri-cli | |
| Monorepo 任务编排 | `turborepo`、`nx` | 可选 turbo | 缓存/并行任务,规模大再上 |
| Lint/Format(前端) | `Biome`(一体化、快)、`ESLint`+`Prettier` | ★ Biome(或 ESLint+Prettier) | |
| Lint/Format(Rust) | `clippy` + `rustfmt` | ★ 官方 | |
| 单测(前端) | `Vitest` + `@testing-library/react` | ★ Vitest | |
| 单测(后端) | `cargo test` + `cargo-nextest` | ★ nextest | 更快、输出好 |
| 契约测试 | 自写(读 `events.schema.json` 校验 TS/Rust 一致) | ★ 自写 | 见 [03-project-layout.md](03-project-layout.md) §6 |
| E2E(桌面) | `WebDriverIO` + `tauri-driver`(官方方案)、Playwright(连 WebView2 CDP) | ★ WebDriverIO+tauri-driver | Tauri 官方推荐 |
| Git 钩子 | `husky`+`lint-staged`、`lefthook` | ★ lefthook | 提交前 lint/format |
| 版本/变更日志 | `changesets` | ★ changesets | 前端包与发布说明 |
| 依赖审计 | `cargo-audit`+`cargo-deny`、`npm audit`/`socket` | ★ 官方 | 供应链安全 |
| CI | GitHub Actions + `tauri-action` | ★ tauri-action | 跨平台构建产物 |
| 包体积分析 | `rollup-plugin-visualizer`、`size-limit` | 可选 | 控制插件产物大小 |

---

## 4. 库 → 架构层 映射(装在哪、谁能用)

| 架构层(见 [01](01-architecture.md)) | 归入的库 |
|---|---|
| **能力层(原子 Rust)** | ignore/jwalk、notify、blake3/RustCrypto、rusqlite+r2d2、infer/mime_guess、image/fast_image_resize、trash、fs_extra、zip/tar/flate2、tantivy、pdfium-render、encoding_rs、sysinfo、natord |
| **后端内核(cordis-rs)** | cordis-rs/core/loader/hmr/logger/timer、tracing、serde、figment、thiserror/anyhow、tokio/rayon |
| **后端插件(Rust)** | 复用能力层 Service;需要时直连 similar/fastcdc 等(经契约) |
| **前端基座(React)** | React、**Mantine**(core/hooks/spotlight/notifications/dates/modals/form)、TanStack Virtual/Table、react-arborist、zustand、事件总线、CSS Modules |
| **前端插件(ESM)** | 各自按需:CodeMirror 6、react-diff-view、Shiki、react-markdown、react-pdf、react-photo-view、ECharts、pretty-bytes……(React 与 Mantine 等共享依赖经 import map 走宿主单例) |
| **工具链** | Vite、cargo、tauri-cli、Biome/clippy、Vitest/nextest、WebDriverIO+tauri-driver、changesets、tauri-action |

---

## 5. 隔离层原则(防止被大颗粒依赖绑死)

延续"倾向大颗粒依赖 + 加隔离层"的方针:

1. **能力层即隔离层**:所有第三方 Rust 库(rusqlite/tantivy/image/notify...)只在 `core-shared/kernel/src/capabilities/` 内被直接引用(该 crate 无 Tauri 依赖,可无头测试);对外只暴露稳定的 `domain.action` 能力契约。换库(如 rusqlite→sqlx)不波及插件。
2. **前端只经 host/SDK**:前端插件不直接依赖 Tauri/React 内部,只经 `PluginHost` 与 `plugin-sdk`;React 与 **Mantine** 作为共享单例经 import map 提供,插件直接用 Mantine 组件保证风格统一。UI/虚拟化库的替换由基座吸收。
3. **契约先行**:跨层的数据形状定义在 `core-shared`(TS `plugin-sdk` + Rust `contracts`),库是实现细节。
4. **重依赖做成插件**:ffmpeg、pdfium、Monaco、tantivy 这类体积/复杂度大的,封进独立能力或独立插件,不进核心路径,按需启用。
5. **锁版本 + 审计**:lockfile 锁死;`cargo-deny`/`npm audit` 进 CI,防供应链与许可问题。

---

## 6. 选型定案状态

| 项 | 状态 | 说明 |
|---|---|---|
| 前端 UI 组件库 | ✅ 已定 Mantine | 含 spotlight/notifications/dates/modals/form;共享单例;不用 Shadow DOM |
| 命令面板 | ✅ @mantine/spotlight | 随 Mantine,不再单引 cmdk |
| 应用内通知 | ✅ @mantine/notifications | 系统级通知仍用 tauri-plugin-notification |
| 代码查看器 | ✅ 默认 CodeMirror 6 | 只读预览;需 VS Code 级编辑再上 Monaco(重),做成独立插件 |
| DB | ✅ rusqlite + WAL | 若强烈需要异步 + 编译期 SQL 校验再切 sqlx |
| 全文检索 | ✅ tantivy | 数据量小、想少依赖可退回 SQLite FTS5 |
| 视频缩略图/转码(ffmpeg-next) | ⚪ 待评估 | 依赖系统 ffmpeg、体积大,做成独立媒体插件按需启用 |

### 6.1 落地状态(2026-10-08 开源库使用审计)

审计=以本文为基线,比对全部 `Cargo.toml`/`package.json` 与真实 `use`/`import`。结论:核心垂直切片所需库已接入且经隔离层;其余**尚未引入的多因对应功能未建**,已逐项转成 roadmap **Phase 6** 可执行任务(见 [04-roadmap.md](04-roadmap.md) Phase 6),后续开发据此启用。

| 选型 | 当前落地 | 归属任务 |
|---|---|---|
| cordis-core / tokio / futures / serde / thiserror / anyhow / parking_lot | ✅ 在用 | — |
| blake3 + sha2 | ✅ 在用(`hash.rs`,流式) | P6-1 收尾并行/大文件 |
| rusqlite(bundled) | ✅ 在用(`db.rs`) | **r2d2 池 / refinery 迁移尚未引**→ P6-12 |
| notify + notify-debouncer-full | ✅ 在用(`watch.rs`,专用线程 WatchHub) | — |
| tracing + tracing-subscriber | ✅ 在用 | cordis 原生 Logger→tracing 桥已落(`fm-kernel/logger.rs`),**不引 logger-console** |
| tauri 2 + http + tauri-plugin-fs/dialog/opener | ✅ 已注册并使用 | 接线到能力层→ P6-30 |
| Tauri path resolver(app_data_dir) | ✅ 在用(未引 `directories`) | — |
| React 19 + Vite + TS + zustand + @tauri-apps/api | ✅ 在用 | — |
| Mantine `core`+`hooks`+`notifications`(**7.17.8**) | ✅ 在用(基座外壳与插件 UI 全走 Mantine:SegmentedControl/Tabs/ScrollArea/Table/Timeline/Badge…) | `spotlight/dates/modals/form` 未引 → P6-14/27;**改 `plugin-sdk` 源码或升 Mantine 版本后必须 `pnpm build:shared`**——插件运行时 import 的是 `shared-dist*/plugin-sdk.js` 预打包件,漏建会在加载时报 "does not provide an export named …" |
| 并行遍历 `ignore`/`jwalk` + `rayon` | ❌ 未引(`fs.list` 现同步 `read_dir`) | P6-1 |
| `natord` | ✅ 在用(`fs.list` 出参自然序、忽略大小写) | — |
| `image`(default-features off:png/jpeg/gif/bmp/webp/tiff)+ `base64` | ✅ 在用(`capabilities/thumb.rs` 解码 → 等比缩放 `FilterType::Triangle` → PNG data URL;带 mtime 键缓存) | `fast_image_resize` 未引:当前缩放质量足够,量大再评估 |
| `trash`/`fs_extra`/`sysinfo`/`infer`/`mime_guess`/`encoding_rs`/`chardetng`/`similar`/`tantivy`/`zip`/`tar`/`sevenz-rust`/`fastcdc` | ❌ 未引 | P6-1…13(对应功能建时接入) |
| 前端功能库:`@tanstack/react-virtual`、`react-arborist`、`lucide-react` | ✅ 在用(各自打进插件 dist,不进共享集):虚拟滚动=`plugin-file-browser` 列表+网格单条流;树=`plugin-view-file-tree`;图标=基座外壳 + browser + inspector | 剩余:P6-16/18/19/21/22 |
| 前端功能库(TanStack Table、dnd-kit、react-hotkeys-hook、codemirror、shiki、react-diff-view、react-markdown、react-pdf、react-photo-view、echarts、dayjs、pretty-bytes、i18next) | ❌ 未引 | P6-14…27(功能插件化时接入) |
| `tauri-plugin-notification`/`-window-state`/`-single-instance` | ❌ 未引 | P6-28/29 |
| 工具链:Biome / Vitest / nextest / cargo-deny / lefthook / changesets / GitHub Actions+tauri-action / WebDriverIO+tauri-driver | ❌ 全无(现仅 `cargo test`、`node --test`、手写 `contract-check`) | P6-31…40 |
| `cordis-loader`、`cordis-timer` | ⚠️ **在 workspace 声明但零引用**(死声明) | 不删除,由 P6-41/P6-42 转正启用 |
| `cordis-hmr`、`cordis-rs-include` | ❌ 未声明/未用 | 热替换需求出现时再评估 |

> **库 → 插件的具体分布**(每个库归到基座 / 能力层 / 哪个业务插件 / 前端共享单例 / 前端插件自带 dist)见 [08-plugin-catalog.md](08-plugin-catalog.md);归属分层的**规则**见 [01-architecture.md](01-architecture.md) §8。本文只定"用哪个库",08 定"用在哪个插件的哪一层"。
