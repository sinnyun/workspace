# `plugin-windows-thumbnails` · Windows 系统缩略图

**状态：规划。** 统一提供 Windows Shell 的缩略图读取能力，供文件列表、网格卡片、统一预览插件及其他需要缩略图的界面使用。缩略图由 Windows Shell 及已安装的缩略图处理程序读取/提取并管理系统缓存；应用不得自行解码原文件、绘制、转码或生成缩略图。

## 职责与边界

- 本插件是 Windows 专属的平台能力入口；原生读取由 host 的 Windows Shell capability 实现，插件负责统一策略、调用约定、状态映射和设置页。消费者只能经受权限门控的 capability 获取结果，不得直接调用其他插件代码或读取系统缓存文件。
- 核心能力为 `shell.thumbnail.read`：输入规范化文件路径、请求边长、缓存策略；输出缩略图图像数据/受控资源引用、实际尺寸、缓存命中/提取状态和可分类错误。返回类型、大小上限和取消接口需在实现前冻结到 contracts 与 SDK。
- Windows 原生路径优先使用 `IThumbnailCache::GetThumbnail`。`WTS_INCACHEONLY` 只读命中项；常规模式允许 Shell 在未命中时调用已注册的系统缩略图处理程序提取并写入 Windows 缓存。`WTS_EXTRACTDONOTCACHE` 不作为普通策略，只有明确的一次性场景可评估使用。
- “读取缩略图缓存”指调用 Windows 公开 Shell API，不解析 `%LocalAppData%` 下的缓存数据库/文件，也不绕过系统权限。系统缓存未命中、无可用 handler、格式不支持、文件不可读或超时均为正常可呈现状态。
- 应用侧仅可缓存已返回的引用/结果以减少重复 IPC；此缓存是可丢弃的短期 UI 缓存，不是缩略图生成或持久缓存。默认使用路径 + 文件修改时间/大小 + 请求尺寸作为失效线索，并受内存上限控制。
- 非 Windows 平台不伪装成系统缩略图能力；返回 `unsupported-platform` 并展示类型图标，后续如支持其他平台须各自定义原生 provider。

## 用户入口、显示与交互

- 文件浏览网格中的可见图片/视频/文档卡片按需请求缩略图；列表视图仍以类型图标为主，不为不可见行预取。右侧 inspector 预览区在每个文件焦点变化后默认请求并显示该文件的 Windows 系统缩略图，用户切换到统一预览时不由本插件读取原文件内容。
- 文件夹、快捷方式、未知类型或无法读取缩略图时显示现有类型图标。等待时显示稳定占位，不闪烁、不改变卡片尺寸；失败不显示损坏图标。
- 管理性设置页可提供“使用 Windows 系统缩略图”和“仅读取系统已有缓存”两项。关闭系统缩略图后消费者停止新请求并回落图标；仅缓存模式下未命中不触发提取。
- 请求在可见、选中/预览需要、且当前插件启用时发起。滚出视口、切目录、文件被删除或组件卸载时取消/忽略过期请求；同路径同版本同尺寸的并发请求合并。
- 成功返回后淡入显示，短淡入不超过 120ms；占位和失败图标不执行反复动画。系统提取耗时较长时保持静态占位，不在大量文件上同时播放加载动画。

## 数据处理与状态

状态按单个文件/尺寸维护：`idle → checking-cache → extracting → ready`，可转入 `cache-miss`、`unsupported`、`denied`、`missing`、`timeout`、`error` 或 `cancelled`。仅缓存模式下缓存未命中直接到 `cache-miss`。

- 请求身份必须绑定规范化 path、mtime/size、edge、会话/消费者和 request id；响应只在身份仍匹配时接纳，避免切换文件后旧图覆盖新图。
- Shell 提取阶段由宿主执行并设置并发上限；UI 懒加载并限并发，队列在离开视口时可撤销。缓存命中和提取耗时只用于诊断，不向普通用户展示路径或原生错误码。
- 缩略图返回值只用于当前受权消费者显示；不记录图像二进制/数据 URL 到日志、数据库或插件偏好。文件系统监视、目录刷新、删除/移动/重命名事件使相关短期结果失效。
- 页面卸载、插件停用、会话关闭时释放对象 URL/图像资源、清空消费者引用并取消请求；不得清理或改写 Windows 缩略图缓存。

## 数据传递、插件协作与权限

- `plugin-file-browser`、`plugin-preview` 等各自以自己的 manifest capability 权限调用 `shell.thumbnail.read`；插件间不传输原始图像、不互相 import、不经全局事件广播大量数据。
- 用户可见状态变化使用轻量事件 `thumbnail:state:changed`（文件引用、状态、消费者请求 id）；图像内容通过 capability 响应/短时资源句柄返回，不放入事件 payload。
- capability 必须校验调用插件授权、文件路径位于允许访问范围、目标仍存在、请求尺寸在白名单/上限内；超时、取消和后台提取在 Rust/COM 边界安全处理。
- 这会替换现有 `thumb.image`（Rust `image` 解码、缩放、PNG 编码）及 dev mock 的 canvas 缩略图。开发 mock 只返回预置样例图或显式 `unsupported`，不得在模拟路径生成缩略图。

## 持久化与验收

- 设置存入该插件自己的版本化键，例如 `fm.windows-thumbnails.prefs.v1`：`{enabled, cacheOnly}`；默认 `enabled: true, cacheOnly: false`。值读写两侧校验；损坏时回默认值。会话焦点、请求队列和结果索引均为运行时状态，不持久化。
- 验收覆盖：Windows 缓存命中、仅缓存未命中、Shell 提取并缓存、无 handler、格式不支持、无权限/文件不存在、超时/取消、快速切换焦点、超大目录并发限制、文件修改后失效、插件关闭回退图标，以及非 Windows 的明确降级。
- 必须验证从 UI 到 Shell API 的链路不调用应用图像解码/生成管线；清查所有 `thumb.image` 调用、`image`/`fast_image_resize` 缩略图依赖和 canvas mock，确保没有遗留消费者。

## 实现依据

Windows API 参考：[IThumbnailCache::GetThumbnail](https://learn.microsoft.com/en-us/windows/win32/api/thumbcache/nf-thumbcache-ithumbnailcache-getthumbnail)、[WTS_FLAGS](https://learn.microsoft.com/en-us/windows/win32/api/thumbcache/ne-thumbcache-wts_flags)。`WTS_INCACHEONLY` 仅返回已缓存图；默认提取策略由系统 handler 处理未命中。调用细节、COM 生命周期和线程模型必须按 Windows 官方接口约束实现并验证。
