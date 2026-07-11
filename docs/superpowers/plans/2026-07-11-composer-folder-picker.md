# Composer 文件夹选择器（设置会话工作目录）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 composer 加原生文件夹选择器，让用户为会话选定真实工作目录（cwd），修复 bash 工具 "Working directory does not exist" 报错；切 cwd 时复用 pi-rs 的 fork 能力复制历史到新会话。

**Architecture:** pi-rs 已提供 `CreateAgentSessionOptions.cwd` 与 `fork_from`（`SessionManager::fork_from` 复制历史到新 cwd 的新 JSONL），pi-gui 只做：装 `tauri-plugin-dialog` 弹原生目录选择框、`SessionRecord` 存 cwd 透传、`init_session`/`ensure_session` 解析 cwd、`set_session_cwd` 命令做"空会话原地设 / 有历史则 fork"的决策并调用 pi-rs SDK。

**Tech Stack:** Tauri v2、Rust（pi-coding-agent SDK）、React 19、`@tauri-apps/plugin-dialog`。

## Global Constraints

- pi-rs 核心能力（cwd、fork、session 持久化、bash cwd 校验）不改动，pi-gui 仅 UI/透传/决策。
- cwd 解析：`SessionRecord.cwd` 优先，为空回退 `std::env::current_dir()`（再回退 `$HOME/.pi-rs`，再 `/tmp`）。
- fork 语义：`fork_from = Some(旧 session_file)` + `cwd = 新目录`，pi-rs 把历史复制到新 cwd 的新 session 文件，原会话不动。
- session 目录是全局的 `~/.pi-rs/agent/sessions`（agent_dir-based，与 cwd 无关），fork 出的新文件落在同一目录，GUI 现有 `scan_existing_sessions` 已扫描。
- Rust 测试：`cd src-tauri && cargo test`；前端无测试框架，手动验证。
- 命名/文案：chip 未设 cwd 显示"选择工作目录"，已设显示 `📁 <basename>`。

---

## File Structure

- `src-tauri/src/state/internal.rs` — `SessionRecord.cwd` 字段、`resolve_session_cwd`、`CwdAction`/`decide_cwd_action`、`init_session` 增 `fork_from` 参、`ensure_session` 用 `SessionRecord.cwd`、`set_session_cwd` 命令实现。
- `src-tauri/src/commands/mod.rs` — `set_session_cwd` Tauri 命令薄封装。
- `src-tauri/src/lib.rs` — 注册 `set_session_cwd` 命令 + `tauri_plugin_dialog` 插件。
- `src-tauri/src/state/session.rs` — `create_session_simple` 补 `cwd: None`。
- `src-tauri/Cargo.toml` — 加 `tauri-plugin-dialog = "2"`。
- `src-tauri/capabilities/default.json` — 加 `"dialog:default"`。
- `src-tauri/src/state.rs` — 新增单测。
- `package.json` — 加 `@tauri-apps/plugin-dialog`。
- `src/api/commands.ts` — `setSessionCwd` 封装。
- `src/components/ChatView.tsx` — composer cwd chip + 文件夹选择。

---

### Task 1: `SessionRecord.cwd` 字段 + `resolve_session_cwd` helper + 测试

**Files:**
- Modify: `src-tauri/src/state/internal.rs:59-77`（`SessionRecord`）
- Modify: `src-tauri/src/state/session.rs`（`create_session_simple`）
- Test: `src-tauri/src/state.rs:17-30`（测试模块）

**Interfaces:**
- Produces: `SessionRecord.cwd: Option<String>`；`pub fn resolve_session_cwd(session_cwd: Option<&str>) -> String`

- [ ] **Step 1: 在 `SessionRecord` 加 `cwd` 字段**

`src-tauri/src/state/internal.rs`，在 `thinking_level` 字段后追加：

```rust
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
```

- [ ] **Step 2: 更新 `create_session_simple` 补 `cwd: None`**

`src-tauri/src/state/session.rs`，在 `create_session_simple` 的 `SessionRecord { ... }` 末尾 `thinking_level: None,` 后加一行：

```rust
        cwd: None,
```

- [ ] **Step 3: 写失败测试（`resolve_session_cwd`）**

`src-tauri/src/state.rs` 的 `#[cfg(test)] mod tests` 内追加：

```rust
    #[test]
    fn test_resolve_session_cwd_prefers_session_cwd() {
        let cwd = super::internal::resolve_session_cwd(Some("/usr/local"));
        assert_eq!(cwd, "/usr/local");
    }

    #[test]
    fn test_resolve_session_cwd_falls_back_to_current_dir() {
        let cwd = super::internal::resolve_session_cwd(None);
        // None 或空字符串都应回退到 current_dir，不应是空串
        assert!(!cwd.is_empty());
    }

    #[test]
    fn test_resolve_session_cwd_empty_string_falls_back() {
        let cwd = super::internal::resolve_session_cwd(Some(""));
        assert!(!cwd.is_empty());
    }
```

- [ ] **Step 4: 运行测试确认失败**

Run: `cd src-tauri && cargo test test_resolve_session_cwd`
Expected: 编译失败 / `resolve_session_cwd` 未定义。

- [ ] **Step 5: 实现 `resolve_session_cwd`**

`src-tauri/src/state/internal.rs`，在 `now_iso` 函数附近（`pub fn now_iso()` 之后）加：

```rust
/// Resolve the working directory for a session: prefer the session's stored
/// cwd (when non-empty), else fall back to the process current directory,
/// then `$HOME/.pi-rs`, then `/tmp`. Matches the previous `ensure_session`
/// fallback chain.
pub fn resolve_session_cwd(session_cwd: Option<&str>) -> String {
    if let Some(c) = session_cwd.filter(|s| !s.is_empty()) {
        return c.to_string();
    }
    std::env::current_dir()
        .ok()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| {
            std::env::var("HOME")
                .map(|h| format!("{}/.pi-rs", h))
                .unwrap_or_else(|_| "/tmp".into())
        })
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `cd src-tauri && cargo test test_resolve_session_cwd`
Expected: 3 passed。

- [ ] **Step 7: 提交**

```bash
git add src-tauri/src/state/internal.rs src-tauri/src/state/session.rs src-tauri/src/state.rs
git commit -m "feat: add SessionRecord.cwd + resolve_session_cwd helper"
```

---

### Task 2: `init_session` 增 `fork_from` 参数 + `ensure_session` 用 `SessionRecord.cwd`

**Files:**
- Modify: `src-tauri/src/state/internal.rs:359-406`（`init_session` 签名 + `opts`）
- Modify: `src-tauri/src/state/internal.rs:608-633`（`ensure_session`）

**Interfaces:**
- Consumes: `resolve_session_cwd`（Task 1）、`SessionRecord.cwd`
- Produces: `init_session(..., fork_from: Option<String>)` 新签名

- [ ] **Step 1: 修改 `init_session` 签名，加 `fork_from` 参数**

`src-tauri/src/state/internal.rs:359-365`，把签名改为：

```rust
    async fn init_session(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
        current_sid: &str,
        session_file: Option<String>,
        fork_from: Option<String>,
    ) -> Result<(), String> {
```

- [ ] **Step 2: 把 `fork_from` 透传进 `CreateAgentSessionOptions`**

`src-tauri/src/state/internal.rs:384-406`，把 `fork_from: None,` 改为：

```rust
            fork_from: fork_from.clone(),
```

- [ ] **Step 3: `ensure_session` 用 `SessionRecord.cwd` 解析 cwd，并传 `fork_from: None`**

`src-tauri/src/state/internal.rs:612-632`，替换为：

```rust
        let (sid, cwd, session_file) = {
            let state = self.state.lock().await;
            let sid = state.selected_session_id.clone();
            let sess_cwd = state
                .sessions
                .iter()
                .find(|s| s.id == sid)
                .and_then(|s| s.cwd.as_deref());
            let cwd = resolve_session_cwd(sess_cwd);
            let file = state.sessions.iter()
                .find(|s| s.id == sid)
                .and_then(|s| s.session_file.as_ref().filter(|f| !f.is_empty()))
                .cloned();
            (sid, cwd, file)
        };
        if sid.is_empty() {
            return Err("No active session".into());
        }
        self.init_session(app, &cwd, &sid, session_file, None).await
```

- [ ] **Step 4: 修复 `create_agent_session`（Store 方法，约 450 行）对 `init_session` 的调用**

`src-tauri/src/state/internal.rs` 中 `create_agent_session` 方法内调用 `init_session` 的地方，把 `self.init_session(app, &cwd, &sid, session_file).await` 改为加 `, None`：

```rust
        self.init_session(app, &cwd, &sid, session_file, None).await
```

（用 `grep -n "init_session(app" src-tauri/src/state/internal.rs` 找到所有调用点，全部补 `, None`，Task 4 会再加一处 fork 调用。）

- [ ] **Step 5: 编译确认**

Run: `cd src-tauri && cargo check`
Expected: 0 errors（warning 可忽略）。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/state/internal.rs
git commit -m "feat: thread fork_from through init_session, resolve cwd from SessionRecord"
```

---

### Task 3: `CwdAction` + `decide_cwd_action` 纯决策 + 测试

**Files:**
- Modify: `src-tauri/src/state/internal.rs`（新增 enum + fn）
- Test: `src-tauri/src/state.rs`

**Interfaces:**
- Produces: `pub enum CwdAction { NoOp, SetInPlace, Fork }`；`pub fn decide_cwd_action(session_file: Option<&str>, new_path: &str, current_cwd: Option<&str>) -> CwdAction`

- [ ] **Step 1: 写失败测试**

`src-tauri/src/state.rs` 测试模块追加：

```rust
    use super::internal::{CwdAction, decide_cwd_action};

    #[test]
    fn test_decide_cwd_noop_when_same_path() {
        let a = decide_cwd_action(Some("/old/sess.jsonl"), "/work", Some("/work"));
        assert!(matches!(a, CwdAction::NoOp));
    }

    #[test]
    fn test_decide_cwd_set_in_place_when_no_session_file() {
        let a = decide_cwd_action(None, "/work", Some("/elsewhere"));
        assert!(matches!(a, CwdAction::SetInPlace));
    }

    #[test]
    fn test_decide_cwd_fork_when_has_session_file_and_diff_cwd() {
        let a = decide_cwd_action(Some("/old/sess.jsonl"), "/new/work", Some("/old/work"));
        assert!(matches!(a, CwdAction::Fork));
    }

    #[test]
    fn test_decide_cwd_set_in_place_when_has_file_but_no_current_cwd() {
        // 已有 session_file 但从未记录过 cwd（旧会话）：视为需要 fork 以带上历史
        let a = decide_cwd_action(Some("/old/sess.jsonl"), "/new/work", None);
        assert!(matches!(a, CwdAction::Fork));
    }
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd src-tauri && cargo test test_decide_cwd`
Expected: 编译失败 / 未定义。

- [ ] **Step 3: 实现 `CwdAction` + `decide_cwd_action`**

`src-tauri/src/state/internal.rs`，`resolve_session_cwd` 之后加：

```rust
/// Decision for `set_session_cwd`: what to do when the user picks a new folder.
#[derive(Debug, Clone, PartialEq)]
pub enum CwdAction {
    /// Same as current cwd — do nothing.
    NoOp,
    /// Session has no agent session yet — set cwd in place on the record.
    SetInPlace,
    /// Session already has history — fork a new session (new cwd, copied history).
    Fork,
}

/// Decide the cwd action based on whether the session is already initialized
/// (has a session_file) and whether the new path differs from the current cwd.
pub fn decide_cwd_action(
    session_file: Option<&str>,
    new_path: &str,
    current_cwd: Option<&str>,
) -> CwdAction {
    if current_cwd.map(|c| c == new_path).unwrap_or(false) {
        return CwdAction::NoOp;
    }
    match session_file {
        None => CwdAction::SetInPlace,
        Some(_) => CwdAction::Fork,
    }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd src-tauri && cargo test test_decide_cwd`
Expected: 4 passed。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/state/internal.rs src-tauri/src/state.rs
git commit -m "feat: add CwdAction decision logic for set_session_cwd"
```

---

### Task 4: `set_session_cwd` Tauri 命令

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`（新增命令）
- Modify: `src-tauri/src/lib.rs:8-62`（注册命令）

**Interfaces:**
- Consumes: `init_session`（带 `fork_from`）、`decide_cwd_action`、`resolve_session_cwd`、`SessionRecord.cwd`
- Produces: Tauri 命令 `set_session_cwd(session_id, path) -> DesktopState`

- [ ] **Step 1: 在 `commands/mod.rs` 加 `set_session_cwd`**

`src-tauri/src/commands/mod.rs`，在 `rename_session` 命令之后加：

```rust
#[tauri::command]
pub async fn set_session_cwd(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
    path: String,
) -> Result<DesktopState, String> {
    store.set_session_cwd(&app, &session_id, &path).await
}
```

- [ ] **Step 2: 在 `lib.rs` 注册命令**

`src-tauri/src/lib.rs`，在 `commands::rename_session,` 行之后加：

```rust
            commands::set_session_cwd,
```

- [ ] **Step 3: 在 `internal.rs` 的 `Store` 上实现 `set_session_cwd`**

`src-tauri/src/state/internal.rs`，`Store` impl 内（`ensure_session` 之后）加：

```rust
    /// Set the working directory for a session. If the session is already
    /// initialized (has a session file with history), fork a new session with
    /// the new cwd (history is copied by pi-rs via `fork_from`). The original
    /// session is left untouched.
    pub async fn set_session_cwd(
        self: &Arc<Self>,
        app: &AppHandle,
        session_id: &str,
        path: &str,
    ) -> Result<DesktopState, String> {
        // Validate the path exists and is a directory.
        let p = std::path::PathBuf::from(path);
        if !p.is_dir() {
            return Err(format!("Working directory does not exist or is not a directory: {}", path));
        }
        let new_cwd = p.to_string_lossy().to_string();

        // Read the current session record (without holding the lock across init).
        let (current_file, current_cwd, title) = {
            let state = self.state.lock().await;
            let sess = state
                .sessions
                .iter()
                .find(|s| s.id == session_id)
                .ok_or_else(|| "Session not found".to_string())?;
            (
                sess.session_file.clone(),
                sess.cwd.clone(),
                sess.title.clone(),
            )
        };

        let action = decide_cwd_action(
            current_file.as_deref(),
            &new_cwd,
            current_cwd.as_deref(),
        );

        match action {
            CwdAction::NoOp => Ok(self.state.lock().await.clone()),
            CwdAction::SetInPlace => {
                let sid = session_id.to_string();
                let cwd = new_cwd.clone();
                Ok(self
                    .mutate(app, |s| {
                        if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sid) {
                            sess.cwd = Some(cwd.clone());
                        }
                    })
                    .await)
            }
            CwdAction::Fork => {
                let new_id = format!("sess-{}", chrono::Utc::now().timestamp_millis());
                let cwd_for_record = new_cwd.clone();
                let title2 = title.clone();
                // Push the new session record and select it.
                self.mutate(app, |s| {
                    s.sessions.push(SessionRecord {
                        id: new_id.clone(),
                        title: if title2.is_empty() {
                            "New thread".to_string()
                        } else {
                            title2.clone()
                        },
                        updated_at: now_iso(),
                        preview: String::new(),
                        status: "idle".to_string(),
                        has_unseen_update: false,
                        session_file: None,
                        archived_at: None,
                        config: None,
                        thinking_level: None,
                        cwd: Some(cwd_for_record.clone()),
                    });
                    s.selected_session_id = new_id.clone();
                })
                .await;
                // Initialize the new session by forking from the old one.
                // pi-rs copies the history into a new session file under the new cwd.
                let old_file = current_file.clone().unwrap_or_default();
                match self
                    .init_session(
                        app,
                        &new_cwd,
                        &new_id,
                        None,
                        if old_file.is_empty() { None } else { Some(old_file) },
                    )
                    .await
                {
                    Ok(()) => Ok(self.state.lock().await.clone()),
                    Err(e) => {
                        // Roll back: drop the new record and restore selection.
                        let old_sid = session_id.to_string();
                        self.mutate(app, |s| {
                            s.sessions.retain(|s| s.id != new_id);
                            s.selected_session_id = old_sid.clone();
                        })
                        .await;
                        Err(e)
                    }
                }
            }
        }
    }
```

- [ ] **Step 4: 编译确认**

Run: `cd src-tauri && cargo check`
Expected: 0 errors。

- [ ] **Step 5: 跑全部测试**

Run: `cd src-tauri && cargo test`
Expected: 全部通过（含 Task 1/3 的单测）。

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs src-tauri/src/state/internal.rs
git commit -m "feat: add set_session_cwd command (in-place + fork via pi-rs fork_from)"
```

---

### Task 5: 接入 `tauri-plugin-dialog`（Rust）+ capabilities

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/lib.rs:5-7`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Cargo.toml 加依赖**

`src-tauri/Cargo.toml`，在 `tauri = { ... }` 行之后加：

```toml
tauri-plugin-dialog = "2"
```

- [ ] **Step 2: `lib.rs` 注册 dialog 插件**

`src-tauri/src/lib.rs`，把

```rust
    tauri::Builder::default()
        .manage(state::Store::new_with_runtime())
```

改为：

```rust
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::Store::new_with_runtime())
```

- [ ] **Step 3: capabilities 加 `dialog:default`**

`src-tauri/capabilities/default.json`，`permissions` 数组改为：

```json
  "permissions": [
    "core:default",
    "core:event:default",
    "dialog:default"
  ]
```

- [ ] **Step 4: 编译确认**

Run: `cd src-tauri && cargo check`
Expected: 0 errors（首次会拉取 `tauri-plugin-dialog` 依赖）。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -m "feat: wire tauri-plugin-dialog for native folder picker"
```

---

### Task 6: 前端 `@tauri-apps/plugin-dialog` + `setSessionCwd` 封装

**Files:**
- Modify: `package.json`
- Modify: `src/api/commands.ts`

- [ ] **Step 1: 安装 plugin-dialog**

Run: `bun add @tauri-apps/plugin-dialog`
Expected: `package.json` 出现 `@tauri-apps/plugin-dialog`。

- [ ] **Step 2: 在 `commands.ts` 加 `setSessionCwd`**

`src/api/commands.ts`，在 `deleteSession` 之后加：

```ts
export function setSessionCwd(sessionId: string, path: string) {
  return tauriInvoke<DesktopAppState>("set_session_cwd", { sessionId, path });
}
```

- [ ] **Step 3: 类型检查**

Run: `bunx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 4: 提交**

```bash
git add package.json src/api/commands.ts
git commit -m "feat: add setSessionCwd wrapper + @tauri-apps/plugin-dialog"
```

---

### Task 7: ChatView composer cwd chip + 文件夹选择

**Files:**
- Modify: `src/components/ChatView.tsx`（imports、composer 区）
- Modify: `src/hooks/useChat.ts`（暴露当前 session cwd）

**Interfaces:**
- Consumes: `setSessionCwd`、`@tauri-apps/plugin-dialog` `open`、`useChat` 的 `activeSessionId`/sessions

- [ ] **Step 1: `useChat` 暴露当前 session 的 cwd**

`src/hooks/useChat.ts`，在 `return { ... }` 里加 `activeSessionCwd`：先在文件顶部 `sessions` state 已有；在 return 前计算：

```ts
  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionCwd = activeSession?.cwd ?? null;
```

并把 `sessions: SessionItem[]` 的 `SessionItem` interface 加 `cwd?: string | null`：

```ts
interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  cwd?: string | null;
}
```

在 `refreshState` 的 `setSessions(...)` map 里加 `cwd: s.cwd ?? null,`。

return 对象加 `activeSessionCwd,`。

- [ ] **Step 2: 在 `ChatView.tsx` 加 imports**

`src/components/ChatView.tsx` 顶部加：

```ts
import { open as openDialog } from "@tauri-apps/plugin-dialog"
import { setSessionCwd } from "@/api/commands"
import { Folder } from "lucide-react"
```

并在 `useChat` 解构里取 `activeSessionId` 与 `activeSessionCwd`：

```ts
  const { messages, sendMessage, streaming, loading, activeSessionId, activeSessionCwd } = useChat()
```

- [ ] **Step 3: 加 pickFolder 回调**

`ChatView` 组件内（`handleSend` 附近）加：

```ts
  const handlePickFolder = useCallback(async () => {
    if (!activeSessionId) return
    const selected = await openDialog({ directory: true, multiple: false })
    if (typeof selected !== "string" || !selected) return
    try {
      await setSessionCwd(activeSessionId, selected)
    } catch (e) {
      console.error("[setSessionCwd]", e)
    }
  }, [activeSessionId])
```

- [ ] **Step 4: 在 composer 上方渲染 cwd chip**

`ChatView.tsx`，在 composer 区 `<div className="border-hairline bg-bg-surface flex-shrink-0 border-t px-4 py-2">` 之前插入：

```tsx
        {/* Working directory picker */}
        <div className="border-hairline bg-bg-surface flex-shrink-0 border-t px-4 pt-2">
          <button
            type="button"
            onClick={handlePickFolder}
            disabled={!activeSessionId}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50"
            title={activeSessionCwd ?? "选择工作目录"}
          >
            <Folder className="size-3.5" />
            <span className="max-w-[260px] truncate">
              {activeSessionCwd
                ? activeSessionCwd.split("/").filter(Boolean).pop() ?? activeSessionCwd
                : "选择工作目录"}
            </span>
          </button>
        </div>
```

- [ ] **Step 5: 类型检查 + 构建**

Run: `bunx tsc --noEmit && bun run build`
Expected: 0 errors，构建成功。

- [ ] **Step 6: 手动验证**

Run: `bun run tauri:dev`
1. 新建空会话 → 点 chip → 选一个真实目录 → chip 显示目录名 → 发"列出当前目录文件"之类消息 → bash 在所选目录执行，不再报 "Working directory does not exist"。
2. 在有历史的会话点 chip → 选另一个目录 → 侧栏出现新会话并切过去 → 新会话显示原对话历史 → 发消息触发 bash → 在新目录执行。
3. 重启应用 → 选中会话 chip 仍显示所选目录。

- [ ] **Step 7: 提交**

```bash
git add src/components/ChatView.tsx src/hooks/useChat.ts
git commit -m "feat: composer folder picker chip to set session working directory"
```

---

## Self-Review

**Spec coverage:**
- SessionRecord.cwd → Task 1 ✓
- init_session fork_from + ensure_session cwd → Task 2 ✓
- set_session_cwd（空会话原地 / 有历史 fork）→ Task 3+4 ✓
- tauri-plugin-dialog + capabilities → Task 5 ✓
- 前端 plugin-dialog + 封装 → Task 6 ✓
- ChatView chip + picker → Task 7 ✓
- 错误处理（路径非目录、fork 回滚、取消）→ Task 4 Step 3 + Task 7 Step 3 ✓
- 测试（后端单测 + 手动）→ Task 1/3 单测 + Task 7 Step 6 手动 ✓

**Placeholder scan:** 无 TBD/TODO，每步含完整代码。

**Type consistency:** `resolve_session_cwd`、`CwdAction`、`decide_cwd_action`、`set_session_cwd`、`setSessionCwd` 命名跨任务一致；`init_session` 新签名在 Task 2 定义、Task 4 使用，参数顺序一致 `(app, cwd, sid, session_file, fork_from)`。