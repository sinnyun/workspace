# `plugin-settings` · 设置容器

**状态：现有。** 活动栏底部齿轮打开浮动设置面板。负责软件级设置和承载插件自有设置页，不解释或代写其他插件的偏好。

## 功能与交互

- 软件设置页提供亮色/暗色/跟随系统主题和插件启停列表；插件设置页按贡献的 `settings-page:<name>` 展示子页，标题使用 manifest label。
- 核心插件（分栏容器、视图容器、详情容器、设置容器）标记为基础插件且不能关闭；其它插件开关即时执行启用或卸载。
- 面板固定尺寸，外层 header/tab 保持固定，当前页面独立滚动；切页不改变面板尺寸/锚点。齿轮显式控制打开状态；ESC/外点关闭并将焦点归还齿轮。
- 启停中显示 loading/disabled；成功后开关反映最新状态；失败提示原因并恢复原值。主题切换使用 Mantine 同一共享单例，面板内即时生效。

## 状态、存储与交流

- `plugins.list` 读取 manifest 索引与 loader 状态；`plugins.setEnabled {name,enabled}` 请求 loader 更新。能力由基座提供并受 manifest 授权，不发业务事件。
- `fm.plugins.disabled.v1` 由 loader 唯一读写；主题由 Mantine color-scheme 持久化；子页面偏好由各插件自己持久化。
- 通过 `contributedSlots("settings-page")`、`slotLabel` 和 `provideSlot` 动态列出设置页。插件停用时其设置页贡献移除；插件重新启用后重新扫描。

## 状态与验收

验证主题三态、外部系统主题改变、启停成功/失败、未知插件/受保护插件、设置子页增删、键盘焦点、损坏 disabled 列表和 localStorage 不可用。设置容器或核心插件状态不得出现可以点击但实际无法关闭的误导界面。
