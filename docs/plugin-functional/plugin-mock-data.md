# `plugin-mock-data` · 压力数据入口

**状态：现有，仅开发环境。** 向 A 区贡献压力测试入口，向 B 区贡献 `nav-panel:stress`；不承担通用文件浏览功能。

## 功能与显示

- 显示 `/stress` 下的 1 千、1 万、10 万、50 万条目数据集，以及空目录、读取失败目录和说明文件。
- 点击数据集向级联状态发布目录 Ref，由真正的 file-browser 调用能力并显示数据；入口本身不绘制模拟文件列表。
- 列表状态含加载、空、错误、可点击数据集；当前活动视图标识与其他侧栏视图一致。数据集选择采用即时反馈，不做模拟长动画。

## 数据与隔离

- 通过 `fs.list` 读取 `/stress` 数据集清单；dev mock 为文件列表、stat、文本、hash、thumbnail 提供一致 shape，涵盖约定的 binary reject 与图片缩略图。
- 选择时发 `sidebar:view:changed`、`sidebar:selection:changed`，Ref 的 sourcePlugin 为本插件。实际条目数据由 mock capability provider 返回。
- 不持久化测试状态、不访问其他插件 store。仅注入浏览器 dev manifest 索引，Tauri/release manifest 不得包含本插件。

## 验收

量级与目录名称正确；每个数据集均沿正常插件调用路径进入浏览器；空/失败/binary 大数据状态可复现；生产 manifest/build 不加载压力数据入口；50 万条目不会绕过虚拟化测试对象。
