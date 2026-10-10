# `plugin-inspector` · 详情容器

**状态：现有。** 负责 D 区详情框架、焦点标题、详情 tab 和预览/属性扩展区的排列。挂载 `file-sidebar-zone`，提供 `detail-tab:*`、`preview-zone`、`detail-info-zone`、`file-extension-zone`。

## 功能与显示

- 顶部显示焦点名称、完整路径（截断显示但可查看）与 kind 徽标；无焦点时显示说明空态。
- 默认“信息”tab。文件信息区按预览、属性、扩展区排列；文件夹不显示不适用的文件预览；未知 kind 使用通用模板。
- 额外详情 tab 由实际贡献 `detail-tab:<name>` 的插件决定，标题读取该插件 manifest 的 label；贡献消失时活动 tab 回到“信息”。空槽用统一占位提示。
- 内容过长由 D 区内部滚动；顶部标题/tab 不随内容滚走。tab 切换以约 120–180ms 的轻量切换反馈；其它 tab 保持挂载，防止状态丢失。

## 数据与插件交流

- 输入基座当前会话的 `focusRef`、`activeDetailTab` 和动态 slot 列表；不调用文件系统能力，不解释焦点路径内容。
- 用户切 tab 时发 `detail:tab:changed {tabId}`；`host.onStateChange` 恢复会话的 tab。通过 `contributedSlots`/`slotLabel` 发现其它插件提供的详情页面。
- 子区由 `provideSlot` 渲染；属性由 `plugin-file-details` 提供，`preview-zone` 由 `plugin-preview` 承载：默认显示它自己经 `shell.thumbnail.read` 取到的 Windows 系统缩略图，用户显式点击才启动 Open File Viewer 读正文；历史由 `plugin-file-history` 的独立详情 tab 提供。任何子插件失败只影响自身槽。

## 状态与验收

分别验证 null/file/folder/unknown kind；焦点快速变化时容器只更新标题和区域模板，不缓存业务数据；详情 tab 动态增加/移除后菜单与 active state 有效；会话切换可恢复 tab；不存在插件时不出现空白异常或错误 tab。
