# `plugin-dev-slot-harness` · 嵌套槽自检夹具

**状态：现有，仅开发环境。** 用来验证 nested slot 的提供、贡献、运行时增删和越权拒绝行为；不是用户功能。

## 功能与处理

- 在 `bottom-drawer` 展示自检结果，提供 `dev-pane` 前缀并挂载两个 `dev-pane:<n>` outlet。
- 测试卡片读取当前 `focusRef`，只展示 kind/id/sourcePlugin 的安全摘要；不读取对应文件。
- 故意尝试未授权 contribute 到 `file-sidebar-zone` 和未授权 provide 前缀；应收到拒绝日志，不能形成可见槽或更改宿主状态。
- 监听 `slot:registered`、`slot:reconfigured`、`slot:disposed`，以 slotId/action 展示运行时顺序。

## 存储、动效和隔离

- 无持久化业务数据。状态来源于 PluginHost 和测试事件；关闭抽屉不改变槽注册逻辑。
- 新增/移除自检 outlet 显示即时状态变化，减少动态效果时不动画。
- 仅 dev index 装载；停用即撤销测试 slot 和事件订阅；不能让故意的越权调用影响其他插件。

## 验收

正确授权能 provide/contribute；越权两条路径被拒；注册/移除通知可观察；焦点摘要跟随 meta state；禁用后无 slot、listener 或 test event 残留；发布环境无此插件。
