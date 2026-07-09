# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Dev Commands

```bash
npm run dev              # Vite dev server (frontend only)
npm run build            # Vite production build
npm run tauri:dev        # Tauri dev mode (full desktop app, requires Rust toolchain)
npm run tauri:build      # Production Tauri build
npx shadcn@latest add <component>  # Add a shadcn/ui component
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

- **pi-rs crates** (git tag `v1.79.1`): `pi-coding-agent`, `pi-agent-core`, `pi-ai` — agent session, model registry, providers
- **Config**: `~/.pi-rs/agent/settings.json` for default provider/model/thinking level
- **Sessions**: Stored as JSONL files in `~/.pi-rs/agent/sessions/`
- **State persistence**: `~/.pi-rs/agent/ui-state.json` (active IDs only)
- **API keys**: Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
