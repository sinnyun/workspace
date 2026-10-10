# `plugin-preview` · 统一文件预览

**状态：已交付（P7-20/21/22，2026-10-10 取证）。** 在 `plugin-inspector` 的 `preview-zone` 中承载唯一的文件预览入口，并向设置面板贡献 `settings-page:preview` 一页。默认只显示 Windows 系统缩略图；只有用户点击"文件预览"切换按钮后，才申请受限资源句柄并按文件类型交给 Open File Viewer 渲染。文本、Markdown、图片、PDF、音视频、Office、压缩包没有各自的应用级预览插件。

三处事实需要真机才能取证，保持"已实现未验证"：真 Tauri 窗口内的渲染、真实 Windows Shell 缩略图字节、真实 `chardetng` 编码猜测结果（浏览器 dev 里分别由预置样例图与 mock 通道镜像同一套语义）。

## 方案选择与职责边界

- 渲染引擎：[Open File Viewer](https://github.com/xushanpei/open-file-viewer)（MIT），使用其 React 集成 `@open-file-viewer/react` 与 `@open-file-viewer/core` 的格式插件。注册的插件集合是显式常量，不是"全量依赖"：`imagePlugin / textPlugin / pdfPlugin / audioPlugin / videoPlugin / archivePlugin / officePlugin`（office 覆盖 docx、xlsx、pptx）。
- 本插件只读。文件管理、编辑、系统打开、缩略图生成、索引、永久缓存都不在这里；系统打开一律经 `shell.openPath`，不自 exec。
- 类型分派的唯一事实源是宿主可信的 `file.kind`，扩展名只是其副产物。本插件自己维护一张"查看器确实能尝试的类别"表，表外的类别在**申请句柄之前**就被拒绝，并给出准确的能力边界文案——不宣称全格式可预览。

## 用户入口、两种模式与几何

- 无焦点时显示"选中一个文件后可预览"的空态；文件夹焦点不进入预览（那是目录浏览器的业务）。
- **缩略图模式**（每个新聚焦文件的默认）：只发一次 `shell.thumbnail.read`（edge 256）取 Windows 系统自己的图，外加一次 `file.kind` 拿扩展名用于类型徽标；取不到系统图时显示 `.TXT` 之类的徽标。此模式**不创建 viewer、不读一个正文字节**，通道计数恒为 `{open:0, read:0, close:0, bytes:0}`。
- **文件预览模式**：用户显式点击"打开文件预览"才开始；按钮随后变成"返回缩略图"，用 `aria-pressed` 表达当前模式。
- 模式不持久化。切换焦点即回到缩略图并清空一切，防止一次误点导致后续大文件被自动拉取。
- 预览区在两种模式下高度固定 260，切换不会移动下方面板（与所有浮层面板同一几何规则）。

## 数据通道

- 文本类（`text`/`code`/`markdown`）走 `fs.readText`：编码由宿主 `chardetng` + `encoding_rs` 判定，交给查看器的永远是已解码的 UTF-8 正文，界面上用一行 `编码 GBK · 96 B` 报出真实编码与体积。`too-large` 与 `binary` 是两种可区分的中文状态，不是乱码。
- 其余类别走只读资源句柄通道：`fs.openResource` → 循环 `fs.readResource`（单次请求 512 KiB，宿主侧强制裁剪并如实标记）→ `fs.closeResource`，拼成 `Blob` 交给 viewer，边读边显示百分比进度。
- 上限：单文件预览 64 MiB（超出即 `too-large`，句柄照样关闭），文本读取 4 MiB，同时最多 16 个活跃句柄，句柄 TTL 5 分钟。
- 不存在把裸 `file:`/`asset:` URL、绝对路径或原始字节交给 WebView 或写入 `localStorage`/事件总线的路径；`preview:state:changed` 只带不透明引用、模式、状态、格式与进度。
- pdf.js 的 worker、CJK cmap 与标准字体在构建时由 `scripts/prepare-pdf-assets.mjs` 复制到插件产物旁，运行时用 `import.meta.url` 解析，并显式禁用 CDN 回退——本地预览不产生任何外部源请求。viewer 样式以 `?inline` 随 bundle 走，激活时挂成一个 `<style id="ofv-viewer-style">`（运行时 ESM 插件没有宿主可以 link 的独立样式文件）。

## 状态机与失败恢复

十二个状态各自有中文文案与出路：`idle / checking / loading / ready / unsupported / too-large / not-found / permission-denied / corrupt / password-required / cancelled / error`。

- 失败分类先看线协议前缀（`not found:`、`permission denied:`、`invalid argument:`），再看内容/异常签名；路径本身可能就叫"损坏文件"，所以前缀判断必须在关键词之前。
- Open File Viewer 解析失败时会在视口内渲染它自己的 `.ofv-fallback` 卡片且**不调用 `onError`**，所以"viewer 已挂载"不等于 `ready`。本区用 `MutationObserver` 监视该节点，把卡片文本换成自己的状态（`.ofv-encrypted` 单独映射为 `password-required`），并把英文原文只放进 `title` 供排查。
- `unsupported / too-large / corrupt / password-required` 提供"用 Windows 打开"；`not-found / permission-denied / corrupt / error` 提供"重试"。红字状态与中性状态由集合并集决定，新增状态不会漏配。

## 取消与资源回收

请求序号 `seqRef` 是所有 await 的守门人：任何晚到的响应若序号已变，一律丢弃、绝不绘制。

- 返回缩略图：递增序号、中止分片循环、`fs.closeResource` 撤销句柄、销毁 viewer；若中断发生在读取过程中，状态如实记为 `cancelled`（缩略图区附一句"已取消上一次的内容读取"），而不是假装从未请求。
- 换焦点、关闭详情区、插件停用/卸载：同样递增序号并关闭句柄，句柄不会活过面板。取证形态是**关闭数与打开数一致**，且半截内容不会被当作预览展示。

## 与其他插件的关系

- `plugin-file-browser` 只交出不透明焦点引用；本插件自行向宿主请求元数据与资源，不读取其他插件的内部状态。
- 缩略图模式复用 `shell.thumbnail.read`（与网格同一能力），viewer 的完整渲染不调用该通道。
- 系统打开使用 `plugin-file-ops` 同一条 `shell.openPath` 能力，只针对当前焦点文件。
- 格式库只出现在本插件产物内；其他区域若需要预览，应进入本预览容器而不是另起一个 viewer。

## 偏好与验收

- `fm.preview.prefs.v1`：`{maxTextChars, defaultFit}`（`maxTextChars` 夹在 1 千 ~ 200 万，`defaultFit` ∈ `contain|width|actual`）。设置页只有这两条中文控件，不泄漏槽 id。**模式、页码、播放位置、句柄与缓存都不入库。** 读取旧 `fm.preview-text.prefs.v1` 时只映射仍然存在的 `maxChars`，迁移后删除旧 key、不双写；旧 `autoLoad` 不迁移成"自动预览"。
- 文本超过 `maxTextChars` 时在交给 viewer 之前截断。
- 取证：`.scratch/pw/run-f.mjs` **125/125**（截图 63..85）覆盖通道 19 项语义、默认态零内容读取、12 个代表性本地样本逐类出图（含真实 OOXML docx/xlsx、真 R2/RC4-40 加密 PDF、真损坏 PDF、70 MiB 超限视频、`.svg` 型别前置拒绝）、零外部源请求、中途取消的句柄收支、事件序列与偏好迁移。文本三种状态另由 `.scratch/pw/run-d.mjs` 47/47 取证。
