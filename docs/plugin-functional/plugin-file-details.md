# `plugin-file-details` · 文件属性

**状态：现有（基础属性与 BLAKE3）。** 向 inspector 的 `detail-info-zone` 贡献属性面板。

## 功能与显示

- 按当前焦点显示名称、路径、大小、扩展名/类型、修改时间和 BLAKE3。路径可换行；大小按 B/KB/MB/GB/TB 格式；未知或不适用值显示“—”。
- 文件夹不计算文件哈希，不读取文本；未知 kind 显示适用的通用属性或空状态。属性载入期间用局部 skeleton；哈希可独立加载，不让其它字段等待 hash 完成。
- 加入复制路径操作（使用宿主允许的剪贴板能力；未有能力前不能直接假设 clipboard 可用），复制成功给轻提示，失败保留可选择文本。

## 数据处理、存储和交流

- 读取当前 `focusRef`；文件调用 `fs.stat` 与 `hash.compute({path,algo:"blake3"})`。前者提供 size/mtime；扩展名仅作显示提示，不等同可靠 MIME 判断。
- 不持久化属性快照；每次焦点改变重新取数。以 request token 对应 kind/path，旧响应丢弃。目录/文件删除或权限拒绝分别显示可理解状态。
- 只订阅当前兼容事件 `selection:changed` 的实现需随 SDK 迁移到 `host.onStateChange`/focusRef，避免将兼容事件当唯一状态源；插件不向其他插件广播 metadata。
- 能力必须在 manifest 最小声明；长哈希如没有真实进度契约显示等待状态，不伪造百分比。

## 验收

文件、目录、null、未知 kind、网络/磁盘错误、权限拒绝、hash 失败、快速切焦点、组件卸载都不能显示另一个文件的哈希或路径；坏时间值不显示 NaN 日期。
