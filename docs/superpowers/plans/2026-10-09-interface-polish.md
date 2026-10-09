# Interface Polish Implementation Plan

**Goal:** 保留插件化文件管理器结构，统一和提升整个界面的显示效果。

**Architecture:** 外壳提供全局主题与视觉变量，插件使用语义类和主题变量。保留所有插槽、事件、持久化键和组件挂载关系。

**Tech Stack:** React 19、TypeScript、Mantine 7、Vite、Tauri。

## Constraints

不升级依赖，不修改后端与生成文件，不改变默认布局和业务流程。样式规则必须兼容深浅色、缩减动画设置和键盘焦点。

## Tasks

- [x] 在 `apps/shell-ui/src/theme.ts` 和 `styles.css` 创建主题与共享样式，`main.tsx` 接入。外壳增加语义类；优化会话栏、工具栏、区域背景和拖动条。
- [x] 更新 `plugin-layout-panes` 与 `plugin-file-browser` 的语义类和尺寸，保持虚拟行估算与实际行高一致；统一列表、网格、地址栏与空状态。
- [x] 更新 inspector、details、preview、history、settings、favorites、tags、tree、logs 的视觉，保留组件和插槽身份。
- [x] 执行 `pnpm typecheck`、`pnpm build:plugins`、`pnpm build:shell`，预期 exit 0。浏览器检查主题、分栏、会话、侧栏、详情、设置与窄窗口；检查控制台错误和元素溢出。修复视觉问题并记录结果。
