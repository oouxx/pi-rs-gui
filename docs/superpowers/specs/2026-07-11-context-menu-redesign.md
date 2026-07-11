# 会话右键菜单重设计

## 目标

重设计侧边栏会话项的右键菜单：移除 Archive / Delete，新增 **Rename session**（原位 inline 编辑）与 **Copy session ID**（复制到剪贴板），并优化样式。Delete 保留为会话项悬停时已有的 trash 图标 + 确认对话框，不在右键菜单里重复。

## 背景

当前 `src/components/PiSidebar.tsx` 在每个会话项上包了 Radix `ContextMenu`（`src/components/ui/context-menu.tsx`），菜单内容为 Archive + Delete（destructive）。用户反馈菜单"不出现 / 点击无反应"，且 Delete 已有外部入口（悬停 trash 图标 + 确认框），Archive 用得少。重设计精简为两个高频操作并复核渲染可靠性。

## 架构边界

纯前端改动。后端 `rename_session` 命令 + `renameSession` 封装已存在，无需改后端。Copy session ID 用浏览器 `navigator.clipboard.writeText`，无需 Tauri clipboard 插件。

## 菜单内容（顺序）

1. **Rename** — `Pencil` 图标（`size-3.5`）。点击后关闭菜单，该会话项标题原位变为受控 `<input>`：
   - 预填当前 `s.title`，挂载时自动 focus + 全选文本。
   - `Enter` → 提交：若新值与原标题不同且非空，调 `renameSession(s.id, value)`；退出编辑态。
   - `Esc` → 取消，退出编辑态，恢复原标题。
   - `blur`（失焦）→ 按提交逻辑处理（等价 Enter，不弹确认）。
2. **Copy session ID** — `Copy` 图标。点击 → `navigator.clipboard.writeText(s.id)`，菜单项文字瞬态切到 `Copied!` + `Check` 图标约 1200ms 后恢复。`writeText` 失败时静默 catch（不阻塞）。

**移除**：`Archive`、`Delete permanently`（含 `ContextMenuSeparator`，因只剩两项不需要分隔符）。`variant="destructive"` 用法随之移除。

## 组件状态

在 `PiSidebar` 内新增本地 state（不污染 `useChat`）：

```ts
const [renamingId, setRenamingId] = useState<string | null>(null)
const [renameValue, setRenameValue] = useState("")
const [copiedId, setCopiedId] = useState<string | null>(null)  // transient feedback
```

- 进入编辑：`setRenamingId(s.id); setRenameValue(s.title)`（在 ContextMenuItem 的 `onSelect` 里，而非 `onClick`，确保 Radix 先关闭菜单再聚焦 input）。
- 提交/取消后 `setRenamingId(null)`。
- `copiedId` 用 `setTimeout(1200)` 复位；切到别的项复制时清前一个 timer。

## 渲染：inline rename input

会话项标题处条件渲染：

```tsx
{renamingId === s.id ? (
  <input
    autoFocus
    value={renameValue}
    onFocus={(e) => e.currentTarget.select()}
    onChange={(e) => setRenameValue(e.target.value)}
    onKeyDown={(e) => {
      if (e.key === "Enter") { e.preventDefault(); commitRename(s.id, renameValue, s.title); }
      if (e.key === "Escape") { e.preventDefault(); setRenamingId(null); }
    }}
    onBlur={() => commitRename(s.id, renameValue, s.title)}
    className="..."  // 见样式
  />
) : (
  <span className="flex-1 truncate">{s.title}</span>
)}
```

`commitRename(id, value, original)`：`setRenamingId(null)`；若 `value.trim()` 非空且 `!== original` 则 `renameSession(id, value.trim())`（失败 catch 静默）。

编辑态时，整行右键菜单不重复触发（input 覆盖标题区即可，无需额外禁用 trigger）。

## 样式优化

- 菜单项统一：`<ContextMenuItem>` 内图标 `size-3.5` + `gap-2`，文字 `text-sm`，沿用 shadcn 默认 `px-2 py-1.5`、`focus:bg-accent focus:text-accent-foreground`。
- 菜单容器 `ContextMenuContent` 沿用默认 `bg-popover text-popover-foreground border` token（73bead39 已补全），不改 `context-menu.tsx`。
- inline input 样式：`h-7 w-full rounded-sm bg-background px-1 text-sm outline-none ring-1 ring-accent`，与行高对齐；`flex-1` 占满标题区。
- Copy ID 反馈态：`Copied!` 用 `text-muted-foreground`，`Check` 图标 `size-3.5 text-emerald-500`。

## "菜单不出现" 复核

实现时复核两点，按需兜底：
1. `ContextMenuTrigger asChild` 当前包了一个含 `SidebarMenuButton`（button）+ 删除 button 的 `<div>`。确认右键事件能冒泡到 trigger。若 inner button 吞掉右键，则在 trigger div 上显式 `onContextMenu={(e) => e.preventDefault()}` 兜底（Radix 内部已 preventDefault，但 Tauri WebKit 下显式兜底更稳）。
2. Radix Portal 渲染到 `document.body`，`z-50`，确认不被侧栏 `overflow-y-auto` 裁剪（Portal 已脱离父容器流，理论上不受影响，复核即可）。

## 文件改动

- `src/components/PiSidebar.tsx` — 重写 `ContextMenuContent` 为 Rename + Copy ID；加 `renamingId`/`renameValue`/`copiedId` state、`commitRename`、inline input 渲染、clipboard 复制 + 反馈；移除 Archive/Delete 项与 `Archive`/`Trash2`（Delete 项的）图标导入（`Trash2` 仍用于悬停 trash 按钮，保留）。`Archive` 图标导入移除。
- `src/components/ui/context-menu.tsx` — 不改。
- 后端 — 不改。

## 测试

前端无测试框架，手动验证（`bun run tauri:dev`）：
1. 右键会话项 → 菜单出现，含 Rename / Copy session ID 两项，样式正常（popover 背景、边框、图标对齐）。
2. 点 Rename → 菜单关闭，标题变 input 预填且全选；Enter 提交后侧栏标题与后端更新一致；Esc 取消；blur 提交；空值/未改不提交。
3. 点 Copy session ID → 项瞬态显示 `Copied! ✓`，剪贴板内容为该 session id。
4. 悬停 trash 图标 → Delete 确认框仍正常（未受影响）。
5. `bunx tsc --noEmit` 0 错误，`bun run build` 成功。

## 非目标

- 不改为悬停 ⋯ 下拉菜单。
- 不把菜单扩展到聊天区消息。
- 不加 Archive 的替代入口（移除即移除）。
- 不引入 toast 基础设施（Copy 反馈用菜单项内联）。