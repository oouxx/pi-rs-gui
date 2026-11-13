# CLAUDE.md

## 基本原则

- 先读代码和相关文档，再动手修改；遵循现有风格、命名和目录结构。
- 只改与任务相关的代码，不做无关重构、格式化或依赖升级。
- 优先复用已有实现和依赖；新增依赖需要明确理由。
- 不确定的行为先查源码、文档或运行验证，不凭猜测下结论。

## 代码质量

- 改动保持最小、可读、可维护；避免过度抽象、重复逻辑和无用代码。
- 错误处理要明确：不吞异常；用户可见的错误要有反馈；日志不得泄露密钥、token、个人路径等敏感信息。
- 不提交凭据、临时调试代码、注释掉的代码块和无说明的 TODO。
- 生成物和锁文件按项目约定处理，不手工修改生成文件。
- 公共接口、配置格式或数据结构变更时，同步更新类型定义、调用方和文档。

## 验证

- 汇报或提交前，运行项目现有的格式化、类型检查、测试和构建命令。
- 新逻辑补充必要测试；修复 bug 优先补回归测试。
- 测试失败或步骤未执行时必须如实说明，不声称验证过未运行的内容。

## Git

- 未明确要求时，不提交、不推送、不打 tag。
- 在默认分支上提交前先建分支。
- 提交信息简洁，说明改了什么和为什么。
- 不覆盖或回滚他人未提交的改动。

## 交互与安全

- 需求不明确时先问关键问题，不自行扩大范围。
- 汇报时说明：改了什么、如何验证、剩余风险。
- 破坏性或不可逆操作（删除、重置、强制推送、发布、发送外部数据）先确认。


## Frontend Architecture & Design System Guidelines

Prioritize mature, battle-tested libraries, keep component source code accessible and under control, maintain a consistent design language, and strictly limit duplicate dependencies.

With the right libraries and clear constraints in place, even a one-shot implementation can produce excellent frontend results.

Use the following libraries consistently across the project:

- **UI components and design system:** shadcn/ui
- **Icons:** Lucide
- **Animations:** Motion
- **Resizable layouts:** react-resizable-panels
- **Drag and drop:** dnd-kit
- **State management:** Zustand

---
## UI/UX Design Principles
- Avoid unnecessary secondary labels and descriptions. Let the layout do the explaining.
- Prefer clarity and simplicity over information density.
- Do not repeat information that is already clear from the page context, navigation, or surrounding components.
- Every label, icon, badge, card, and description must serve a clear user purpose.
- Prioritize essential information and use progressive disclosure for secondary details.
- Preserve visual consistency across existing screens, including typography, spacing, colors, and component styles.
- Avoid decorative UI elements, excessive borders, nested cards, and unnecessary status indicators.
- For industrial monitoring interfaces, make critical states immediately recognizable without adding visual noise.
- Show additional explanations only when they help users understand an abnormal state or take action.
- Before adding a new UI element, consider whether removing or simplifying an existing element would achieve the same goal.
