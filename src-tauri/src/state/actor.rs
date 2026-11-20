//! SessionActor — one actor task per session (ACP-style).
//!
//! Each session gets a dedicated tokio task that OWNS its
//! `AgentSessionRuntime` and processes commands serially through an mpsc
//! mailbox (oneshot replies). Prompt turns run as separate tasks sharing
//! `Arc<AgentSession>`, so the actor stays responsive during a turn —
//! abort / set_model / navigate / compact work concurrently (matching
//! pi-acp's `SessionTask`, which holds `Arc<AgentSession>`).
//!
//! Multiple sessions run in parallel: the Store keeps a registry
//! (`HashMap<session_id, SessionHandle>`); switching the selected session
//! does NOT destroy the old actor, so background sessions keep streaming.

use std::sync::Arc;

use pi_agent_core::pi_ai_types::ContentBlock;
use pi_agent_core::types::AgentMessage;
use pi_coding_agent::core::agent_session::PromptOptions;
use pi_coding_agent::core::agent_session_runtime::AgentSessionRuntime;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

use super::logging::write_line;
use super::transcript::{
    build_display_transcript, build_display_transcript_interrupted, transcript_was_aborted,
    INTERRUPTED_TOOL_MESSAGE, STOPPED_TOOL_MESSAGE,
};
use super::types::FrontendEvent;
use super::{set_sess_status, Store};

/// `AgentSession::abort()` waits for idle, which never happens once the run
/// future was dropped mid-flight. Bound it; recovery kicks in on timeout.
const ABORT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long to wait for the agent-state lock when collecting the final
/// transcript after a failure. A wedged run can still hold it, and the
/// supervisor must not stall behind it.
const TRANSCRIPT_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

pub type SessionCommandSender = mpsc::UnboundedSender<SessionCommand>;

/// Handle to a running session actor (the sender side of its mailbox).
#[derive(Clone)]
pub struct SessionHandle {
    pub tx: SessionCommandSender,
}

pub enum SessionCommand {
    /// Run an LLM turn. Replies immediately (ack); streaming is event-driven.
    SendMessage {
        text: String,
        images: Vec<ContentBlock>,
        /// `steer` (interrupt) or `followUp` (wait) when a turn is running.
        streaming_behavior: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Abort the current run (if any). Works concurrently with a turn.
    Abort { reply: oneshot::Sender<()> },
    SetModel {
        provider: String,
        model_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    Compact {
        custom_instructions: Option<String>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// Switch the session to a different session file (matches TS `/import`).
    Import {
        path: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Reload {
        reply: oneshot::Sender<Result<(), String>>,
    },
    SetName {
        name: String,
        reply: oneshot::Sender<()>,
    },
    GetMessages {
        reply: oneshot::Sender<Vec<AgentMessage>>,
    },
    GetModel {
        reply: oneshot::Sender<serde_json::Value>,
    },
    /// Change the session's thinking level (persisted in the session file).
    SetThinkingLevel {
        level: String,
        reply: oneshot::Sender<serde_json::Value>,
    },
    /// Context-window usage for the header indicator.
    GetUsage {
        reply: oneshot::Sender<Option<serde_json::Value>>,
    },
    /// Cycle the session model through the scoped/all model list.
    CycleModel {
        direction: String,
        reply: oneshot::Sender<Option<serde_json::Value>>,
    },
    GetCommands {
        reply: oneshot::Sender<Vec<serde_json::Value>>,
    },
    /// Live MCP connection state/tools for the selected session.
    GetMcpSnapshot {
        reply: oneshot::Sender<Vec<serde_json::Value>>,
    },
    /// Reconnect one MCP server (after config or OAuth changes).
    ReconnectMcp {
        name: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    /// List resources + resource templates for one MCP server.
    GetMcpResources {
        name: String,
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    /// Read one MCP resource by URI.
    ReadMcpResource {
        name: String,
        uri: String,
        reply: oneshot::Sender<Result<serde_json::Value, String>>,
    },
    /// File-based prompt templates (`/name`) discovered by pi-rs.
    GetPromptTemplates {
        reply: oneshot::Sender<Vec<serde_json::Value>>,
    },
    /// Abort and terminate this actor (session close / delete).
    Shutdown,
}

/// The actor task itself. Runs until the mailbox is closed (all senders
/// dropped) or a Shutdown command is processed.
///
/// Only the shared `Arc<AgentSession>` is kept: everything the actor needs
/// (settings, registry, resources) lives inside the session. The runtime
/// wrapper (and its cwd-bound services) is dropped after construction — it is
/// not `Sync` (AuthStorage holds a non-Sync resolver), and holding `&self`
/// across awaits would make the actor's future `!Send`.
pub struct SessionActor {
    session: Arc<pi_coding_agent::core::agent_session::AgentSession>,
    cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    app: AppHandle,
    /// Used to flip the UI session status back to idle when a turn fails —
    /// a failed run never emits `agent_end`, so nothing else would.
    store: Arc<Store>,
    session_id: String,
    /// Shared with the event subscription so import swaps keep the
    /// emitted event session id in sync.
    sid_holder: Arc<std::sync::Mutex<String>>,
}

impl SessionActor {
    /// Create the actor with a pre-built runtime. The runtime's event
    /// subscription (established by the factory) already forwards
    /// `agent-event` payloads and updates session status.
    pub fn new(
        runtime: AgentSessionRuntime,
        cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
        store: Arc<Store>,
        app: AppHandle,
        sid_holder: Arc<std::sync::Mutex<String>>,
    ) -> Self {
        let session = runtime.session_arc();
        // The runtime (services / AuthStorage) is no longer needed — drop it.
        drop(runtime);
        let session_id = session.get_session_id();
        Self {
            session,
            cmd_rx,
            app,
            store,
            session_id,
            sid_holder,
        }
    }

    /// Spawn the actor task and return its mailbox sender.
    pub fn spawn(
        runtime: AgentSessionRuntime,
        store: Arc<Store>,
        app: AppHandle,
        sid_holder: Arc<std::sync::Mutex<String>>,
    ) -> SessionHandle {
        let (tx, rx) = mpsc::unbounded_channel();
        let actor = Self::new(runtime, rx, store, app, sid_holder);
        tokio::spawn(async move {
            actor.run().await;
        });
        SessionHandle { tx }
    }

    async fn run(mut self) {
        while let Some(cmd) = self.cmd_rx.recv().await {
            self.handle(cmd).await;
        }
    }

    async fn handle(&mut self, cmd: SessionCommand) {
        match cmd {
            SessionCommand::SendMessage {
                text,
                images,
                streaming_behavior,
                reply,
            } => {
                let _ = reply.send(Ok(()));
                self.start_turn(text, images, streaming_behavior).await;
            }
            SessionCommand::Abort { reply } => {
                let settled = tokio::time::timeout(ABORT_TIMEOUT, self.session.abort())
                    .await
                    .is_ok();
                let _ = reply.send(());
                if !settled || self.session.is_streaming().await {
                    let store = Arc::clone(&self.store);
                    let app = self.app.clone();
                    let sid = self.session_id.clone();
                    tokio::spawn(async move {
                        recycle_actor(store, app, sid, "abort did not settle").await;
                    });
                }
            }
            SessionCommand::SetModel {
                provider,
                model_id,
                reply,
            } => {
                let result = async {
                    let model = self
                        .session
                        .get_model_registry()
                        .find(&provider, &model_id)
                        .ok_or_else(|| format!("model '{provider}/{model_id}' not found"))?;
                    // `persist=false`: the global default is written by the
                    // store (`model::set_default_model`) after this succeeds.
                    self.session.set_model(model, false).await?;
                    Ok(())
                }
                .await;
                let _ = reply.send(result);
            }
            SessionCommand::Compact {
                custom_instructions,
                reply,
            } => {
                let result = self
                    .session
                    .compact(custom_instructions.as_deref())
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string());
                self.emit_transcript().await;
                let _ = reply.send(result);
            }
            SessionCommand::Import { path, reply } => {
                let result = self
                    .session
                    .session_mgr_switch(&path, None)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string());
                let result = self.finish_swap(result).await;
                let _ = reply.send(result);
            }
            SessionCommand::Reload { reply } => {
                self.session.reload().await;
                let _ = reply.send(Ok(()));
            }
            SessionCommand::SetName { name, reply } => {
                self.session.set_session_name(&name);
                let _ = reply.send(());
            }
            SessionCommand::GetMessages { reply } => {
                let msgs = self.session.get_messages().await;
                let _ = reply.send(msgs);
            }
            SessionCommand::GetModel { reply } => {
                let m = self.session.get_model().await;
                let supported = pi_agent_core::pi_ai_types::get_supported_thinking_levels(&m);
                let thinking_level = self.session.get_thinking_level().await;
                let _ = reply.send(json!({
                    "provider": m.provider,
                    "modelId": m.id,
                    "thinkingLevel": thinking_level,
                    "supportedThinkingLevels": supported,
                }));
            }
            SessionCommand::SetThinkingLevel { level, reply } => {
                // `persist = false`: the per-session level is written to the
                // session file; the global default is a separate setting.
                self.session.set_thinking_level(&level, false).await;
                let m = self.session.get_model().await;
                let supported = pi_agent_core::pi_ai_types::get_supported_thinking_levels(&m);
                let thinking_level = self.session.get_thinking_level().await;
                let _ = reply.send(json!({
                    "provider": m.provider,
                    "modelId": m.id,
                    "thinkingLevel": thinking_level,
                    "supportedThinkingLevels": supported,
                }));
            }
            SessionCommand::GetUsage { reply } => {
                let usage = self.session.get_context_usage().await;
                let _ = reply.send(usage.map(|usage| {
                    json!({
                        "totalTokens": usage.total_tokens,
                        "contextWindow": usage.context_window,
                        "inputTokens": usage.input_tokens,
                        "outputTokens": usage.output_tokens,
                        "cacheReadTokens": usage.cache_read_tokens,
                        "cacheWriteTokens": usage.cache_write_tokens,
                        "messagesCount": usage.messages_count,
                        "percentage": usage.usage_percentage(),
                        "remainingTokens": usage.remaining_tokens(),
                        "formatted": usage.format_usage(),
                    })
                }));
            }
            SessionCommand::CycleModel { direction, reply } => {
                let result = self.session.cycle_model(&direction).await;
                let _ = reply.send(result.map(|(model, thinking_level, scoped)| {
                    json!({
                        "provider": model.provider,
                        "modelId": model.id,
                        "thinkingLevel": thinking_level,
                        "scoped": scoped,
                    })
                }));
            }
            SessionCommand::GetCommands { reply } => {
                let mut items = Vec::new();
                for c in pi_coding_agent::core::slash_commands::builtin_slash_commands() {
                    items.push(json!({
                        "name": c.name,
                        "description": c.description,
                        "argumentHint": c.argument_hint,
                        "source": "builtin",
                    }));
                }
                for c in self.session.get_commands_info() {
                    let source = match c.source {
                        pi_coding_agent::core::slash_commands::SlashCommandSource::Extension => {
                            "extension"
                        }
                        pi_coding_agent::core::slash_commands::SlashCommandSource::Prompt => {
                            "prompt"
                        }
                        pi_coding_agent::core::slash_commands::SlashCommandSource::Skill => "skill",
                    };
                    items.push(json!({
                        "name": c.name,
                        "description": c.description,
                        "source": source,
                    }));
                }
                let _ = reply.send(items);
            }
            SessionCommand::GetMcpSnapshot { reply } => {
                let items = self
                    .session
                    .mcp_connections()
                    .into_iter()
                    .map(|connection| {
                        json!({
                            "name": connection.name(),
                            "state": connection.state().as_str(),
                            "error": connection.error(),
                            "tools": connection.tools(),
                            "hasResources": connection.has_resources(),
                            "instructions": connection.instructions(),
                        })
                    })
                    .collect();
                let _ = reply.send(items);
            }
            SessionCommand::ReconnectMcp { name, reply } => {
                let connection = self
                    .session
                    .mcp_connections()
                    .into_iter()
                    .find(|connection| connection.name() == name);
                let result = match connection {
                    Some(connection) => connection.reconnect().await,
                    None => Err(format!(
                        "MCP server '{name}' is not connected in this session"
                    )),
                };
                let _ = reply.send(result);
            }
            SessionCommand::GetMcpResources { name, reply } => {
                let result = async {
                    let connection = self
                        .session
                        .mcp_connections()
                        .into_iter()
                        .find(|connection| connection.name() == name)
                        .ok_or_else(|| {
                            format!("MCP server '{name}' is not connected in this session")
                        })?;
                    let resources = connection.list_resources().await?;
                    let templates = connection.list_resource_templates().await?;
                    Ok(json!({
                        "resources": serde_json::to_value(resources).unwrap_or_else(|_| json!([])),
                        "templates": serde_json::to_value(templates).unwrap_or_else(|_| json!([])),
                    }))
                }
                .await;
                let _ = reply.send(result);
            }
            SessionCommand::ReadMcpResource { name, uri, reply } => {
                let result = async {
                    let connection = self
                        .session
                        .mcp_connections()
                        .into_iter()
                        .find(|connection| connection.name() == name)
                        .ok_or_else(|| {
                            format!("MCP server '{name}' is not connected in this session")
                        })?;
                    let contents = connection.read_resource(&uri).await?;
                    Ok(serde_json::to_value(contents).unwrap_or_else(|_| json!({})))
                }
                .await;
                let _ = reply.send(result);
            }
            SessionCommand::GetPromptTemplates { reply } => {
                let items = self
                    .session
                    .prompt_templates()
                    .into_iter()
                    .map(|template| {
                        json!({
                            "name": template.name,
                            "description": template.description,
                            "argumentHint": template.argument_hint,
                            "filePath": template.file_path,
                            "source": template.source,
                            "append": template.append,
                        })
                    })
                    .collect();
                let _ = reply.send(items);
            }
            SessionCommand::Shutdown => {
                let _ = tokio::time::timeout(ABORT_TIMEOUT, self.session.abort()).await;
                // Break out of the loop by ending the run.
                // We cannot return from handle(), so mark by dropping cmd_rx.
                self.cmd_rx.close();
            }
        }
    }

    /// Run an LLM turn as a separate task sharing `Arc<AgentSession>`.
    /// Streaming events flow through the session's event subscription; on
    /// completion the final transcript is emitted. There is no timeout: the
    /// turn ends when pi-rs emits its terminal events.
    ///
    /// A failed run leaves pi-rs's `is_agent_run_active` set (only the settle
    /// path clears it), which makes every later prompt queue behind a dead run
    /// — so the actor is recycled when a failure leaves the session streaming.
    async fn start_turn(
        &mut self,
        text: String,
        images: Vec<ContentBlock>,
        streaming_behavior: Option<String>,
    ) {
        let session = Arc::clone(&self.session);
        let app = self.app.clone();
        let store = Arc::clone(&self.store);
        let sid = self.session_id.clone();

        let turn = tokio::spawn(async move {
            // `add_user_text` is no longer public (v1.87); `prompt` is the
            // equivalent entry point. Prompt templates and skill commands
            // (`/skill:name`) are expanded by pi-rs; builtin commands never
            // reach here (the frontend routes them locally).
            session
                .prompt(
                    &text,
                    Some(PromptOptions {
                        expand_prompt_templates: Some(true),
                        images: (!images.is_empty()).then_some(images),
                        streaming_behavior,
                        ..Default::default()
                    }),
                )
                .await
                .map_err(|error| error.to_string())
                .err()
        });

        let session_after = Arc::clone(&self.session);
        tokio::spawn(async move {
            let failure = match turn.await {
                Ok(failure) => failure,
                Err(join) if join.is_panic() => {
                    let payload = join.into_panic();
                    Some(format!(
                        "Turn task panicked: {}",
                        panic_message(payload.as_ref())
                    ))
                }
                Err(_) => Some("Turn task was cancelled before it finished.".to_string()),
            };

            if let Some(message) = failure.as_deref() {
                write_line("LLM", &format!("sid={sid} run failed: {message}"));
                let _ = app.emit(
                    super::events::AGENT_EVENT,
                    FrontendEvent {
                        event_type: "run_error".into(),
                        session_id: sid.clone(),
                        data: json!({ "message": message }),
                    },
                );
                // A failed run never emits `agent_end`; without this the
                // sidebar keeps the session marked as running.
                store
                    .mutate(&app, |state| set_sess_status(state, &sid, "idle"))
                    .await;

                let abort_settled = tokio::time::timeout(ABORT_TIMEOUT, session_after.abort())
                    .await
                    .is_ok();
                if !abort_settled || session_after.is_streaming().await {
                    recycle_actor(
                        Arc::clone(&store),
                        app.clone(),
                        sid.clone(),
                        "run left the session streaming",
                    )
                    .await;
                }
            }

            // Emit the transcript so the frontend reflects the final state
            // (also after aborts, whose transcript may be partial). Guard the
            // lock: a wedged run can still be holding the agent state, and the
            // supervisor must not hang behind it.
            let msgs =
                match tokio::time::timeout(TRANSCRIPT_LOCK_TIMEOUT, session_after.get_messages())
                    .await
                {
                    Ok(msgs) => msgs,
                    Err(_) => {
                        write_line(
                            "LLM",
                            &format!("sid={sid} transcript skipped: agent state lock still held"),
                        );
                        return;
                    }
                };
            let transcript = match failure {
                Some(_) => build_display_transcript_interrupted(&msgs, INTERRUPTED_TOOL_MESSAGE),
                // A user stop keeps the partial answer as normal content and
                // only closes the tool call that never returned.
                None if transcript_was_aborted(&msgs) => {
                    build_display_transcript_interrupted(&msgs, STOPPED_TOOL_MESSAGE)
                }
                None => build_display_transcript(&msgs),
            };
            if !transcript.is_empty() {
                let _ = app.emit(
                    super::events::TRANSCRIPT_CHANGED,
                    &json!({
                        "sessionId": sid,
                        "transcript": transcript,
                        // The frontend re-attaches the error bubble from here:
                        // a plain transcript replace would erase it.
                        "runError": failure,
                    }),
                );
            }
        });
    }

    /// Emit the current transcript (used after compact).
    async fn emit_transcript(&self) {
        let msgs = self.session.get_messages().await;
        let transcript = build_display_transcript(&msgs);
        if !transcript.is_empty() {
            let _ = self.app.emit(
                super::events::TRANSCRIPT_CHANGED,
                &json!({ "sessionId": self.session_id, "transcript": transcript }),
            );
        }
    }

    /// After an import the session's id changes. Update this actor's id,
    /// the shared sid holder (event subscription), and return the new id; the
    /// store re-registers the handle under it (the mailbox sender is unchanged).
    async fn finish_swap(&mut self, result: Result<(), String>) -> Result<String, String> {
        result?;
        let new_id = self.session.get_session_id();
        self.session_id = new_id.clone();
        *self
            .sid_holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = new_id.clone();
        Ok(new_id)
    }
}

/// Best-effort text for a panic payload (`&str`, `String`, or nothing useful).
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "non-string panic payload".to_string())
}

/// Drop a wedged actor and rebuild it from the session file.
///
/// pi-rs clears `is_agent_run_active` only when a run settles. If the run
/// future is dropped mid-flight (abort / panic) the flag stays set,
/// every later `prompt()` is queued as a steer and never consumed, and
/// `abort()` waits for idle forever. Recreating the session is the only way to
/// restore a usable agent state.
async fn recycle_actor(store: Arc<Store>, app: AppHandle, sid: String, reason: &str) {
    write_line("LLM", &format!("sid={sid} recycling actor: {reason}"));
    store.shutdown_actor(&sid).await;
    if let Err(error) = store.ensure_actor(&app, &sid).await {
        write_line("LLM", &format!("sid={sid} actor recycle failed: {error}"));
    }
}
