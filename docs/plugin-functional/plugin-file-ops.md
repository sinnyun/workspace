# `plugin-file-ops` · Windows 原生文件操作

**状态：规划，全栈；这是唯一的应用内文件写操作入口。** 前端插件组织操作入口和参数，Windows 后端适配器把实际读写委托给 Windows Shell；不另写文件复制/移动/删除算法。插件挂载 `topbar-zone`、`statusbar-zone` 和 inspector 的 `detail-info-zone` 操作区。

## 功能范围

- 打开文件：调用 Tauri opener 的系统默认关联程序；打开目录/在资源管理器中显示项目：调用系统 Explorer reveal。只使用系统默认 `open` 行为，不自行拼可执行命令、参数或提权 verb。
- 复制、移动、重命名、新建文件夹、删除：Windows 使用 Shell `IFileOperation` 对系统 Shell item 执行。文件夹递归、跨卷行为、系统冲突提示和进度窗口均交由 Windows 处理。
- 删除默认移入回收站，使用 `FOFX_RECYCLEONDELETE`；不提供静默永久删除。若需永久删除，作为显式的二次产品决策，不得把它混入普通“删除”。
- 用户入口包括顶栏新建/粘贴入口（如剪贴板文件操作后续实现）、详情区单项操作、键盘快捷操作，以及通过 `plugin-context-menu` 注册到文件/目录/空白区右键面板的上下文动作。首期支持当前焦点单项；多选操作仅在浏览器提供明确的 selection-set 契约后启用。
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
- Native progress 对话框由 Windows 管理；应用状态栏显示简短“正在由 Windows 处理”及最终成功/部分失败结果。若 progress sink 不可用，显示不确定状态，不伪造百分比。
- 操作按钮禁用重复提交并显示 busy；成功/失败状态轻量淡入，约 120–180ms；系统对话框自身动效不由应用覆盖。ESC/取消含义遵循系统操作返回值；应用表单可由 ESC 关闭且焦点返回触发器。
- 文件打开失败按文件不存在、没有默认应用、权限拒绝等显示可恢复信息；不捕获后假装打开成功。系统服务不可用或线程初始化失败时返回明确错误，不退化为自写拷贝实现。

## 插件间数据交流

- 本插件从 file-browser 当前焦点/明确 selection-set 获取源 Ref。Ref 仅用于选择；真正操作提交时发送经过验证的路径参数到 host capability，不把文件记录、组件或可变 selection store 写入基座。
- 通过 `host.contextMenu.registerItem` 注册适用于文件/目录条目和目录空白区的“打开”“在资源管理器中显示”“复制”“移动”“重命名”“移到回收站”“新建文件夹”等菜单项；`when/enabled` 按 target kind、selection 数和平台过滤。具体操作仍由本插件组织参数并调用自己的 Windows capability。
- 拟新增 Rust/SDK 能力：`shell.fileOperation`（copy/move/rename/delete/createFolder）、`shell.openPath`、`shell.revealItemInDir`、`shell.pickFile`、`shell.pickDirectory`。名称与 DTO 在实现前须冻结并同步 `contracts`、SDK、host 命令、默认 ACL 和本插件 manifest。
- 操作完成返回 operation id、结果类别、affected parent paths 和逐项错误摘要。需要后台或长任务通知时使用拟议 `file:operation:progress` / `file:operation:complete`；事件不得传文件内容或敏感错误堆栈。
- `plugin-file-browser` 根据受影响目录刷新可见列表；watcher 的 `file:changed` 供 `plugin-file-history` 等订阅者处理。操作插件不直接刷新或修改其他插件内部状态。
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
