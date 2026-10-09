# `plugin-file-browser` · 文件浏览

**状态：现有。** C 区文件/目录浏览内容插件；通过 `pane-slot:*` 自动进入各栏，在 topbar 提供地址导航与视图下拉，并向设置容器贡献“文件浏览”设置页。

## 功能与显示

- 每个 pane 独立显示后退、前进、上级、刷新、路径输入/提交、项目数，以及列表/网格切换。菜单当前值可见；单栏由顶栏统一显示导航，多栏时每栏保留独立导航。
- 目录项排在文件前；列表和网格共享同一排序/数据流/选择语义。显示名称、文件类型图标、大小和修改时间；目录无大小时显示占位。列表和网格均虚拟化。
- 网格按可见性懒加载 Windows 系统缩略图；通过 `plugin-windows-thumbnails` 所属的 `shell.thumbnail.read` 能力获取，关闭缩略图偏好后停止新请求并隐藏已有图。失败时回退类型图标，不由本插件或应用生成缩略图。未来补标签 chips、表格视图时仍由本插件拥有行模型和当前目录。
- 空目录显示明确空态；读取错误显示原因和重试；路径输入校验失败保留原路径；快速切目录不得闪回旧结果。

## 处理与状态

- 输入 `fs.home`、`fs.list(path)`、`shell.thumbnail.read(path,edge,policy)`，并订 `sidebar:selection:changed`、`slot:registered`、`slot:disposed`。每次列表请求附本地请求序号，只有当前 path/session/pane 匹配时接纳结果。缩略图只接纳当前可见条目和文件版本匹配的响应。
- 导航栈区分 push、back、forward、parent、refresh；refresh 替换当前历史项；路径切换成功后更新 `cwd`。focus Ref 只表示当前交互文件/目录，不把完整条目对象发给全局状态。
- 每栏的 `fm.file-browser.v1` 用 `activeTabId|paneId` 隔离路径、模式和历史；默认模式/缩略图开关放 `fm.file-browser.prefs.v1`。显式的单栏模式优先于默认模式；新栏跟随默认值。
- 列表完成显示目录数/文件数/读取耗时。虚拟行窗口只渲染视口附近条目；应用短期结果引用与不支持类型负缓存受容量约束，停用/关闭时取消请求并释放图像资源；Windows 系统缓存由 Shell 独立管理。

## 插件间交流

- 接到 `sidebar:selection:changed` 时只处理本插件认识的 `kind`（目录/文件/或后续明确注册的 tag query）；Ref 是导航目标，不是数据本身。侧栏选目录后各栏按既定同步策略导航，标签查询必须经将来定义的 tags API。
- 用户聚焦行时发 `focus:changed {kind,id,sourcePlugin}`；详情容器据此挂载属性/预览/历史插件。焦点目标失效或离开可见目录时发 null/新焦点。
- 列表行、网格卡片和目录空白区域右键时，按 `browser.list.item`、`browser.grid.item`、`browser.empty` 等稳定 surface ID 调用 `host.contextMenu.open`；提供目标/选中 Ref、当前会话/栏和指针或键盘锚点，不自行绘制菜单，也不持有其他插件的动作项。
- 新 outlet 出现时扫描 `providedSlots("pane-slot")` 并注入；dispose 时撤销对应 pane contribution。不能从其他插件 import 视图组件。

## 设置、动效与验收

模式切换保持当前路径与有效焦点，列表/网格样式轻量过渡；导航按钮有 disabled 边界状态；地址栏 Enter 提交、Escape 恢复当前路径。设置项立即影响所有实例。

验收至少覆盖双栏/四栏路径隔离、前进后退分支、刷新不增栈、空目录、无权限/失效路径、快速切换过期响应、十万级数据虚拟化、Windows 缩略图命中/未命中/不支持的图标回退、缩略图开关及插件禁用/恢复；确认没有应用解码、canvas 绘制或自制缩略图路径。
