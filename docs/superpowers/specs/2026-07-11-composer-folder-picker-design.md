# Composer 文件夹选择器（设置会话工作目录）

## 背景与问题

pi-gui 创建 agent session 时，工作目录（cwd）取自 `std::env::current_dir()`
（`src-tauri/src/state/internal.rs:615` `ensure_session`）。Tauri 应用从 dock/Finder
启动时，`current_dir()` 常为 `/` 或应用 bundle 目录等无效值，且被固化进 pi-rs 的
session JSONL 文件。pi-rs 的 bash 工具在执行前校验 cwd 存在性
（`pi-coding-agent/src/core/tools/bash.rs:243`），不存在即报错：

```
Working directory does not exist: <cwd>
Cannot execute bash commands.
```

用户无法在 GUI 中设置或更换工作目录。本功能在 composer 增加原生文件夹选择器，
让用户为会话选定一个真实目录作为 cwd，从而修复 bash 工具无法执行的问题。

## 架构边界

核心能力由 pi-rs 提供，pi-gui 只负责 UI 层与决策透传。

**pi-rs（无改动，复用现有能力）**
- `CreateAgentSessionOptions.cwd` —— 创建会话时设定工作目录
- `CreateAgentSessionOptions.fork_from` —— 从已有 session 文件 fork：由
  `SessionManager::fork_from`（`session_manager.rs:960`）创建新 session 文件，
  写入新 header（`cwd=target_cwd`、`parent_session=source`），并把源文件所有消息
  条目逐条复制到新文件，原文件不动。语义 = 复制历史到新 cwd 的新会话。
- bash 工具 cwd 校验（`bash.rs:243`）已正确。

**pi-gui（UI + 透传 + 决策）**
- 原生目录选择对话框（`tauri-plugin-dialog`）
- `SessionRecord` 存储 `cwd` 用于显示与透传
- `init_session` 把 `cwd` 与 `fork_from` 透传给 pi-rs SDK
- 决策：空会话原地设 cwd；有历史会话 fork 新会话

## 数据模型

`SessionRecord`（`src-tauri/src/state/internal.rs`）新增字段：

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub cwd: Option<String>,
```

随 `ui-state.json` 持久化。仅作显示与传给 pi-rs 之用，pi-gui 不自行解析/校验
目录语义。

## 后端

### `init_session` 改造（`internal.rs:359`）

- 新增参数 `fork_from: Option<String>`
- `cwd` 优先取 `SessionRecord.cwd`（在调用方解析），为空回退 `std::env::current_dir()`
- 透传到 `CreateAgentSessionOptions { cwd, fork_from, .. }`（当前固定为 `fork_from: None`）

### `ensure_session` 改造（`internal.rs:612`）

- 解析 cwd：取 `SessionRecord.cwd`，为空再 `std::env::current_dir()`
- 传给 `init_session`

### 新命令 `set_session_cwd`

```text
set_session_cwd(session_id: String, path: String) -> Result<DesktopState, String>
```

逻辑：
1. 校验 `path` 存在且是目录；否则返回错误，不改任何状态。
2. 查当前 session（按 `session_id`）的 `session_file`：
   - **无 `session_file`**（尚未初始化的空会话，无消息）→ 原地
     `sess.cwd = Some(path)`，无需重建 agent session。首条消息时 `ensure_session`
     用此 cwd。
   - **有 `session_file`**（已初始化，含历史）→ fork：
     - 调 `init_session(cwd=path, fork_from=Some(old_session_file))`，pi-rs 复制
       历史到新 cwd 的新 JSONL。
     - 新建 `SessionRecord`（新 id，title 继承原会话标题，`cwd = Some(path)`，
       `session_file` 由 SDK 返回后回填），push 进 `sessions`。
     - `selected_session_id` 切到新会话。
     - 原会话记录与文件原封保留。
3. 若 `path` 与当前 cwd 相同 → no-op，直接返回当前 state。
4. 通过 `mutate` 持久化并 emit `pi-gui:state-changed`。

fork 失败时回滚：不修改 `selected_session_id`，丢弃已创建的 `SessionRecord`，
返回错误。

## 前端

### UI（`src/components/ChatView.tsx` composer 区）

composer 上方增加一个 cwd chip：

```
┌─────────────────────────────────────────────┐
│  ...消息区...                                │
├─────────────────────────────────────────────┤
│ [📁 <basename> ▾]   ← 点击换目录              │
│ ┌──────────────────────────────────────┐    │
│ │ Ask anything...            [Send]     │    │
│ └──────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

- 已设 cwd：显示 `📁 <basename>`，tooltip 显示完整路径。
- 未设 cwd：显示 `📁 选择工作目录`（灰色），首条消息前回退到 `current_dir`。
- 点击 → 调 `@tauri-apps/plugin-dialog` 的 `open({ directory: true, multiple: false })`
  → 选中后调 `setSessionCwd(path)` 命令。
- 命令返回新 `DesktopState` 后，由现有 `pi-gui:state-changed` 监听刷新会话列表与
  当前会话；前端 `useChat` 在 `activeSessionId` 变化时重新拉 transcript（已实现），
  fork 出的新会话因继承历史会显示原对话内容。

### 命令封装（`src/api/commands.ts`）

新增 `setSessionCwd(sessionId: string, path: string)`，调用 `invoke("set_session_cwd", ...)`。

### 插件接入

- Rust：`src-tauri/Cargo.toml` 加 `tauri-plugin-dialog`；`src-tauri/src/lib.rs`
  `.plugin(tauri_plugin_dialog::init())`。
- 前端：`package.json` 加 `@tauri-apps/plugin-dialog`。
- 能力：`src-tauri/capabilities/default.json` 加 `"dialog:default"`。

## 错误处理

- 选中路径不存在或非目录：`set_session_cwd` 返回错误字符串，前端内联提示，chip 不变。
- fork 失败（源 session 文件损坏等）：回滚 selected_session_id，返回错误。
- 用户取消目录对话框：无动作。

## 测试

- 后端：`src-tauri/src/state.rs` 测试模块新增 `set_session_cwd` 两条路径
  （空会话原地设 / 有 session_file 时 fork），用临时目录 mock。运行 `cd src-tauri && cargo test`。
- 前端无测试框架，手动验证：
  1. 空会话选目录 → chip 更新 → 发消息触发 bash → 在所选目录执行，不再报错。
  2. 有历史的会话选新目录 → 生成新会话并切过去，transcript 显示原对话，
     agent 在新 cwd 下运行 bash。
  3. 重启应用 → 选中会话的 cwd 仍生效（`SessionRecord.cwd` 持久化 + session 文件 cwd）。

## 非目标

- 不做全局默认 cwd 设置（每会话独立）。
- 不在 composer 以外的地方提供目录选择入口。
- 不实现 pi-rs 已有的 fork 逻辑（直接复用 `fork_from`）。