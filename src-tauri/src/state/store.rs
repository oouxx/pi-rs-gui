//! The Store struct — central state manager for the Tauri backend.
//!
//! Concurrency model (ACP-style): each session owns a dedicated
//! `SessionActor` task (see `actor.rs`). The Store holds a registry of
//! session handles and forwards commands through mpsc mailboxes with oneshot
//! replies. Multiple sessions run in parallel; switching the selected session
//! does NOT destroy the old actor, so background sessions keep streaming.

use std::collections::HashMap;
use std::sync::Arc;

use pi_agent_core::types::AgentMessage;
use pi_coding_agent::core::agent_session::AgentSessionEvent;
use pi_coding_agent::core::agent_session_runtime::{
    create_agent_session_runtime, CreateAgentSessionRuntimeFactory,
    CreateAgentSessionRuntimeParams, CreateAgentSessionRuntimeResult,
};
use pi_coding_agent::core::agent_session_services::{
    create_agent_session_from_services, create_agent_session_services,
    CreateAgentSessionFromServicesOptions, CreateAgentSessionServicesOptions,
};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

use super::actor::{SessionActor, SessionCommand, SessionHandle};
use super::cwd::{decide_cwd_action, resolve_session_cwd, CwdAction};
use super::session;
use super::transcript::{build_display_transcript, serialize_session_event};
use super::types::{DesktopState, FrontendEvent, GlobalModelSettings, SessionRecord};
use super::ui;

// ── Default state ──────────────────────────────────────────

pub fn default_state() -> DesktopState {
    DesktopState {
        revision: 1,
        sessions: vec![],
        selected_session_id: String::new(),
        global_model_settings: GlobalModelSettings {
            enabled_model_patterns: vec![],
            default_provider: None,
            default_model_id: None,
            default_thinking_level: None,
        },
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn set_sess_status(s: &mut DesktopState, sid: &str, status: &str) {
    if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sid) {
        sess.status = status.to_string();
    }
}

// ── Store ───────────────────────────────────────────────────

pub struct Store {
    pub state: Mutex<DesktopState>,
    /// Session actors, keyed by the session's real id. One per session;
    /// switching selection does not destroy them.
    pub sessions: Mutex<HashMap<String, SessionHandle>>,
    /// Embedded terminal sessions (one per dock tab, Chrome-tab style).
    pub terminals: tokio::sync::Mutex<Vec<crate::state::terminal::TerminalSession>>,
}

impl Store {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(default_state()),
            sessions: Mutex::new(HashMap::new()),
            terminals: tokio::sync::Mutex::new(vec![]),
        })
    }

    pub fn new_with_runtime() -> Arc<Self> {
        let restored = ui::restore_state();
        let store = Self::new();
        {
            let mut state = store.state.blocking_lock();
            let mut s = default_state();
            if !restored.selected_session_id.is_empty() {
                s.selected_session_id = restored.selected_session_id.clone();
            }
            s.sessions = super::session::scan_existing_sessions();
            super::model::hydrate_global_settings(&mut s);
            s.revision += 1;
            *state = s;
        }
        store
    }

    pub async fn mutate<F>(self: &Arc<Self>, app: &AppHandle, f: F) -> DesktopState
    where
        F: FnOnce(&mut DesktopState),
    {
        let mut state = self.state.lock().await;
        f(&mut state);
        state.revision += 1;
        let result = state.clone();
        let _ = app.emit("pi-gui:state-changed", &result);
        ui::persist_state(&result);
        drop(state);
        result
    }

    // ── Session actor lifecycle ─────────────────────────────

    /// Send a command to a session's actor and await its oneshot reply.
    pub async fn send_cmd<T>(
        &self,
        session_id: &str,
        make: impl FnOnce(oneshot::Sender<T>) -> SessionCommand,
    ) -> Result<T, String> {
        let tx = {
            let reg = self.sessions.lock().await;
            reg.get(session_id)
                .map(|h| h.tx.clone())
                .ok_or_else(|| "no session".to_string())?
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(make(reply_tx))
            .map_err(|_| "session closed".to_string())?;
        reply_rx.await.map_err(|_| "session closed".to_string())
    }

    /// Build the runtime factory closure that creates AgentSessions.
    ///
    /// The factory captures the Store and AppHandle, reads current state at
    /// creation time, and subscribes to session events before returning. The
    /// subscription reads the session id from a shared holder (updated by the
    /// actor on fork/import) so events keep the correct id after the session
    /// manager is swapped.
    fn build_runtime_factory(
        self: &Arc<Self>,
        app: &AppHandle,
    ) -> (
        CreateAgentSessionRuntimeFactory,
        Arc<std::sync::Mutex<String>>,
    ) {
        let store = self.clone();
        let a = app.clone();
        // Current session id, shared with the actor so fork/import swaps keep
        // the event subscription's sid in sync.
        let sid_holder = Arc::new(std::sync::Mutex::new(String::new()));
        let sid_holder_f = sid_holder.clone();
        let factory: CreateAgentSessionRuntimeFactory = Arc::new(
            move |params: CreateAgentSessionRuntimeParams| {
                let store = store.clone();
                let a = a.clone();
                let sid_holder = sid_holder_f.clone();
                Box::pin(async move {
                pi_ai::providers::register_builtins::register_built_in_api_providers();

                // Build the registry up front and pass it in so
                // create_agent_session_services wires the auth.json credential
                // resolver onto it (pi-rs v1.82.9+).
                let registry = pi_coding_agent::core::model_registry::ModelRegistry::new(
                    pi_coding_agent::core::model_registry::ModelRegistry::builtin_models_list(),
                );

                let services =
                    create_agent_session_services(CreateAgentSessionServicesOptions {
                        cwd: params.cwd.clone(),
                        agent_dir: Some(params.agent_dir.clone()),
                        auth_storage: None,
                        settings_manager: None,
                        model_registry: Some(registry),
                        resource_loader_options: None,
                    })
                    .await;

                let (provider, model_id, thinking_level) = {
                    let settings = services.settings_manager.get_settings();
                    (
                        settings.default_provider.clone(),
                        settings.default_model.clone(),
                        settings.default_thinking_level.clone(),
                    )
                };

                let registry = &services.model_registry;
                let initial_model = provider
                    .as_ref()
                    .and_then(|p| model_id.as_ref().and_then(|m| registry.find(p, m)));

                let extension_registry = crate::state::extensions::build_default_registry();

                let model = initial_model.unwrap_or_else(|| {
                    let available = registry.get_available();
                    available.into_iter().next().unwrap_or_else(|| {
                        // No provider has auth configured (fresh install, no env
                        // keys, no models.json). Fall back to the first model in
                        // the registry so session creation succeeds; the agent
                        // surfaces a graceful "No API key configured" error on
                        // the first message instead of panicking here.
                        registry
                            .get_models()
                            .into_iter()
                            .next()
                            .expect("registry always has builtin models")
                    })
                });

                // Capture cwd/agent_dir before `services` is moved into
                // `create_agent_session_from_services`, which consumes it
                // without returning it. The runtime result still needs a
                // `services` value (used for `cwd()`/`agent_dir()`), so we
                // rebuild a fresh one for the result.
                let result_cwd = services.cwd.clone();
                let result_agent_dir = services.agent_dir.clone();

                let (session, _services, result) =
                    create_agent_session_from_services(CreateAgentSessionFromServicesOptions {
                        services,
                        session_manager: params.session_manager,
                        model: Some(model),
                        thinking_level: thinking_level,
                        scoped_models: None,
                        tools: None,
                        no_tools: None,
                        exclude_tools: None,
                        custom_tools: None,
                        extension_registry: Some(extension_registry),
                        fallback_message: None,
                        session_start_event: params.session_start_event,
                        ui_context: None,
                    })
                    .await
                    .expect("Failed to create agent session");

                let result_services =
                    create_agent_session_services(CreateAgentSessionServicesOptions {
                        cwd: result_cwd,
                        agent_dir: Some(result_agent_dir),
                        auth_storage: None,
                        settings_manager: None,
                        model_registry: None,
                        resource_loader_options: None,
                    })
                    .await;

                // Subscribe to events. The session id comes from the shared
                // holder so fork/import swaps keep it in sync.
                let store2 = store.clone();
                let a2 = a.clone();
                session.subscribe(Arc::new(move |event: AgentSessionEvent| {
                    let sid = sid_holder
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner)
                        .clone();
                    let (et, data) = serialize_session_event(&event);
                    if et == "agent_start" || et == "turn_start" {
                        let store = store2.clone();
                        let app = a2.clone();
                        let sid = sid.clone();
                        tokio::spawn(async move {
                            store
                                .mutate(&app, |s| {
                                    set_sess_status(s, &sid, "running");
                                })
                                .await;
                        });
                    } else if et == "agent_end" || et == "turn_end" {
                        let store = store2.clone();
                        let app = a2.clone();
                        let sid = sid.clone();
                        tokio::spawn(async move {
                            store
                                .mutate(&app, |s| {
                                    set_sess_status(s, &sid, "idle");
                                })
                                .await;
                        });
                    }
                    if et == "tool_execution_start" {
                        eprintln!(
                            "[TOOL] start sid={} id={} name={}",
                            sid,
                            data.get("tool_call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(""),
                            data.get("tool_name").and_then(|v| v.as_str()).unwrap_or("?"),
                        );
                    } else if et == "tool_execution_end" {
                        let is_error = data
                            .get("is_error")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        let result_str = data
                            .get("result")
                            .and_then(|v| v.as_str().map(|s| s.to_string()))
                            .unwrap_or_else(|| {
                                data.get("result").map(|v| v.to_string()).unwrap_or_default()
                            });
                        let snippet: String = result_str.chars().take(160).collect();
                        eprintln!(
                            "[TOOL] end   sid={} id={} name={} is_error={} result={:?}",
                            sid,
                            data.get("tool_call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(""),
                            data.get("tool_name").and_then(|v| v.as_str()).unwrap_or("?"),
                            is_error,
                            snippet,
                        );
                    }
                    let _ = a2.emit(
                        "agent-event",
                        FrontendEvent {
                            event_type: et,
                            session_id: sid,
                            data,
                        },
                    );
                }));

                CreateAgentSessionRuntimeResult {
                    session,
                    services: result_services,
                    diagnostics: vec![],
                    model_fallback_message: result.model_fallback_message,
                }
            })
        },
    );
        (factory, sid_holder)
    }

    /// Compute the default session directory for a given cwd.
    fn session_dir_for(cwd: &str) -> String {
        let agent_dir = pi_coding_agent::config::get_agent_dir()
            .to_string_lossy()
            .to_string();
        pi_coding_agent::core::session_manager::SessionManager::default_session_dir(cwd, &agent_dir)
    }

    /// Create an AgentSessionRuntime via the factory and spawn its actor.
    /// Registers the actor under the runtime's real session id and updates the
    /// selected UI record (rename placeholder id + backfill session_file).
    /// Returns the real session id.
    async fn spawn_actor(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
        session_manager: pi_coding_agent::core::session_manager::SessionManager,
    ) -> Result<String, String> {
        let agent_dir = pi_coding_agent::config::get_agent_dir()
            .to_string_lossy()
            .to_string();
        let (factory, sid_holder) = self.build_runtime_factory(app);
        let runtime = create_agent_session_runtime(
            factory,
            CreateAgentSessionRuntimeParams {
                cwd: cwd.to_string(),
                agent_dir,
                session_manager,
                session_start_event: None,
            },
        )
        .await;
        let sid = runtime.session().get_session_id();
        let session_file = runtime
            .session()
            .get_session_file()
            .map(|p| p.to_string_lossy().to_string());
        *sid_holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = sid.clone();

        let handle = SessionActor::spawn(runtime, self.clone(), app.clone(), sid_holder);
        self.sessions.lock().await.insert(sid.clone(), handle);

        // Universal invariant: the UI-facing record id must equal the runtime's
        // real session id, otherwise agent-event payloads (keyed by the runtime
        // id) get filtered out by the frontend. Also backfill the session file
        // so the record can be resumed later.
        self.mutate(app, |s| {
            if let Some(rec) = s.sessions.iter_mut().find(|r| r.id == s.selected_session_id) {
                rec.id = sid.clone();
                if let Some(file) = session_file.clone() {
                    rec.session_file = Some(file);
                }
            }
            s.selected_session_id = sid.clone();
        })
        .await;
        Ok(sid)
    }

    /// Ensure an actor exists for `session_id` (spawn one from the record's
    /// file if missing). Used on selection so switching is instant and
    /// background sessions stay alive.
    pub async fn ensure_actor(
        self: &Arc<Self>,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<(), String> {
        if self.sessions.lock().await.contains_key(session_id) {
            return Ok(());
        }
        let (cwd, session_file) = {
            let state = self.state.lock().await;
            match state.sessions.iter().find(|s| s.id == session_id) {
                Some(s) => (
                    resolve_session_cwd(s.cwd.as_deref()),
                    s.session_file.clone().filter(|f| !f.is_empty()),
                ),
                None => return Ok(()),
            }
        };
        let session_dir = Self::session_dir_for(&cwd);
        let session_manager = pi_coding_agent::core::session_manager::SessionManager::new(
            &cwd,
            &session_dir,
            session_file.as_deref(),
            true,
            None,
        );
        self.spawn_actor(app, &cwd, session_manager).await?;
        Ok(())
    }

    /// Ensure the currently selected session has an actor.
    pub async fn ensure_selected_actor(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Ok(());
        }
        self.ensure_actor(app, &sid).await
    }

    /// Abort and destroy a session's actor (archive/delete).
    pub async fn shutdown_actor(self: &Arc<Self>, session_id: &str) {
        if let Some(handle) = self.sessions.lock().await.remove(session_id) {
            let _ = handle.tx.send(SessionCommand::Shutdown);
        }
    }

    /// List slash commands the composer menu offers: the pi-rs builtins plus
    /// extension/prompt/skill commands from the active session.
    pub async fn list_slash_commands(&self) -> Vec<serde_json::Value> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Vec::new();
        }
        self.send_cmd(&sid, |reply| SessionCommand::GetCommands { reply })
            .await
            .unwrap_or_default()
    }

    /// Get the session tree (timeline) for a session. Uses the in-memory
    /// runtime when the session has a live actor, otherwise opens the file.
    pub async fn get_session_tree_json(
        &self,
        session_id: &str,
    ) -> Result<Vec<serde_json::Value>, String> {
        if self.sessions.lock().await.contains_key(session_id) {
            return self
                .send_cmd(session_id, |reply| SessionCommand::GetTree { reply })
                .await;
        }
        let session_file = {
            let state = self.state.lock().await;
            state
                .sessions
                .iter()
                .find(|s| s.id == session_id)
                .and_then(|s| s.session_file.as_ref())
                .filter(|f| !f.is_empty())
                .cloned()
                .ok_or_else(|| format!("session '{session_id}' has no session file"))?
        };
        Ok(crate::state::tree::tree_from_session_file(&session_file))
    }

    /// Navigate the session's tree to a node and return the updated tree.
    pub async fn navigate_session_tree(
        self: &Arc<Self>,
        app: &AppHandle,
        session_id: &str,
        entry_id: &str,
    ) -> Result<Vec<serde_json::Value>, String> {
        self.send_cmd(session_id, |reply| SessionCommand::Navigate {
            entry_id: entry_id.to_string(),
            reply,
        })
        .await??;
        // Emit the updated transcript so the chat pane switches to the branch.
        let transcript = build_display_transcript(&self.get_messages().await);
        let _ = app.emit(
            "pi-gui:selected-transcript-changed",
            &json!({ "sessionId": session_id, "transcript": transcript }),
        );
        self.get_session_tree_json(session_id).await
    }

    /// Set the selected session's model (and persist it as the global default).
    pub async fn set_session_model(
        self: &Arc<Self>,
        app: &AppHandle,
        provider: &str,
        model_id: &str,
    ) -> Result<DesktopState, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        self.send_cmd(&sid, |reply| SessionCommand::SetModel {
            provider: provider.to_string(),
            model_id: model_id.to_string(),
            reply,
        })
        .await??;
        Ok(self
            .mutate(app, |s| {
                super::model::set_default_model(s, provider, model_id);
            })
            .await)
    }

    /// The selected session's current model (falls back to the global default).
    pub async fn get_session_model(&self) -> serde_json::Value {
        let sid = self.state.lock().await.selected_session_id.clone();
        if !sid.is_empty() {
            if let Ok(v) = self
                .send_cmd(&sid, |reply| SessionCommand::GetModel { reply })
                .await
            {
                return v;
            }
        }
        let state = self.state.lock().await;
        json!({
            "provider": state.global_model_settings.default_provider,
            "modelId": state.global_model_settings.default_model_id,
        })
    }

    /// Session info for the frontend header popover.
    pub async fn get_session_info(&self, session_id: &str) -> serde_json::Value {
        let (title, cwd, session_file) = {
            let state = self.state.lock().await;
            match state.sessions.iter().find(|s| s.id == session_id) {
                Some(s) => (s.title.clone(), s.cwd.clone(), s.session_file.clone()),
                None => {
                    return serde_json::json!({ "id": session_id, "found": false });
                }
            }
        };

        let mut message_count: usize = 0;
        let mut created_at: Option<String> = None;
        if let Some(file) = session_file.as_ref().filter(|f| !f.is_empty()) {
            let mgr = pi_coding_agent::core::session_manager::SessionManager::open(
                file, None, None,
            );
            if let Some(header) = mgr.get_header() {
                created_at = Some(header.timestamp.clone());
            }
            message_count = mgr
                .get_entries()
                .iter()
                .filter(|e| {
                    matches!(
                        e,
                        pi_coding_agent::core::session_manager::SessionEntry::Message { .. }
                    )
                })
                .count();
        }

        let model = self.get_session_model().await;
        serde_json::json!({
            "id": session_id,
            "found": true,
            "title": title,
            "cwd": cwd,
            "sessionFile": session_file,
            "messageCount": message_count,
            "createdAt": created_at,
            "model": model,
        })
    }

    /// Manually compact the selected session (matches TS `/compact`).
    pub async fn compact_session(
        self: &Arc<Self>,
        _app: &AppHandle,
        custom_instructions: Option<&str>,
    ) -> Result<DesktopState, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        self.send_cmd(&sid, |reply| SessionCommand::Compact {
            custom_instructions: custom_instructions.map(|s| s.to_string()),
            reply,
        })
        .await??;
        Ok(self.state.lock().await.clone())
    }

    /// Refresh the Store after a fork/import swapped the session: re-register
    /// the actor handle under the new id, rescan the session list, select the
    /// new session, and emit the updated transcript.
    async fn refresh_after_session_swap(
        self: &Arc<Self>,
        app: &AppHandle,
        old_id: &str,
        new_id: &str,
    ) -> DesktopState {
        // Re-register the actor under the new id (same mailbox).
        if new_id != old_id {
            let mut reg = self.sessions.lock().await;
            if let Some(handle) = reg.remove(old_id) {
                reg.insert(new_id.to_string(), handle);
            }
        }
        if !new_id.is_empty() {
            let state = self
                .mutate(app, |s| {
                    s.sessions = super::session::scan_existing_sessions();
                    s.selected_session_id = new_id.to_string();
                    super::session::select_session_by_id(s, new_id);
                })
                .await;
            let transcript = build_display_transcript(&self.get_messages().await);
            if !transcript.is_empty() {
                let _ = app.emit(
                    "pi-gui:selected-transcript-changed",
                    &json!({ "sessionId": new_id, "transcript": transcript }),
                );
            }
            state
        } else {
            self.mutate(app, |s| {
                s.sessions = super::session::scan_existing_sessions();
            })
            .await
        }
    }

    /// Fork the selected session at a timeline node (matches TS `fork`).
    pub async fn fork_session_at(
        self: &Arc<Self>,
        app: &AppHandle,
        entry_id: &str,
    ) -> Result<DesktopState, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        let new_id = self
            .send_cmd(&sid, |reply| SessionCommand::ForkAt {
                entry_id: entry_id.to_string(),
                reply,
            })
            .await??;
        Ok(self.refresh_after_session_swap(app, &sid, &new_id).await)
    }

    /// Import a session from a JSONL file (matches TS `/import`).
    pub async fn import_session(
        self: &Arc<Self>,
        app: &AppHandle,
        input_path: &str,
    ) -> Result<DesktopState, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        let new_id = self
            .send_cmd(&sid, |reply| SessionCommand::Import {
                path: input_path.to_string(),
                reply,
            })
            .await??;
        Ok(self.refresh_after_session_swap(app, &sid, &new_id).await)
    }

    /// Reload settings (matches TS `/reload`).
    pub async fn reload_session(&self) -> Result<(), String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        self.send_cmd(&sid, |reply| SessionCommand::Reload { reply })
            .await?
    }

    /// Create a new session and immediately spawn its actor, then adopt the
    /// runtime's real session id into the UI record.
    pub async fn create_session_with_runtime(
        self: &Arc<Self>,
        app: &AppHandle,
        title: Option<&str>,
    ) -> Result<DesktopState, String> {
        let state = self
            .mutate(app, |s| {
                session::create_session_simple(s, title.unwrap_or("New thread"))
            })
            .await;
        let placeholder_id = state.selected_session_id.clone();
        if placeholder_id.is_empty() {
            return Ok(state);
        }

        let cwd = {
            let st = self.state.lock().await;
            let rec = st.sessions.iter().find(|r| r.id == placeholder_id);
            match rec {
                Some(r) => resolve_session_cwd(r.cwd.as_deref()),
                None => return Ok(self.state.lock().await.clone()),
            }
        };
        let session_dir = Self::session_dir_for(&cwd);
        let sm = pi_coding_agent::core::session_manager::SessionManager::new(
            &cwd,
            &session_dir,
            None,
            true,
            None,
        );
        self.spawn_actor(app, &cwd, sm).await?;
        // spawn_actor adopts the runtime's real id into the record, so `state`
        // above may carry a stale placeholder id — return fresh state.
        Ok(self.state.lock().await.clone())
    }

    /// Select a session: update the selected id and ensure its actor exists.
    /// The previously selected session's actor is NOT destroyed — background
    /// streaming continues (multi-session).
    pub async fn select_session(
        self: &Arc<Self>,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<DesktopState, String> {
        let _state = self
            .mutate(app, |s| {
                session::select_session_by_id(s, session_id);
            })
            .await;
        self.ensure_actor(app, session_id).await?;
        Ok(self.state.lock().await.clone())
    }

    pub async fn send_message(self: &Arc<Self>, app: &AppHandle, text: &str) -> Result<(), String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Err("No session".to_string());
        }
        // Lazy-init an actor for the selected session if needed.
        self.ensure_actor(app, &sid).await?;

        let _ = app.emit(
            "agent-event",
            FrontendEvent {
                event_type: "user_message".into(),
                session_id: sid.clone(),
                data: json!({"text": text, "timestamp": chrono::Utc::now().timestamp_millis()}),
            },
        );

        self.send_cmd(&sid, |reply| SessionCommand::SendMessage {
            text: text.to_string(),
            reply,
        })
        .await??;
        Ok(())
    }

    /// Abort the selected session's in-flight run.
    pub async fn abort(&self) {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return;
        }
        let _ = self
            .send_cmd(&sid, |reply| SessionCommand::Abort { reply })
            .await;
    }

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
            return Err(format!(
                "Working directory does not exist or is not a directory: {}",
                path
            ));
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
                sess.session_file.clone().filter(|f| !f.is_empty()),
                sess.cwd.clone(),
                sess.title.clone(),
            )
        };

        let action = decide_cwd_action(current_file.as_deref(), &new_cwd, current_cwd.as_deref());
        // spawn_actor backfills session_file on every record, including fresh
        // sessions whose file path is computed but NOT yet created (no messages
        // sent). Forking from a non-existent file fails — downgrade to
        // SetInPlace (re-init the runtime with the new cwd) in that case.
        let action = match action {
            CwdAction::Fork
                if current_file
                    .as_deref()
                    .map(|f| !std::path::Path::new(f).exists())
                    .unwrap_or(true) =>
            {
                CwdAction::SetInPlace
            }
            other => other,
        };
        eprintln!(
            "[CWD] set_session_cwd sid={} new_cwd={:?} current_cwd={:?} session_file={:?} action={:?}",
            session_id, new_cwd, current_cwd, current_file, action
        );

        match action {
            CwdAction::NoOp => Ok(self.state.lock().await.clone()),
            CwdAction::SetInPlace => {
                // No history: destroy the old actor (its cwd is fixed at
                // creation) and re-init a fresh one with the new cwd.
                self.shutdown_actor(session_id).await;
                let sid = session_id.to_string();
                let cwd = new_cwd.clone();
                self.mutate(app, |s| {
                    if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sid) {
                        sess.cwd = Some(cwd.clone());
                    }
                })
                .await;
                self.ensure_selected_actor(app).await?;
                Ok(self.state.lock().await.clone())
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
                // pi-rs copies the history into a new session file under the
                // new cwd; spawn a fresh actor for it. The original session's
                // actor stays alive (multi-session).
                let old_file = current_file.clone().unwrap_or_default();
                let result = if old_file.is_empty() {
                    self.ensure_selected_actor(app).await.map(|_| ())
                } else {
                    let session_dir = Self::session_dir_for(&new_cwd);
                    let session_manager =
                        pi_coding_agent::core::session_manager::SessionManager::fork_from(
                            &old_file,
                            &new_cwd,
                            Some(&session_dir),
                            None,
                        )
                        .map_err(|e| format!("Failed to fork session: {e}"))?;
                    self.spawn_actor(app, &new_cwd, session_manager).await.map(|_| ())
                };
                match result {
                    Ok(()) => {
                        // spawn_actor renames the placeholder record to the
                        // runtime's real id — verify THAT record has a
                        // session_file (pi-rs backfills it on fork).
                        let real_id = self.state.lock().await.selected_session_id.clone();
                        let state = self.state.lock().await;
                        let file_set = state
                            .sessions
                            .iter()
                            .any(|s| s.id == real_id && s.session_file.is_some());
                        if !file_set {
                            drop(state);
                            let old_sid = session_id.to_string();
                            self.mutate(app, |s| {
                                s.sessions.retain(|s| s.id != real_id);
                                s.selected_session_id = old_sid.clone();
                            })
                            .await;
                            return Err("Failed to persist session file for forked session".into());
                        }
                        Ok(state.clone())
                    }
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

    pub async fn get_messages(&self) -> Vec<AgentMessage> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return vec![];
        }
        self.send_cmd(&sid, |reply| SessionCommand::GetMessages { reply })
            .await
            .unwrap_or_default()
    }
}
