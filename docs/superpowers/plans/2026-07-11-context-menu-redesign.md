# Context Menu Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the session right-click menu to two items (Rename via inline edit, Copy session ID), remove Archive/Delete from the menu, and polish styling.

**Architecture:** Pure frontend, single file (`src/components/PiSidebar.tsx`). Rename calls the existing `renameSession` IPC wrapper; Copy ID uses `navigator.clipboard`. No backend, no `useChat`, no `context-menu.tsx` changes.

**Tech Stack:** React 19, Radix ContextMenu (via shadcn `src/components/ui/context-menu.tsx`), lucide-react icons, Tauri v2 webview.

## Global Constraints

- 保留右键菜单触发方式（不改成悬停 ⋯）。
- 移除 Archive 与 Delete（含 `ContextMenuSeparator`）；Delete 保留为会话项悬停 trash 图标 + 确认对话框，不变。
- 新增 Rename（`Pencil` 图标，原位 inline 编辑）与 Copy session ID（`Copy` 图标，复制到剪贴板）。
- Rename 用 `onSelect` 触发（Radix 先关菜单再显示 input）；input 用 `autoFocus` + `onFocus select()`；`Enter` 提交、`Esc` 取消、`blur` 提交；空值/未改不提交。
- inline `<input>` 必须作为 `SidebarMenuButton` 的**兄弟节点**渲染（不能嵌套在 button 内 —— 非法 HTML 且会冒泡触发 selectSession）。
- Copy 反馈：菜单项文字瞬态切到 `Copied!` + `Check` 图标 1200ms；用 `useRef` 存 timer，组件卸载/切项时清理。
- `navigator.clipboard?.writeText(...)`，失败静默 catch。
- 样式：图标统一 `size-3.5`，沿用 shadcn 默认 token（`bg-popover`/`border`/`bg-accent`），不改 `context-menu.tsx`。
- 验证：`bunx tsc --noEmit` 0 错误，`bun run build` 成功，手动 `bun run tauri:dev` 验证交互。
- 后端无改动。

---

## File Structure

- `src/components/PiSidebar.tsx` — 唯一改动文件：重写 `ContextMenuContent`、加 inline rename state + 渲染、加 clipboard 复制 + 反馈、调整 imports。
- `src/components/ui/context-menu.tsx` — 不改。
- `src/api/commands.ts` — 已有 `renameSession(sessionId: string, title: string)`，直接 import 使用。

---

### Task 1: 重写 PiSidebar 右键菜单（Rename + Copy ID + inline 编辑 + 样式）

**Files:**
- Modify: `src/components/PiSidebar.tsx`（整体替换为下方完整内容）

**Interfaces:**
- Consumes: `renameSession(sessionId: string, title: string)` from `@/api/commands`（已存在）；`useChat()` 返回的 `sessions/activeSessionId/selectSession/createSession/deleteSession/loading`。
- Produces: 无新导出（PiSidebar 默认导出不变）。

- [ ] **Step 1: 用以下完整内容替换 `src/components/PiSidebar.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar"
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
  DialogFooter, DialogClose,
} from "@/components/ui/dialog"
import { Search, Settings, Puzzle, Code2, Plus, Trash2, Pencil, Copy, Check } from "lucide-react"
import { useChat } from "@/hooks/useChat"
import { renameSession } from "@/api/commands"
import type { AppView } from "./AppShell"

interface PiSidebarProps {
  mode: AppView
  onModeChange: (mode: AppView) => void
}

export default function PiSidebar({ mode, onModeChange }: PiSidebarProps) {
  const { sessions, activeSessionId, selectSession, createSession, deleteSession, loading } = useChat()
  const [search, setSearch] = useState("")
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Clear any pending copy-feedback timer on unmount.
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
  }, [])

  const matches = (s: { title: string }) =>
    !search.trim() || s.title.toLowerCase().includes(search.trim().toLowerCase())

  const filteredSessions = sessions.filter(matches)

  const handleDelete = useCallback(async (sessionId: string) => {
    await deleteSession(sessionId)
    setConfirmDeleteId(null)
  }, [deleteSession])

  const commitRename = useCallback((id: string, value: string, original: string) => {
    setRenamingId(null)
    const trimmed = value.trim()
    if (trimmed && trimmed !== original) {
      renameSession(id, trimmed).catch(() => {})
    }
  }, [])

  const handleStartRename = useCallback((id: string, title: string) => {
    setRenamingId(id)
    setRenameValue(title)
  }, [])

  const handleCopyId = useCallback((id: string) => {
    navigator.clipboard?.writeText(id).catch(() => {})
    setCopiedId(id)
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current)
    copyTimerRef.current = setTimeout(() => setCopiedId(null), 1200)
  }, [])

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={async () => { await createSession(); onModeChange("chat"); }} tooltip="New thread">
              <Plus />
              <span>New thread</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onModeChange(mode === "skills" ? "chat" : "skills")}
                isActive={mode === "skills"}
                tooltip="Skills"
              >
                <Code2 />
                <span>Skills</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => onModeChange(mode === "extensions" ? "chat" : "extensions")}
                isActive={mode === "extensions"}
                tooltip="Extensions"
              >
                <Puzzle />
                <span>Extensions</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <div className="px-3 py-2 group-data-[collapsible=icon]:hidden">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input placeholder="Search sessions..." value={search} onChange={e => setSearch(e.target.value)} className="h-8 pl-8 text-xs" />
            </div>
          </div>
        </SidebarGroup>
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto">
          <SidebarMenu>
            {loading ? (
              <div className="text-muted-foreground py-8 text-center text-xs">Loading...</div>
            ) : filteredSessions.length === 0 ? (
              <div className="text-muted-foreground py-8 text-center text-xs">
                {search.trim() ? "No matching sessions" : "No sessions yet"}
              </div>
            ) : (
              filteredSessions.map((s) => (
                <SidebarMenuItem key={s.id} className="group/item">
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className="relative flex items-center">
                        {renamingId === s.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") { e.preventDefault(); commitRename(s.id, renameValue, s.title) }
                              if (e.key === "Escape") { e.preventDefault(); setRenamingId(null) }
                            }}
                            onBlur={() => commitRename(s.id, renameValue, s.title)}
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 flex-1 rounded-sm bg-background px-1 text-sm outline-none ring-1 ring-accent"
                          />
                        ) : (
                          <SidebarMenuButton
                            isActive={activeSessionId === s.id}
                            onClick={() => { onModeChange("chat"); selectSession(s.id); }}
                            tooltip={s.title}
                          >
                            <span className={`size-1.5 flex-shrink-0 rounded-full ${activeSessionId === s.id ? "bg-accent" : "bg-muted-foreground"}`} />
                            <span className="flex-1 truncate">{s.title}</span>
                          </SidebarMenuButton>
                        )}
                        <button
                          className="text-muted-foreground hover:text-destructive absolute top-1/2 right-1.5 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover/item:opacity-100"
                          onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(s.id) }}
                          title="Delete permanently"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem onSelect={() => handleStartRename(s.id, s.title)}>
                        <Pencil className="size-3.5" />
                        Rename
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => handleCopyId(s.id)}>
                        {copiedId === s.id ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
                        {copiedId === s.id ? "Copied!" : "Copy session ID"}
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </SidebarMenuItem>
              ))
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => onModeChange(mode === "settings" ? "chat" : "settings")}
              isActive={mode === "settings"}
              tooltip="Settings"
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>

      <Dialog open={!!confirmDeleteId} onOpenChange={(open) => { if (!open) setConfirmDeleteId(null) }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete session permanently?</DialogTitle>
            <DialogDescription>
              This action cannot be undone. The session file will be permanently removed from disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose className="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 border bg-background hover:bg-accent">
              Cancel
            </DialogClose>
            <button
              className="inline-flex items-center justify-center rounded-md text-sm font-medium h-9 px-4 bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (confirmDeleteId) handleDelete(confirmDeleteId) }}
            >
              Delete
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Sidebar>
  )
}
```

- [ ] **Step 2: 类型检查 + 构建**

Run: `bunx tsc --noEmit && bun run build`
Expected: 0 类型错误，构建成功。

- [ ] **Step 3: 手动验证（`bun run tauri:dev`）**

1. 右键会话项 → 菜单出现，含 `Rename` / `Copy session ID` 两项；popover 背景/边框/图标对齐正常，无 Archive/Delete。
2. 点 `Rename` → 菜单关闭，标题原位变 input 预填且全选；改文字 `Enter` → 侧栏标题更新（后端 `rename_session` 同步）；`Esc` → 取消恢复；`blur` → 提交；空值或未改 → 不提交、不发 IPC。
3. 点 `Copy session ID` → 该项瞬态显示 `Copied!` + 绿色 ✓（约 1.2s 恢复）；剪贴板内容为该 session id（粘贴验证）。
4. 会话项悬停 → trash 图标出现 → 点击 → Delete 确认框正常（未受影响）。
5. 右键不出现原生菜单 / 菜单不出现：若仍不出现，在 `ContextMenuTrigger` 的 `<div>` 上加 `onContextMenu={(e) => e.preventDefault()}` 兜底（Radix 内部已 preventDefault，Tauri WebKit 下显式兜底更稳），重新验证。

- [ ] **Step 4: 提交**

```bash
git add src/components/PiSidebar.tsx
git commit -m "feat: redesign session context menu (Rename + Copy ID, remove Archive/Delete)"
```

---

## Self-Review

**Spec coverage:**
- 移除 Archive/Delete + Separator → Task 1 代码中 `ContextMenuContent` 只剩 Rename/Copy ID，无 Separator ✓
- Rename inline 编辑（Enter/Esc/blur/空值不提交）→ `commitRename` + input handlers ✓
- Copy session ID + 1200ms 反馈 + timer 清理 → `handleCopyId` + `copyTimerRef` + unmount cleanup ✓
- 样式优化（图标 size-3.5、token、不改 context-menu.tsx）→ 沿用默认，仅 PiSidebar 改 ✓
- inline input 不嵌套 button → 作为 SidebarMenuButton 兄弟节点 ✓
- "菜单不出现" 复核 → Step 3 第 5 条兜底 onContextMenu preventDefault ✓
- 后端无改动 → 仅前端 import 已有 renameSession ✓

**Placeholder scan:** 无 TBD/TODO，每步含完整代码或确切命令。

**Type consistency:** `renameSession(id, trimmed)` 匹配 `renameSession(sessionId: string, title: string)`；`commitRename(id, value, original)` 三处调用（Enter/blur）参数一致；`handleStartRename(id, title)` / `handleCopyId(id)` 与 onSelect 调用一致。