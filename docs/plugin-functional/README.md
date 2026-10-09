# 插件功能文档

本目录按插件拆分功能规格，描述产品行为和实现方式，不包含详细代码。文档跟随当前仓库架构：外壳与状态容器留在基座，业务功能由插件拥有，插件通过授权插槽、能力和事件协作。

状态以仓库 manifest 和 `docs/08-plugin-catalog.md` 为准：**现有**表示已在仓库注册；**规划**表示目录已定义但尚无插件 manifest/完整实现；**待决**表示技术方案还需评估。条目中的“目标行为”是需要实现和验收的产品要求，不代表当前代码已全部支持。

## 全局约定

- 本目录每份文档对应一个插件。每篇都说明职责范围、用户功能、数据输入/处理/输出、显示与交互、切换和状态、存储、跨插件交流、失败处理及验收方式。
- 业务数据由所属插件负责解释和存储；基座只持有 `{kind,id,sourcePlugin}` 等不透明引用。插件不得直接导入另一个插件、读取另一个插件的私有 store，或把大块可变业务对象塞进全局元状态。
- 跨插件 UI 使用 manifest 声明的外层/嵌套槽；能力调用使用最小权限；前端事件走 PluginHost 事件总线；前后端事件必须在 Rust contracts 和 TS SDK 同步定义。规划中的事件/能力只有在契约冻结后才可使用。
- 异步区域按需具备 idle/loading/success/empty/error/progress/cancelled 状态；切换焦点、会话、目录或卸载插件时，过期结果不能覆盖当前画面。失败需要有可理解的中文说明和可恢复动作。
- Mantine 共享主题提供控件样式、色彩与焦点外观；普通反馈约 120–180ms，菜单/浮层约 160–220ms，布局重排约 180–240ms。动效表达状态变化；支持减少动态效果，关闭时缩短至近零。
- 每个持久化状态须明确 owner、键/分区、结构版本、范围（全局/会话/栏）、损坏回退和删除策略。存储失败不能阻断当前操作；不得把文件全文或秘密写入偏好。
- 文档中接口名和状态须与实际 manifest/SDK/`docs/08-plugin-catalog.md` 对齐；完成后更新“现状”与验收记录。

## 当前已注册插件

| 插件文档 | 插件 | 状态 |
|---|---|---|
| [plugin-layout-panes.md](plugin-layout-panes.md) | `plugin-layout-panes` 分栏容器 | 现有 |
| [plugin-layout-views.md](plugin-layout-views.md) | `plugin-layout-views` 侧栏视图容器 | 现有 |
| [plugin-inspector.md](plugin-inspector.md) | `plugin-inspector` 详情容器 | 现有 |
| [plugin-settings.md](plugin-settings.md) | `plugin-settings` 设置 | 现有 |
| [plugin-file-browser.md](plugin-file-browser.md) | `plugin-file-browser` 文件浏览 | 现有 |
| [plugin-view-file-tree.md](plugin-view-file-tree.md) | `plugin-view-file-tree` 目录树视图 | 现有 |
| [plugin-view-favorites.md](plugin-view-favorites.md) | `plugin-view-favorites` 收藏视图 | 现有 |
| [plugin-view-tags.md](plugin-view-tags.md) | `plugin-view-tags` 标签视图 | 现有 |
| [plugin-file-details.md](plugin-file-details.md) | `plugin-file-details` 文件属性 | 现有 |
| [plugin-file-history.md](plugin-file-history.md) | `plugin-file-history` Lore 文件历史与版本操作 | 现有基础快照；目标迁移 Lore |
| [plugin-preview.md](plugin-preview.md) | `plugin-preview` 统一预览 | 规划（整合现有 `plugin-preview-text`） |
| [plugin-mock-data.md](plugin-mock-data.md) | `plugin-mock-data` 压力数据入口 | 现有（开发期） |
| [plugin-devtools-log.md](plugin-devtools-log.md) | `plugin-devtools-log` 开发调试台 | 现有（开发期） |
| [plugin-dev-slot-harness.md](plugin-dev-slot-harness.md) | `plugin-dev-slot-harness` 插槽自检夹具 | 现有（开发期） |

## 插件目录中已规划的功能插件

| 插件文档 | 插件 | 状态 |
|---|---|---|
| [plugin-file-ops.md](plugin-file-ops.md) | `plugin-file-ops` Windows 原生文件操作 | 规划（改由系统 Shell 执行） |
| [plugin-windows-thumbnails.md](plugin-windows-thumbnails.md) | `plugin-windows-thumbnails` Windows 系统缩略图 | 规划（Shell 原生读取与缓存） |
| [plugin-search.md](plugin-search.md) | `plugin-search` 搜索 | 规划，索引引擎待选 |
| [plugin-storage-analysis.md](plugin-storage-analysis.md) | `plugin-storage-analysis` 空间分析 | 规划 |
| [plugin-history-metadata.md](plugin-history-metadata.md) | `plugin-history-metadata` 历史版本信息 | 规划（保存并展示 Lore revision 对应的缩略图和文件属性） |
| [plugin-context-menu.md](plugin-context-menu.md) | `plugin-context-menu` 右键菜单框架 | 规划（统一面板；业务插件自动注册动作） |

## 已取消的规划

| 插件文档 | 原规划 | 当前状态 |
|---|---|---|
| [plugin-archive.md](plugin-archive.md) | 压缩包内只读浏览与安全解压 | 已取消，不纳入当前开发路线；保留文档作为决策记录 |

仓库当前 manifest 中仍注册着旧 `plugin-preview-text`；它是待整合的过渡实现，不属于目标插件清单。旧 Markdown、图片、PDF、媒体独立预览文档已并入 `plugin-preview.md`，不再作为独立应用插件规划。

命令面板当前是基座预留槽，不是已注册插件；SDK 尚无插件命令注册 API。全局命令功能见 [09 插件功能规格与交互数据契约](../09-plugin-functional-spec.md)，在 API 单独设计前，不给业务插件伪造命令接口。
