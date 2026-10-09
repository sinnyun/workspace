# `plugin-history-metadata` · 历史版本信息

**状态：规划。** 全栈辅助插件，为 Lore 创建的版本保存当时的文件展示信息，并把这些信息提供给历史面板。它不创建、列举、比较、切换或恢复 Lore 版本；Lore 版本操作仍由 `plugin-file-history` / Lore 适配层负责。

## 职责与边界

- 按 `repositoryId + revisionId + normalizedPath` 保存每个版本对应的展示快照：系统缩略图、文件名、扩展名/类型、文件大小、图片尺寸、修改时间、采集时间，以及属性缺失/不可用原因。
- LoreGUI 在同一 Lore 仓库/服务中创建 revision 时，也应记录该版本信息；Lore adapter 监听服务器 revision 通知并转成统一生命周期事件。未连接同一仓库/服务的 LoreGUI 本地修改不保证实时发现，用户连接或刷新仓库后再补采。
- 使用既有 Windows 系统缩略图能力读取版本创建时的缩略图，并保存缩略图快照，避免文件后来变化导致历史记录显示成当前版本的图片。不得自行解码并生成缩略图。
- 保存的数据用于识别和浏览历史版本，不作为文件内容、版本状态或 Lore revision 的事实来源。
- 不拥有 Lore 仓库连接/初始化、提交说明、stage/commit、revision 列表、差异或恢复语义；不直接调用 Lore CLI、Lore 数据库或 Lore 私有 API。
- 当前文件的打开、恢复或切换到历史版本，必须经由 `plugin-file-history` 发起，由其 Lore 适配层执行；本插件只从历史记录卡片发出带 `repositoryId/revisionId/path` 的请求事件，不写文件、不调用 Lore。

## 功能与显示

- 在历史面板每条 Lore revision 记录内显示该 revision 对应的缩略图、大小、图片宽高、类型/扩展名和采集时间。非图片不显示尺寸；系统无缩略图时显示文件类型图标和明确原因。
- 对历史记录元数据处于 `capturing` 时显示轻量占位；采集完成后更新卡片。采集失败不隐藏 Lore 版本记录，显示缺失状态和重试入口。
- 用户点击历史记录的“切换到此版本”时，本插件仅发出 `history:revision:restore-requested`，携带 revision 标识与当前文件 Ref；`plugin-file-history` 接收后展示覆盖确认并调用 Lore 恢复。恢复结果通过其既有状态/事件反馈到面板。
- 焦点文件、仓库或 revision 变化时，卡片严格按三元键绑定，不能因同名文件、同路径不同仓库或相同文件多个版本而串数据。
- 新版本信息加载完成采用轻量淡入；骨架、缺失占位和重试状态遵守 Mantine 主题和全局动效约定。

## 交互与状态

- 单条记录状态：`pending`、`capturing`、`ready`、`partial`、`unavailable`、`error`、`retrying`。
- 用户切换到旧版本时：卡片发请求 → Lore 历史插件接收并校验焦点/revision → Lore 插件执行自己的确认与恢复流程 → 返回成功/取消/失败 → 当前历史面板刷新；历史元数据插件不接触恢复进度之外的版本逻辑。
- 重试只重新采集展示属性，不得重建或改写 Lore revision。重复点击在请求处理中禁用，错误可重试。
- 焦点/仓库变化和卸载时取消未完成的属性读取；无法取消的系统查询结果只能写入其原始 revision key，不得应用到新焦点卡片。

## 数据处理与存储

- 版本创建链路由宿主/Lore 适配器提供明确生命周期通知：revision 创建时提供 operation ID 和只读、revision 绑定的 capture handle，成功后以不可变 `revisionId` 关联，失败则清理未绑定的 pending capture。内部创建可在提交边界采集；外部 LoreGUI 创建由 Lore 服务通知驱动，再由 adapter 提供该 revision 的只读文件视图。元数据采集是 best-effort，不阻塞或回滚 Lore 的版本创建。
- 为避免竞态，文件属性和缩略图必须来自同一版本创建边界。采集时记录源文件身份、大小、修改时间及可获得的版本文件指纹；与 Lore revision manifest 不匹配或源文件在采集期间变化时标记 `partial/unavailable`，不得把新内容信息误绑到旧 revision。
- `shell.thumbnail.read` 只取 Windows Shell/handler 缩略图；对外部 LoreGUI revision，由 Lore adapter 为 capture handle 提供短时只读文件视图供系统 Shell 读取，完成后撤销句柄/临时视图。文件大小、类型、mtime 和图片宽高经受控的 `file.metadata.read`/系统属性能力读取。非 Windows 平台显示 unsupported/无缩略图状态，不运行应用自制缩略图生成逻辑。
- 元数据行由本插件独占的 `db.historyMetadata.*` 管理，主键 `(repositoryId, revisionId, normalizedPath)`；包含 schema version、文件属性、采集状态、缩略图 blob key 和校验摘要。缩略图二进制放在应用数据目录的专属 blob 区，按内容 hash 去重；数据库只保存引用和尺寸/格式，不把大型图片作为事件 payload。
- 删除历史元数据与缩略图只清理本插件副本，不能删除原文件或 Lore 版本。保留策略按用户设置/应用维护策略执行；删除 Lore 仓库后将对应元数据标记为 orphan，用户确认清理后再删除。
- 存储损坏时隔离损坏记录并提供重新采集；无法恢复的缩略图退回文件类型图标。插件卸载不自动删除用户历史库，数据清理需经应用数据管理操作。

## 插件交流与能力契约

- 消费 Lore adapter 发出的 `lore:revision:creating` / `lore:revision:created` / `lore:revision:create-failed` 生命周期通知；created 事件覆盖应用内和 LoreGUI 经同一服务创建的 revision。只使用受限 capture handle 和必要元信息，不读取 Lore 私有存储结构，也不直接调用 Lore 版本管理 API。
- 提供受权限控制的 `db.historyMetadata.get/list/retry` 查询/刷新接口；通知面板 `history:metadata:updated {repositoryId,revisionId,path}`，事件只用于失效刷新，不携带缩略图 bytes。
- 通过 `history-record:metadata` 子插槽将元数据卡片贡献给 `plugin-file-history` 的版本行。`plugin-file-history` 提供插槽并处理 `history:revision:restore-requested`；两个插件不互相 import，也不读取对方私有 store。
- 只把 `repositoryId`、`revisionId`、文件 Ref、有限展示元数据和 blob key 作为跨插件契约；不要传原始绝对路径以外的任意路径访问能力、完整文件内容、Lore 凭据或大块缩略图数据。
- Rust contracts、宿主 capability 权限、前端 SDK 和两个插件 manifest 中的事件/插槽/权限必须同步冻结；默认最小权限，元数据插件不得申请 `lore.change.commit` 或 `lore.file.restore`。

## 失败处理与验收

- 验收版本覆盖：应用内与 LoreGUI（连接同一服务）创建 revision、普通文件、图片含尺寸、无缩略图、Windows Shell 超时/拒绝、采集期间文件被修改、Lore 提交失败、重复生命周期事件、重复路径不同 revision、仓库删除、损坏元数据、插件卸载和重试；另验未连接的 LoreGUI 仓库在显式连接/刷新后再补采。
- 点击切换验收：元数据卡片只发 restore request；确认、dirty 检查、Lore 调用和恢复结果均由 `plugin-file-history` 处理；取消/失败不会改动记录、源文件或 Lore 版本。
- 数据验收：每条 ready 元数据与具体 revision 唯一对应；选中另一个版本仍显示其自身缩略图/属性；修改当前文件后旧版本卡片不变化；清理本插件缓存不影响 Lore 历史。
- 性能验收：历史列表分页加载，缩略图按可见项延迟读取，事件不携带 blob，快速切焦点时迟到响应不会污染当前显示；普通浏览不等待历史元数据采集。
