# pi-gui-rs

A Tauri v2 + React 19 desktop GUI for [pi-rs](https://github.com/oouxx/pi-rs) — the Rust port of
[pi-coding-agent](https://github.com/earendil-works/pi).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop Shell | Tauri v2 (Rust) |
| Frontend | React 19 + TypeScript |
| Styling | Tailwind CSS v4 + shadcn/ui |
| Agent Runtime | pi-rs crates (git tag pinned in `src-tauri/Cargo.toml`) |

## Features

- **Chat** — streaming assistant messages, thinking blocks, tool-call cards
  with **inline edit diffs** and **open-file-in-editor**, Stop button,
  **send while a turn is running** (Enter = steer, Alt+Enter = follow-up),
  context-usage indicator, per-session thinking level, in-chat search
  (Cmd/Ctrl+F), copy message/code, draft persistence
- **Composer** — `/` real pi-rs slash commands (grouped, with argument
  completion for `/model` & `/login`), `@` workspace file completion aligned
  with the TS original autocomplete (fuzzy scoring, path scoping, quotes,
  `~` expansion, directory continuation, Tab trigger), image attachments and
  inlined **text/code file attachments** (paste or drop)
- **Sessions** — sidebar with title + **full-text message search** / rename /
  copy ID / archive / delete / export (HTML + JSONL) / working-directory
  picker / relative timestamps; session info panel; Timeline panel for
  fork-tree navigation
- **MCP** — Settings → MCP manages `mcp.json` servers (global/project),
  enable/disable, exposure, add/edit/delete, live status + tools,
  resource/template browsing and reading, reconnect, OAuth sign-in, and
  server logs
- **Model picker** — searchable provider/model selector in the chat header
  (switches the session model and persists the default), thinking-level
  selector driven by the model's supported levels, and **scoped models**
  (Ctrl/Cmd+P cycling, Shift = backward)
- **Skills / Extensions** — real data from pi-rs; built-in Rust extensions
  (subagent, web_search) can be enabled/disabled from the Extensions view.
  Skills has a **Prompts** tab listing file-based `/prompt` templates with
  open-in-editor; skill files can be opened directly in the external editor
- **Settings** — General / Models / MCP / Skills / Extensions / Keybindings /
  About. General covers compaction budgets, steering/follow-up modes,
  transport, cache warming, project-trust default, external editor, shell
  prefix, and skill/prompt resource paths — all backed by pi-rs
  `SettingsManager`. Keybindings are customizable (record a new Cmd/Ctrl
  combination, conflict-checked, persisted)
- **Appearance** — system / light / dark themes (sidebar toggle or Settings)
- **Internationalization** — English and 简体中文 dictionaries with system
  detection; language is selectable in Settings → General
- **Terminal** — embedded xterm.js shell (spawns `$SHELL` in the session cwd)
- **Notifications** — OS notification when a background session finishes
- **Global shortcuts** — Cmd/Ctrl+N new thread, Cmd/Ctrl+K focus composer,
  Cmd/Ctrl+P cycle scoped models, Cmd/Ctrl+, settings, Cmd/Ctrl+F find in chat

## Architecture

```
┌──────────────────────────────────────────────────┐
│ WebView (React 19 + shadcn)                       │
│  AppShell ─ PiSidebar / ChatView / SkillsView /  │
│             ExtensionsView / TerminalView /       │
│             SettingsView                          │
│  hooks/useChat · hooks/useThreadSearch            │
│  api/commands.ts (invoke) · api/events.ts (listen)│
└───────────────────────┬──────────────────────────┘
                        │ Tauri IPC
┌───────────────────────┴──────────────────────────┐
│ pi-gui-rs (Rust, src-tauri/src)                   │
│  lib.rs (command registration) · commands/mod.rs  │
│  state/ (store, session, model, providers, skills,│
│          extensions, settings, files, tree,       │
│          terminal, export, transcript, ui, cwd)   │
└───────────────────────┬──────────────────────────┘
                        │ git tag dependency
┌───────────────────────┴──────────────────────────┐
│ pi-rs (github.com/oouxx/pi-rs, tag v1.82.x)       │
│  pi-coding-agent · pi-agent-core · pi-ai ·        │
│  pi-extensions                                    │
└──────────────────────────────────────────────────┘
```

### State Flow

1. Frontend calls a command wrapper in `commands.ts` → Tauri invoke → Rust command handler
2. Rust handler calls `Store::mutate()` (or a pi-rs SDK method) which modifies
   state, increments `revision`, emits `pi-gui:state-changed`, and persists `ui-state.json`
3. Frontend listens via `setupStateListener()` / `tauriListen()` and re-renders
4. Agent streaming: `send_message()` spawns a tokio task → pi-rs `AgentEvent`s
   are forwarded as `agent-event` Tauri events → transcript updates arrive via
   `pi-gui:selected-transcript-changed`

### 职责划分

pi-gui-rs 只负责 **UI 层**：Tauri IPC 封装、React 组件、UI 状态（`DesktopState` /
`SessionRecord` 只存 UI 元数据 + 透传字段）。agent 会话、工具执行、消息序列化、
session 持久化、模型解析等核心能力都在 pi-rs；本仓库不重新实现，只调用 SDK。
需要新核心能力时先在 pi-rs 实现并打 tag，再在这里升依赖（见 `CLAUDE.md` 工作流）。

## Quick Start

```bash
bun install            # Install frontend dependencies

bun run dev            # Vite dev server (frontend only)
bun run tauri:dev      # Tauri dev mode (full desktop app, requires Rust toolchain)
bun run tauri:build    # Production Tauri build

cd src-tauri && cargo test   # Rust tests
```

> The pi-rs crates are pinned by git tag in `src-tauri/Cargo.toml`
> (`pi-coding-agent`, `pi-agent-core`, `pi-ai`, `pi-extensions`). No local
> `../pi-rs` checkout is required at build time.

## Project Structure

```
pi-gui-rs/
├── src/                        # React frontend
│   ├── App.tsx                 # Router entry
│   ├── components/             # Views + shadcn/ui primitives (ui/)
│   │   ├── AppShell.tsx        # View switching shell
│   │   ├── ChatView.tsx        # Chat, composer, timeline, search
│   │   ├── PiSidebar.tsx       # Session list + navigation
│   │   ├── SkillsView.tsx      # Skill discovery
│   │   ├── ExtensionsView.tsx  # Registered Rust extensions
│   │   ├── TerminalView.tsx    # xterm.js terminal
│   │   ├── SettingsView.tsx    # Settings (6 tabs)
│   │   ├── ModelsSettings.tsx  # Providers / default model
│   │   ├── PickModel.tsx       # Model search combobox
│   │   ├── ToolCallCard.tsx    # Tool call rendering
│   │   └── ThinkingBlock.tsx   # Thinking block rendering
│   ├── hooks/
│   │   ├── useChat.ts          # Sessions, messages, streaming, events
│   │   └── useThreadSearch.ts  # In-chat find-in-chat
│   └── api/
│       ├── commands.ts         # Tauri invoke wrappers
│       └── events.ts           # Tauri event listener helper
├── src-tauri/                  # Tauri Rust backend
│   ├── src/
│   │   ├── lib.rs              # Command registration + plugins
│   │   ├── commands/mod.rs     # Thin command handlers
│   │   └── state/              # Store + domain modules
│   ├── capabilities/default.json
│   └── Cargo.toml              # pi-rs crates by git tag
└── package.json
```

## Environment

The app reads pi-rs standard config files and environment variables for API keys:
- `~/.pi-rs/agent/settings.json` (default provider / model / thinking level)
- `~/.pi-rs/agent/models.json` (custom providers)
- `~/.pi-rs/agent/sessions/` (JSONL sessions)
- Environment variables: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.

## Adding shadcn Components

```bash
bunx shadcn@latest add <component>
```
