# `plugin-layout-panes` · 分栏容器

**状态：现有。** 负责 C 主视图的栏位数量、排列与分隔比例，不处理目录/文件业务。挂载 `main-view-zone`，在 `topbar-zone` 提供分栏下拉菜单，并向下提供 `pane-slot:<paneId>`。

## 功能与交互

- 提供单栏、左右双栏和 2×2 四栏三种布局；工具栏按钮显示当前选择，菜单项标出当前值。
- 双栏/四栏显示栏头和分隔条；用户拖动分隔条调整比例，比例限制在 15%–85%。单栏不显示重复栏内导航；多栏每栏保留自己的浏览工具。
- 增减可见栏时保留稳定 paneId。由一栏切到多栏创建新 id；切回较少栏位隐藏暂不可见 outlet，不能把其路径状态挪给其他栏。按会话独立保存布局。
- 下拉菜单用 Mantine Menu；点击即切换，ESC/外点关闭，键盘可选；布局变化约 180–240ms 平滑重排。减少动态效果时立即完成。

## 数据处理与状态

- 输入：`activeTabId`、用户选定布局、拖动分隔条的位移。
- 输出：本会话 `{mode,ids,seq,colPct,rowPct}`、对应 pane outlets，以及实际增减时的 `slot:reconfigured`。
- `fm.layout-panes.v1` 以 tab id 为键。读取后校验 mode、唯一 pane id、序号和比例；数据损坏回退到 `{mode:1,ids:["p0"],...}`。持久化失败只影响重启恢复。
- 几何必须是有界 grid/flex；pane outlet 不承担滚动，内容插件负责滚动和虚拟列表视口。

## 插件交流

- 读取基座状态，不发布业务焦点。向 `topbar-zone` 注册控制器，让本插件菜单切换当前活动会话的布局。
- 增加 pane 时先提交 pane 状态并挂载 outlet，再发 `slot:reconfigured {slotId, action:"add"}`；运行时挂载后发 `slot:registered`。移除时通知 `action:"remove"`，运行时卸载后发 `slot:disposed`。
- `plugin-file-browser` 扫描已存在的 `pane-slot:*`，为新 outlet 注入内容。容器不调用 `fs.*`，不读取浏览器的目录状态。

## 状态与验收

首次启动、切 1/2/4 栏、拖动比例、快速切会话、关闭再打开、存储损坏、内容插件禁用/启用都应可恢复；栏 id 不重复，其他会话路径不串栏，布局状态不会把内容撑出视口。
