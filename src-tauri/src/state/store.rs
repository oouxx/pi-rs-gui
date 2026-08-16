//! The Store struct — central state manager for the Tauri backend.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use pi_agent_core::types::AgentMessage;
use pi_coding_agent::core::agent_session::AgentSessionEvent;
use pi_coding_agent::core::agent_session_runtime::{
    create_agent_session_runtime, AgentSessionRuntime, CreateAgentSessionRuntimeFactory,
    CreateAgentSessionRuntimeParams, CreateAgentSessionRuntimeResult,
};
use pi_coding_agent::core::agent_session_services::{
    create_agent_session_from_services, create_agent_session_services,
    CreateAgentSessionFromServicesOptions, CreateAgentSessionServicesOptions,
};
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

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
    pub runtime: Mutex<Option<AgentSessionRuntime>>,
    pub session_id: Mutex<Option<String>>,
    pub is_streaming: AtomicBool,
    /// Abort signal that works even when the AgentSession is moved into a tokio task.
    pub abort_flag: Arc<AtomicBool>,
    /// Generation counter incremented on each session switch. The spawned
    /// send_message task checks this before putting the runtime back, so a
    /// stale task from a previous session doesn't overwrite the new runtime.
    pub generation: AtomicU64,
    /// Embedded terminal session (single, replaced on restart).
    pub terminal: tokio::sync::Mutex<Option<crate::state::terminal::TerminalSession>>,
}

impl Store {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(default_state()),
            runtime: Mutex::new(None),
            session_id: Mutex::new(None),
            is_streaming: AtomicBool::new(false),
            abort_flag: Arc::new(AtomicBool::new(false)),
            generation: AtomicU64::new(0),
            terminal: tokio::sync::Mutex::new(None),
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

    /// Build the runtime factory closure that creates AgentSessions.
    ///
    /// The factory captures the Store and AppHandle, reads current state at
    /// creation time, and subscribes to session events before returning.
    fn build_runtime_factory(
        self: &Arc<Self>,
        app: &AppHandle,
    ) -> CreateAgentSessionRuntimeFactory {
        let store = self.clone();
        let a = app.clone();
        Arc::new(move |params: CreateAgentSessionRuntimeParams| {
            let store = store.clone();
            let a = a.clone();
            Box::pin(async move {
                pi_ai::providers::register_builtins::register_built_in_api_providers();

                let mut services =
                    create_agent_session_services(CreateAgentSessionServicesOptions {
                        cwd: params.cwd.clone(),
                        agent_dir: Some(params.agent_dir.clone()),
                        auth_storage: None,
                        settings_manager: None,
                        model_registry: None,
                        resource_loader_options: None,
                    })
                    .await;

                // Populate model registry with built-in models so model resolution works.
                // create_agent_session_services creates an empty registry.
                services.model_registry = pi_coding_agent::core::model_registry::ModelRegistry::new(
                    pi_coding_agent::core::model_registry::ModelRegistry::builtin_models_list(),
                );

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
                    available.into_iter().next().expect("No models available")
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

                // Subscribe to events
                let sid = session.get_session_id();
                let store2 = store.clone();
                let a2 = a.clone();
                let sid2 = sid.clone();
                session.subscribe(Arc::new(move |event: AgentSessionEvent| {
                    let (et, data) = serialize_session_event(&event);
                    if et == "agent_start" || et == "turn_start" {
                        let store = store2.clone();
                        let app = a2.clone();
                        let sid = sid2.clone();
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
                        let sid = sid2.clone();
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
                            sid2,
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
                            sid2,
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
                            session_id: sid2.clone(),
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
        })
    }

    /// List slash commands the composer menu offers: the 22 pi-rs builtins
    /// plus extension/prompt/skill commands from the active session (mirrors
    /// the TS interactive-mode command palette).
    pub async fn list_slash_commands(&self) -> Vec<serde_json::Value> {
        let mut items: Vec<serde_json::Value> = Vec::new();

        for c in pi_coding_agent::core::slash_commands::builtin_slash_commands() {
            items.push(serde_json::json!({
                "name": c.name,
                "description": c.description,
                "argumentHint": c.argument_hint,
                "source": "builtin",
            }));
        }

        if let Some(runtime) = self.runtime.lock().await.as_ref() {
            for c in runtime.session().get_commands_info() {
                let source = match c.source {
                    pi_coding_agent::core::slash_commands::SlashCommandSource::Extension => "extension",
                    pi_coding_agent::core::slash_commands::SlashCommandSource::Prompt => "prompt",
                    pi_coding_agent::core::slash_commands::SlashCommandSource::Skill => "skill",
                };
                items.push(serde_json::json!({
                    "name": c.name,
                    "description": c.description,
                    "source": source,
                }));
            }
        }

        items
    }

    /// Get the session tree (timeline) for a session. Uses the in-memory
    /// runtime for the active session, otherwise opens the session file.
    pub async fn get_session_tree_json(
        &self,
        session_id: &str,
    ) -> Result<Vec<serde_json::Value>, String> {
        let active_sid = self.session_id.lock().await.clone().unwrap_or_default();
        if active_sid == session_id {
            let runtime = self.runtime.lock().await;
            if let Some(runtime) = runtime.as_ref() {
                let tree = runtime.session().get_tree();
                return Ok(crate::state::tree::tree_json(&tree, None));
            }
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

    /// Navigate the active session's tree to a node and return the updated
    /// tree. Non-active sessions cannot be navigated (no runtime).
    pub async fn navigate_session_tree(
        &self,
        session_id: &str,
        entry_id: &str,
    ) -> Result<Vec<serde_json::Value>, String> {
        let active_sid = self.session_id.lock().await.clone().unwrap_or_default();
        if active_sid != session_id {
            return Err("can only navigate the active session".to_string());
        }
        let mut runtime = self.runtime.lock().await;
        let runtime = runtime.as_mut().ok_or("No session")?;
        let ok = runtime.session_mut().navigate_tree(entry_id).await;
        if !ok {
            return Err(format!("entry '{entry_id}' not found"));
        }
        let tree = runtime.session().get_tree();
        Ok(crate::state::tree::tree_json(&tree, None))
    }

    /// Set the active session's model (and persist it as the global default,
    /// matching the Models settings page behavior). Delegates to pi-rs
    /// `AgentSession::set_model`, which also validates provider auth.
    pub async fn set_session_model(
        self: &Arc<Self>,
        app: &AppHandle,
        provider: &str,
        model_id: &str,
    ) -> Result<DesktopState, String> {
        // Take the runtime out of the mutex while awaiting so the command
        // future stays Send (mirrors send_message).
        let runtime = self.runtime.lock().await.take().ok_or("No session")?;
        let model = runtime
            .session()
            .get_model_registry()
            .find(provider, model_id)
            .ok_or_else(|| format!("model '{provider}/{model_id}' not found"))?;
        let result = runtime.session().set_model(model).await;
        *self.runtime.lock().await = Some(runtime);
        result?;

        Ok(self
            .mutate(app, |s| {
                super::model::set_default_model(s, provider, model_id);
            })
            .await)
    }

    /// The active session's current model (falls back to the global default).
    pub async fn get_session_model(&self) -> serde_json::Value {
        let runtime = self.runtime.lock().await;
        if let Some(runtime) = runtime.as_ref() {
            let m = runtime.session().get_model().await;
            return serde_json::json!({ "provider": m.provider, "modelId": m.id });
        }
        let state = self.state.lock().await;
        serde_json::json!({
            "provider": state.global_model_settings.default_provider,
            "modelId": state.global_model_settings.default_model_id,
        })
    }

    /// Compute the default session directory for a given cwd.
    fn session_dir_for(cwd: &str) -> String {
        let agent_dir = pi_coding_agent::config::get_agent_dir()
            .to_string_lossy()
            .to_string();
        pi_coding_agent::core::session_manager::SessionManager::default_session_dir(cwd, &agent_dir)
    }

    /// Single point that assembles an `AgentSessionRuntime` via the factory and
    /// installs it as the active runtime. All session/runtime swaps (init,
    /// select, fork) go through here.
    async fn spawn_runtime(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
        session_manager: pi_coding_agent::core::session_manager::SessionManager,
    ) -> Result<(), String> {
        let agent_dir = pi_coding_agent::config::get_agent_dir()
            .to_string_lossy()
            .to_string();
        let factory = self.build_runtime_factory(app);
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
        *self.session_id.lock().await = Some(sid.clone());
        *self.runtime.lock().await = Some(runtime);
        Ok(())
    }

    /// Create the initial AgentSessionRuntime for a given cwd.
    async fn init_runtime(self: &Arc<Self>, app: &AppHandle, cwd: &str) -> Result<(), String> {
        eprintln!(
            "[CWD] init_runtime cwd={:?} exists={}",
            cwd,
            std::path::Path::new(cwd).exists()
        );
        if cwd.is_empty() {
            eprintln!("[CWD] WARNING cwd is empty — bash tool will fail");
        } else if !std::path::Path::new(cwd).exists() {
            eprintln!("[CWD] WARNING cwd does not exist — bash tool will fail");
        }

        let session_dir = Self::session_dir_for(cwd);
        let session_manager = pi_coding_agent::core::session_manager::SessionManager::new(
            cwd,
            &session_dir,
            None,
            true,
            None,
        );
        self.spawn_runtime(app, cwd, session_manager).await
    }

    /// Select a session: abort current streaming, discard old runtime, and
    /// initialize a new runtime for the selected session (loading its session
    /// file if one exists on disk).
    pub async fn select_session(
        self: &Arc<Self>,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<DesktopState, String> {
        // 1. Bump generation so any in-flight send_message task won't
        //    overwrite our new runtime with the old one.
        self.generation.fetch_add(1, Ordering::SeqCst);

        // 2. Abort any current streaming
        self.abort().await;

        // 3. Discard old runtime
        *self.runtime.lock().await = None;

        // 4. Update state (selected_session_id)
        let state = self
            .mutate(app, |s| {
                session::select_session_by_id(s, session_id);
            })
            .await;

        // 5. Read session info for runtime init (cwd + session_file)
        let (cwd, session_file) = {
            let state_lock = self.state.lock().await;
            let sess = state_lock.sessions.iter().find(|s| s.id == session_id);
            match sess {
                Some(s) => (
                    resolve_session_cwd(s.cwd.as_deref()),
                    s.session_file.clone().filter(|f| !f.is_empty()),
                ),
                None => return Ok(state),
            }
        };

        // 6. Initialize a new runtime for the selected session
        let session_dir = Self::session_dir_for(&cwd);
        let session_manager = pi_coding_agent::core::session_manager::SessionManager::new(
            &cwd,
            &session_dir,
            session_file.as_deref(),
            true,
            None,
        );
        self.spawn_runtime(app, &cwd, session_manager).await?;

        Ok(self.state.lock().await.clone())
    }

    pub async fn send_message(self: &Arc<Self>, app: &AppHandle, text: &str) -> Result<(), String> {
        // Lazily init runtime if not yet created
        if self.runtime.lock().await.is_none() {
            let cwd = {
                let state = self.state.lock().await;
                let sess_cwd = state
                    .sessions
                    .iter()
                    .find(|s| s.id == state.selected_session_id)
                    .and_then(|s| s.cwd.as_deref());
                resolve_session_cwd(sess_cwd)
            };
            self.init_runtime(app, &cwd).await?;
        }

        let sid = self.session_id.lock().await.clone().ok_or("No session")?;
        let mut runtime = self.runtime.lock().await.take().ok_or("No session")?;
        self.abort_flag.store(false, Ordering::SeqCst);
        self.is_streaming.store(true, Ordering::SeqCst);
        let s = self.clone();
        let a = app.clone();
        let t = text.to_string();
        let sid2 = sid.clone();
        let abort = self.abort_flag.clone();
        let gen = self.generation.load(Ordering::SeqCst);
        let _ = app.emit(
            "agent-event",
            FrontendEvent {
                event_type: "user_message".into(),
                session_id: sid,
                data: json!({"text": text, "timestamp": chrono::Utc::now().timestamp_millis()}),
            },
        );

        let diag_provider;
        let diag_model;
        {
            let agent_dir = pi_coding_agent::config::get_agent_dir();
            let mgr = pi_coding_agent::core::settings_manager::SettingsManager::create(
                agent_dir.to_string_lossy().as_ref(),
                Some(agent_dir.to_string_lossy().as_ref()),
            );
            let settings = mgr.get_settings();
            diag_provider = settings.default_provider.clone();
            diag_model = settings.default_model.clone();
        }
        eprintln!("[LLM] send: provider={diag_provider:?} model={diag_model:?}");

        tokio::spawn(async move {
            // Check abort before starting agent loop
            if !abort.load(Ordering::SeqCst) {
                eprintln!("[LLM] <<< {}", &t);
                // add_user_text persists the user message AND runs the agent loop.
                // Wrap with a 5-minute timeout to prevent hanging when the LLM
                // API has no timeout configured or no API key is set.
                let agent_fut = runtime.session_mut().add_user_text(&t);
                if tokio::time::timeout(std::time::Duration::from_secs(300), agent_fut)
                    .await
                    .is_err()
                {
                    eprintln!("[LLM] add_user_text timed out after 300s, aborting");
                    runtime.session().abort().await;
                }
            }
            eprintln!("[LLM] add_user_text done");
            // Only put the runtime back if the generation hasn't changed
            // (i.e. no session switch happened while we were streaming).
            if s.generation.load(Ordering::SeqCst) == gen {
                *s.runtime.lock().await = Some(runtime);
            } else {
                eprintln!("[LLM] generation changed — discarding stale runtime");
            }
            s.is_streaming.store(false, Ordering::SeqCst);
            // Emit transcript with captured sid2 (not state.selected_session_id)
            // so the frontend gets the right transcript even after a session switch.
            let msgs2 = s.get_messages().await;
            let transcript = build_display_transcript(&msgs2);
            if !transcript.is_empty() {
                let payload = json!({"sessionId": sid2, "transcript": transcript});
                let _ = a.emit("pi-gui:selected-transcript-changed", &payload);
            }
        });
        Ok(())
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
        eprintln!(
            "[CWD] set_session_cwd sid={} new_cwd={:?} current_cwd={:?} session_file={:?} action={:?}",
            session_id, new_cwd, current_cwd, current_file, action
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
                // Fork the session via AgentSessionRuntime.
                // pi-rs copies the history into a new session file under the new cwd.
                let old_file = current_file.clone().unwrap_or_default();
                let result = if old_file.is_empty() {
                    // No history to fork — just init a new runtime
                    self.init_runtime(app, &new_cwd).await.map(|_| ())
                } else {
                    // Discard old runtime and create a new one forked from the old file
                    *self.runtime.lock().await = None;
                    let session_dir = Self::session_dir_for(&new_cwd);
                    let session_manager =
                        pi_coding_agent::core::session_manager::SessionManager::fork_from(
                            &old_file,
                            &new_cwd,
                            Some(&session_dir),
                            None,
                        )
                        .map_err(|e| format!("Failed to fork session: {e}"))?;
                    self.spawn_runtime(app, &new_cwd, session_manager).await
                };
                match result {
                    Ok(()) => {
                        // Verify pi-rs backfilled session_file onto the new record.
                        let state = self.state.lock().await;
                        let file_set = state
                            .sessions
                            .iter()
                            .any(|s| s.id == new_id && s.session_file.is_some());
                        if !file_set {
                            drop(state);
                            let old_sid = session_id.to_string();
                            self.mutate(app, |s| {
                                s.sessions.retain(|s| s.id != new_id);
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

    pub async fn abort(&self) {
        // Set the abort flag first — works even when runtime is moved into a tokio task
        self.abort_flag.store(true, Ordering::SeqCst);
        // Also try to abort the AgentSession directly if it's available
        if let Some(r) = self.runtime.lock().await.as_ref() {
            r.session().abort().await;
        }
        self.is_streaming.store(false, Ordering::SeqCst);
    }

    pub async fn get_messages(&self) -> Vec<AgentMessage> {
        match self.runtime.lock().await.as_ref() {
            Some(r) => r.session().get_messages().await,
            None => vec![],
        }
    }
}
