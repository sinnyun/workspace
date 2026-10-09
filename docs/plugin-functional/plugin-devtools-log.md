# `plugin-devtools-log` · 开发调试台

**状态：现有，仅开发环境。** 在 `bottom-drawer` 展示运行错误、性能与白名单事件记录，方便检查插件间数据流。

## 功能与显示

- 捕获 console、window error、unhandled rejection、long task 和已允许事件；面板支持筛选、搜索、新旧排序、清空、JSON 导出。
- 环形缓冲上限 5,000；超限丢弃最旧记录并保持顺序。每行至少有时间、来源、类别、简短摘要；payload 默认摘要化，避免展示文件全文。
- 调试抽屉开合不改变主布局状态；记录新增可轻量高亮，不自动抢焦点、不滚动用户正在查看的位置。

## 数据处理与插件交流

- 订阅 `file:changed`、`history:updated`、级联事件、slot lifecycle 和旧版 `selection:changed` 白名单。事件记录包含事件名和允许公开的摘要，不能重发事件或改变它的 payload。
- 捕获器注册全局监听和 performance observer；卸载时必须逐项移除。循环缓冲在内存中，不写文件/数据库；JSON 导出由用户显式触发。
- 仅 dev plugin index 可装载，发布产物无此监听器。错误只隔离记录展示，不吞掉宿主的错误处理。

## 验收

验证缓冲 5,000 上限、过滤/排序/清空/导出可解析、异常摘要不泄露原文内容、stop/unload 后事件不再增长、dev 事件确实经过总线、生产索引不含此插件。
