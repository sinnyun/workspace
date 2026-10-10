# `plugin-file-ops` · Windows 原生文件操作

**状态：已交付（批次 5）；这是唯一的应用内文件写操作入口。** 前端插件组织操作入口和参数，Windows 后端适配器把实际读写委托给 Windows Shell；不另写文件复制/移动/删除算法。插件挂载 `statusbar-zone`（运行中/结果一行状态），条目动作经 `plugin-context-menu` 贡献到浏览器的三个 surface。

## 功能范围

- 打开文件：调用 Tauri opener 的系统默认关联程序；打开目录/在资源管理器中显示项目：调用系统 Explorer reveal。只使用系统默认 `open` 行为，不自行拼可执行命令、参数或提权 verb。
- 复制、移动、重命名、新建文件夹、删除：Windows 使用 Shell `IFileOperation` 对系统 Shell item 执行。文件夹递归、跨卷行为、系统冲突提示和进度窗口均交由 Windows 处理。
- 删除默认移入回收站，使用 `FOFX_RECYCLEONDELETE`；不提供静默永久删除。若需永久删除，作为显式的二次产品决策，不得把它混入普通“删除”。
- 用户入口：右键面板里的 打开/在资源管理器中显示/重命名/复制到文件夹/移动到文件夹/移到回收站（贡献到 `browser.list.item`、`browser.grid.item`），以及空白区的 新建文件夹。**多选已经启用**：来源取 `context.targetRef` 与 `context.selectedRefs` 的去重并集——右键命中已选项时保留整个选择，命中未选项时浏览器已把选择收敛为该项（P7-12 规则），所以插件不需要自己的选区状态。收藏/标签 surface 故意不贡献条目动作：那里没有跨插件的失效契约，改名/删除后别的面板不会收敛。操作进行中（busy）所有条目动作即刻退出菜单，状态行只跟踪一个在途批次。
- 操作参数仍由应用收集：选择目标目录、输入新名称、选中来源、确认是否继续。Tauri dialog 用于系统文件/目录选择；名称输入和操作列表是应用 UI，但不自行执行 filesystem mutation。

## 系统调用方式

1. 前端通过获准的 PluginHost capability 发送结构化操作请求，包含操作类型、规范化源路径、目标目录/新名称；不允许传任意 Shell verb、命令行、程序名或脚本。
2. Rust host 校验 capability 权限、路径范围、来源/目标类型和危险自包含关系，再将请求交给 Windows 原生 provider。
3. Windows provider 在专用 COM **STA** 线程初始化 COM，创建 `IFileOperation`，设置宿主窗口 owner 与 operation flags，按请求调用 Copy/Move/Delete/Rename/NewItem，再执行 `PerformOperations`。不在 Tokio 通用 worker 上直接调用要求 STA 的 COM 接口。
4. Windows 自带冲突/权限/进度对话框是操作反馈的权威界面；应用不再实现第二套目录递归、字节复制、冲突合并或详细进度算法。可用 `IFileOperationProgressSink` 将每项结果/粗略进度回传状态栏，但不重复绘制另一条竞争的进度 UI。
5. 查询 `GetAnyOperationsAborted` 与 per-item HRESULT，返回完成、部分失败或用户取消结果。把 affected parent paths 返回前端刷新 file-browser；文件监听继续发布 `file:changed`，供 file-history 记录真实变更。

## 打开文件与原生对话框

- `shell.openPath(path)` 由 host 调用已注册的 `tauri-plugin-opener`，通过系统默认文件关联打开；`shell.revealItemInDir(path)` 使用系统文件管理器定位文件/目录。
- `shell.pickFile`/`shell.pickDirectory` 使用已注册的 `tauri-plugin-dialog` 返回文件系统路径。用户取消返回取消态，不视为错误。
- opener 的路径 scope 与应用 capability 白名单都要最小化；插件不能直接 import Tauri opener/dialog API 绕过 PluginHost。对 `.exe` 等可执行类型沿用用户明确触发的 Windows 默认 open 行为，不以管理员身份运行，不允许插件附加参数。

## 交互、显示、动效与状态

- 普通操作流程：idle → collect-input → validating → native-operation → completed/partial-failure/cancelled/failed。创建/重命名表单验证空名、非法字符和既存同名；实际冲突处理交 Windows 对话框。
- 删除前应用 UI 显示数量和路径并确认；随后 Windows 仍可显示系统确认/访问错误提示。取消对话框返回 cancelled，界面还原，不发成功通知。
- 冲突处理不是第二套 UI 而是**一次偏好选择**：modal 里的 同名时保留两者 / 覆盖同名项 / 同名时停止 映射到 Shell 的 conflict flags，因此后台线程不会被系统对话框阻塞；落点名仍由 Shell 决定，界面如实报"其中 N 项自动改名"（`outcome: renamed`）。`IFileOperation` 不给我们可信百分比，状态栏因此恒为**不确定进度**（共 N 项 + 当前项名），不画伪造的百分比；取消时先转"正在取消"，终态区分"完成 X 项 / 取消 Y 项"。
- 操作按钮禁用重复提交并显示 busy；成功/失败状态轻量淡入，约 120–180ms；系统对话框自身动效不由应用覆盖。ESC/取消含义遵循系统操作返回值；应用表单可由 ESC 关闭且焦点返回触发器。
- 文件打开失败按文件不存在、没有默认应用、权限拒绝等显示可恢复信息；不捕获后假装打开成功。系统服务不可用或线程初始化失败时返回明确错误，不退化为自写拷贝实现。

## 插件间数据交流

- 本插件从 file-browser 当前焦点/明确 selection-set 获取源 Ref。Ref 仅用于选择；真正操作提交时发送经过验证的路径参数到 host capability，不把文件记录、组件或可变 selection store 写入基座。
- 通过 `host.contextMenu.registerItem` 注册适用于文件/目录条目和目录空白区的“打开”“在资源管理器中显示”“复制”“移动”“重命名”“移到回收站”“新建文件夹”等菜单项；`when/enabled` 按 target kind、selection 数和平台过滤。具体操作仍由本插件组织参数并调用自己的 Windows capability。
- 已冻结的 Rust/SDK 能力：`shell.fileOperation`（`op`: copy/move/rename/create/delete，`toRecycleBin` 默认真）、`shell.cancelFileOperation`、`shell.openPath`、`shell.revealItemInDir`、`shell.pickFile`、`shell.pickDirectory`，以及同期冻结的 `file.kind`。DTO 在 `core-shared/contracts`（`FileOperationIn/Out/Progress/Item/Result`、`PickIn/PickOut`），经 `contract:check` 与 SDK 对齐。
- `shell.fileOperation` **只回执**（`operationId` + `queued` + `total` + `indeterminate: true`），真相一律走 `shell:operation:progress` / `shell:operation:done`：一次批量 Shell 调用可以活过任何合理的请求超时，所以调用本身不假装知道结果。终态载荷给逐项 `FileOperationItem`（`completed/renamed/skipped/failed/cancelled` + `reason` + Shell 原文 `message`）和 `crossVolumeMove`。
- `plugin-file-browser` 按 `file:changed` 重读可见列表；**该事件的载荷口径是条目路径**（与 watcher 同一说法），不是目录——每个订阅者自己判断这条路径是否落在自己正在显示的东西里。watcher 继续发布外部变更，供 `plugin-file-history` 等订阅者处理。操作插件不直接刷新或修改其他插件内部状态。
- 当前基座没有通用命令注册接口，命令面板入口暂不列为已实现功能；注册 API 完成后再接入。
- 右键动作通过 `host.contextMenu.registerItem` 注册，handler 仍由本插件调用自身能力；菜单框架只负责显示/派发，不复制 file-ops 业务逻辑。

## 存储与平台边界

- 不持久化 operation payload、绝对路径历史或文件内容；运行中的任务状态属于后端内存任务。若未来增加“覆盖偏好”，只存用户选择策略，不绕开系统安全确认。
- Windows 使用系统 Shell provider。非 Windows 当前不自动退回 `std::fs`/`fs_extra` 自行复制；需另行实现并验收对应 OS 的原生 provider，否则 UI 明确不支持这些写操作。`openPath` 按 Tauri opener 支持平台使用各自默认应用。
- 系统 Shell 语义可能包含用户取消、跨卷复制后删除的部分成功、目标冲突和管理员权限限制；插件如实报告结果，不承诺操作是数据库式事务或可自动回滚。

## 验收

- Windows Explorer 默认打开常见文档，并验证无默认关联时的错误；reveal 文件/目录打开资源管理器并定位目标。
- 复制/移动文件与目录、重命名、创建目录、删除到回收站；确认冲突、覆盖/跳过、用户取消、权限拒绝、只读目标、网络路径、跨卷、路径含空格/Unicode。
- 大目录/大文件显示 Windows 原生进度 UI；取消后报告真实部分结果；操作完成后 file-browser 刷新，file-history 由 watcher 更新。
- 验证 capability 与 opener scope 拒绝未授权路径；插件禁用时无新的 UI 操作入口；非 Windows 平台不静默执行自写 fallback。

## 系统资料

- [Microsoft: IFileOperation](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nn-shobjidl_core-ifileoperation) — Shell 文件操作、系统进度/错误提示以及 STA 线程要求。
- [Microsoft: SetOperationFlags](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags) — `FOFX_RECYCLEONDELETE` 回收站行为。
- [Tauri: Opener plugin](https://v2.tauri.app/plugin/opener/) — 默认程序打开和资源管理器定位。
- [Tauri: Dialog plugin](https://v2.tauri.app/plugin/dialog/) — 原生选择/确认对话框。
