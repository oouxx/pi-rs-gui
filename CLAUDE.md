# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
bun run dev              # Vite dev server (frontend only)
bun run build            # Vite production build
bun run tauri:dev        # Tauri dev mode (full desktop app, requires Rust toolchain)
bun run tauri:build      # Production Tauri build
bunx shadcn@latest add <component>  # Add a shadcn/ui component
```

- Rust tests: `cd src-tauri && cargo test` (single test in `state.rs`)
- No frontend test framework is configured

## Architecture

**Tauri v2 app** — Rust backend (`src-tauri/`) + React 19 frontend (`src/`) connected via Tauri IPC.

### State Flow

1. Frontend calls a command wrapper in `commands.ts` → Tauri invoke → Rust command handler
2. Rust handler calls `Store::mutate()` which modifies state, increments `revision`, emits `pi-gui:state-changed` event, and persists to disk
3. Frontend listens for `pi-gui:state-changed` via `setupStateListener()` and re-renders
4. Agent streaming: `send_message()` spawns a tokio task → agent emits `AgentEvent`s → serialized to `agent-event` Tauri events → transcript updates emitted as `pi-gui:selected-transcript-changed`

### Key Dependencies

- **pi-rs crates** (`pi-coding-agent`, `pi-agent-core`, `pi-ai`; current git tag pinned in `src-tauri/Cargo.toml`): agent session, agent loop, tool execution, model registry, providers, session persistence
- **Config**: `~/.pi-rs/agent/settings.json` for default provider/model/thinking level
- **Sessions**: Stored as JSONL files in `~/.pi-rs/agent/sessions/`
- **State persistence**: `~/.pi-rs/agent/ui-state.json` (active IDs only)
- **API keys**: Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)

### 职责划分：pi-rs vs pi-rs-gui

**pi-rs**（独立仓库 `../pi-rs`，tag 化发布）负责**核心功能**，按 crate 划分：

- **`pi-ai`**：统一多 provider LLM API（OpenAI / Anthropic / Google / OpenRouter 等）、模型注册（`api_registry`/`models`）、流式 `AssistantMessageEvent`、`ContentBlock` / `Usage` / `StopReason` 等类型、env API keys。
- **`pi-agent-core`**：agent 运行时——`AgentSession` 状态机（`agent.rs`）、`agent_loop`（工具调用循环 + `AgentEvent` 事件流）、`AgentMessage` / `AgentToolCall` / `AgentToolResult` 类型、MCP 支持（`mcp.rs`）、proxy。
- **`pi-coding-agent`**：coding agent 层——
  - **session**：`session_manager`（JSONL 持久化、`fork_from`）、`session_cwd`（cwd 解析 / 校验）、`agent_session` + `sdk`（`create_agent_session` / `CreateAgentSessionOptions`）、`compaction`、`settings_manager`、`auth_storage`、`trust_manager` / `project_trust`。
  - **工具**：`core/tools/`（`bash`、`edit`、`edit_diff`、`read`、`write`、`grep`、`find`、`ls`、`output_accumulator`、`truncate`、`file_mutation_queue` 等）。
  - **其它**：`model_registry` / `model_resolver`、`system_prompt`、`skills`、`slash_commands`、`extensions`、`modes`（interactive / print / rpc）、`cli`。
- **`pi-tui`**：终端 UI（pi-rs-gui 不使用）。

**pi-rs-gui**（本仓库）只负责 **UI 层面**：Tauri IPC 命令封装、React 组件与渲染、UI 状态管理（`DesktopState` / `SessionRecord` 只存 UI 需要的元数据 + 透传字段，如 `cwd`）、把用户操作翻译成对 pi-rs SDK 的调用、订阅 `AgentEvent` 并在前端展示。

**原则**：pi-rs-gui **不重新实现** pi-rs 已有的核心能力（fork、cwd 校验、工具执行、消息序列化、session 持久化、model 解析等）。需要新核心能力或修核心 bug 时，先在 pi-rs 实现，pi-gui 只调用。

### pi-rs bug 工作流

当问题定位到 pi-rs（核心功能）而非 UI 时，按以下流程：

1. **先对照 TS 原版**：pi-rs 是 `../pi`（github.com/earendil-works/pi）的 Rust 复刻（见 pi-rs 的 `pi-rust-port-spec.md`）。找到对应模块——`packages/ai`→`pi-ai`、`packages/agent`→`pi-agent-core`、`packages/coding-agent`→`pi-coding-agent`——看 TS 原版如何实现 / 处理该场景，再对照 pi-rs 的 Rust 实现定位差异（复刻遗漏或语义偏差常是 bug 根源）。
2. 进入 `../pi-rs` 修复（不要在 pi-gui 里绕过或重写核心逻辑）
3. 本地验证：`cargo test -p pi-coding-agent`（及相关 crate），必要时加 / 跑对应测试
4. 提交修复
5. 打新 tag，递增 patch 版本（如 `v1.79.3` → `v1.79.4`）：`git tag vX.Y.Z`
6. 推送 pi-rs 的 `main` 和新 tag：`git push origin main && git push origin vX.Y.Z`
7. 回到 pi-rs-gui，把 `src-tauri/Cargo.toml` 里三个 pi-rs crate 的 `tag = "vX.Y.Z"` 升到新 tag
8. `cd src-tauri && cargo update -p pi-coding-agent -p pi-agent-core -p pi-ai`，再 `cargo test` 验证
9. 提交 `src-tauri/Cargo.toml` + `src-tauri/Cargo.lock`，推送 pi-rs-gui

排查工具执行等问题时，先看 `~/.pi-rs/agent/sessions/*.jsonl`（session 头的 `cwd`、`toolCall`/`toolResult` 记录），并用 `scripts/inspect_session.py` 快速汇总；运行时日志见 `[CWD]` / `[TOOL]` 前缀（`src-tauri/src/state/internal.rs`）。
