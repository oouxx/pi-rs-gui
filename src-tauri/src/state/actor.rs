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

use super::transcript::build_display_transcript;
use super::types::FrontendEvent;
use super::Store;

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
    Navigate {
        entry_id: String,
        reply: oneshot::Sender<Result<(), String>>,
    },
    GetTree {
        reply: oneshot::Sender<Vec<serde_json::Value>>,
    },
    /// Fork the session at a timeline node. On success the session's id
    /// changes; the actor re-registers in the store under the new id and the
    /// reply carries it.
    ForkAt {
        entry_id: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    /// Duplicate the session at the current position (`/clone`). Same as
    /// ForkAt but always targets the current leaf.
    Clone { reply: oneshot::Sender<Result<String, String>> },
    /// Switch the session to a different session file (matches TS `/import`).
    Import {
        path: String,
        reply: oneshot::Sender<Result<String, String>>,
    },
    Reload { reply: oneshot::Sender<Result<(), String>> },
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
    GetCommands {
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
    session_id: String,
    /// Shared with the event subscription so fork/import swaps keep the
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
        _store: Arc<Store>,
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
            SessionCommand::SendMessage { text, images, reply } => {
                let _ = reply.send(Ok(()));
                self.start_turn(text, images).await;
            }
            SessionCommand::Abort { reply } => {
                self.session.abort().await;
                let _ = reply.send(());
            }
            SessionCommand::SetModel {
                provider,
                model_id,
                reply,
            } => {
                let result = (|| async {
                    let model = self
                        .session
                        .get_model_registry()
                        .find(&provider, &model_id)
                        .ok_or_else(|| format!("model '{provider}/{model_id}' not found"))?;
                    // `persist=false`: the global default is written by the
                    // store (`model::set_default_model`) after this succeeds.
                    self.session.set_model(model, false).await?;
                    Ok(())
                })()
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
            SessionCommand::Navigate { entry_id, reply } => {
                let ok = self.session.navigate_tree(&entry_id).await;
                let _ = reply.send(if ok {
                    Ok(())
                } else {
                    Err(format!("entry '{entry_id}' not found"))
                });
            }
            SessionCommand::GetTree { reply } => {
                let tree = self.session.get_tree();
                let _ = reply.send(super::tree::tree_json(&tree, None));
            }
            SessionCommand::ForkAt { entry_id, reply } => {
                let result = self
                    .session
                    // `at`: the branch includes the selected entry (the GUI's
                    // timeline fork has always been inclusive).
                    .session_mgr_fork(&entry_id, Some("at"))
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string());
                let result = self.finish_swap(result).await;
                let _ = reply.send(result);
            }
            SessionCommand::Clone { reply } => {
                let result = (|| async {
                    let leaf = {
                        let mgr = self.session.get_session_manager();
                        mgr.get_leaf_id()
                            .ok_or_else(|| "Nothing to clone yet".to_string())?
                            .to_string()
                    };
                    self.session
                        // `at`: keep the current leaf in the clone.
                        .session_mgr_fork(&leaf, Some("at"))
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string())
                })()
                .await;
                let result = self.finish_swap(result).await;
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
                let _ = reply.send(json!({ "provider": m.provider, "modelId": m.id }));
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
                        pi_coding_agent::core::slash_commands::SlashCommandSource::Prompt => "prompt",
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
            SessionCommand::Shutdown => {
                self.session.abort().await;
                // Break out of the loop by ending the run.
                // We cannot return from handle(), so mark by dropping cmd_rx.
                self.cmd_rx.close();
            }
        }
    }

    /// Run an LLM turn as a separate task sharing `Arc<AgentSession>`.
    /// Streaming events flow through the session's event subscription; on
    /// completion the final transcript is emitted. Turn failures (timeout,
    /// agent-loop errors) are surfaced to the frontend via a `run_error`
    /// agent-event so the UI never silently stalls.
    async fn start_turn(&mut self, text: String, images: Vec<ContentBlock>) {
        let session = Arc::clone(&self.session);
        let app = self.app.clone();
        let sid = self.session_id.clone();
        tokio::spawn(async move {
            let result = tokio::time::timeout(
                std::time::Duration::from_secs(300),
                async {
                    // `add_user_text` is no longer public (v1.87); `prompt`
                    // with template expansion disabled is the equivalent
                    // entry point. Skip skill/template expansion for raw
                    // messages; `/commands` are still routed by the frontend.
                    session
                        .prompt(
                            &text,
                            Some(PromptOptions {
                                expand_prompt_templates: Some(false),
                                images: (!images.is_empty()).then_some(images),
                                ..Default::default()
                            }),
                        )
                        .await
                },
            )
            .await;
            match result {
                // Outer error = the 300s timeout elapsed.
                Err(_) => {
                    eprintln!("[LLM] turn timed out after 300s");
                    let _ = app.emit(
                        super::events::AGENT_EVENT,
                        FrontendEvent {
                            event_type: "run_error".into(),
                            session_id: sid.clone(),
                            data: json!({
                                "message": "Turn timed out after 300s. The run was abandoned.",
                                "timeout": true,
                            }),
                        },
                    );
                }
                // Inner error = `prompt()` rejected the turn (no model / no
                // API key / compaction in progress) or the agent loop failed.
                Ok(Err(ref e)) => {
                    eprintln!("[LLM] turn error: {e}");
                    let _ = app.emit(
                        super::events::AGENT_EVENT,
                        FrontendEvent {
                            event_type: "run_error".into(),
                            session_id: sid.clone(),
                            data: json!({"message": e.to_string()}),
                        },
                    );
                }
                Ok(Ok(())) => {}
            }
            // Emit the transcript so the frontend reflects the final state
            // (also after aborts, whose transcript may be partial).
            let msgs = session.get_messages().await;
            let transcript = build_display_transcript(&msgs);
            if !transcript.is_empty() {
                let _ = app.emit(
                    super::events::TRANSCRIPT_CHANGED,
                    &json!({ "sessionId": sid, "transcript": transcript }),
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

    /// After fork/import the session's id changes. Update this actor's id,
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
