//! Internal helpers, types, and the Store struct.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pi_agent_core::types::{AgentEvent, AgentMessage};
use pi_coding_agent::core::agent_session::AgentSession;
use pi_coding_agent::core::sdk::{create_agent_session, CreateAgentSessionOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::persistence;

// ── DesktopState struct ─────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub revision: u64,
    pub sessions: Vec<SessionRecord>,
    pub selected_session_id: String,
    #[serde(rename = "runtimeByWorkspace")]
    pub runtime: RuntimeSnapshot,
    pub global_model_settings: GlobalModelSettings,
    pub theme_mode: String,
    pub theme_preset_id: String,
    #[serde(default)]
    pub active_view: String,
    #[serde(default)]
    pub sidebar_collapsed: bool,
    // Composer fields
    #[serde(default)]
    pub composer_draft: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub composer_draft_sync_source: Option<String>,
    #[serde(default)]
    pub composer_draft_sync_nonce: u64,
    #[serde(default)]
    pub composer_attachments: Vec<Value>,
    #[serde(default)]
    pub editing_queued_message_id: Option<String>,
    #[serde(default)]
    pub queued_composer_messages: Vec<Value>,
    // Optional UI fields
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub notification_preferences: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub integrated_terminal_shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enable_transparency: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_settings_scope_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub updated_at: String,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub has_unseen_update: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thinking_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub models: Vec<Value>,
    pub providers: Vec<Value>,
    #[serde(default)]
    pub skills: Vec<Value>,
    #[serde(default)]
    pub commands: Vec<Value>,
    pub settings: RuntimeSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    #[serde(default)]
    pub enabled_model_patterns: Vec<String>,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model_id: Option<String>,
    #[serde(default)]
    pub default_thinking_level: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalModelSettings {
    #[serde(default)]
    pub enabled_model_patterns: Vec<String>,
    #[serde(default)]
    pub default_provider: Option<String>,
    #[serde(default)]
    pub default_model_id: Option<String>,
    #[serde(default)]
    pub default_thinking_level: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrontendEvent {
    pub event_type: String,
    pub session_id: String,
    pub data: serde_json::Value,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn set_sess_status(s: &mut DesktopState, sid: &str, status: &str) {
    if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sid) {
        sess.status = status.to_string();
    }
}

pub fn set_sess_field(
    s: &mut DesktopState,
    sess_id: &str,
    field: &str,
    value: serde_json::Value,
) {
    if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sess_id) {
        match field {
            "archivedAt" => sess.archived_at = value.as_str().map(|s| s.to_string()),
            "pinnedAt" => sess.archived_at = value.as_str().map(|s| s.to_string()),
            "sessionFile" => sess.session_file = value.as_str().map(|s| s.to_string()),
            _ => {}
        }
    }
}

pub fn serialize_event(event: &AgentEvent) -> (String, serde_json::Value) {
    match event {
        AgentEvent::AgentStart => ("agent_start".into(), json!({})),
        AgentEvent::AgentEnd { messages } => ("agent_end".into(), json!({"messages": messages})),
        AgentEvent::TurnStart => ("turn_start".into(), json!({})),
        AgentEvent::TurnEnd { message, tool_results } => (
            "turn_end".into(),
            json!({"message": message, "tool_results": tool_results}),
        ),
        AgentEvent::MessageStart { message } => ("message_start".into(), json!({"message": message})),
        AgentEvent::MessageUpdate { assistant_message_event, .. } => (
            "message_update".into(),
            serde_json::to_value(assistant_message_event).unwrap_or_default(),
        ),
        AgentEvent::MessageEnd { message } => ("message_end".into(), json!({"message": message})),
        AgentEvent::ToolExecutionStart { tool_call_id, tool_name, args } => (
            "tool_execution_start".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args}),
        ),
        AgentEvent::ToolExecutionUpdate { tool_call_id, tool_name, args, partial_result } => (
            "tool_execution_update".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args, "partial_result": partial_result}),
        ),
        AgentEvent::ToolExecutionEnd { tool_call_id, tool_name, result, is_error } => (
            "tool_execution_end".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "result": result, "is_error": is_error}),
        ),
    }
}

// ── Default state ──────────────────────────────────────────

pub fn default_state() -> DesktopState {
    DesktopState {
        revision: 1,
        sessions: vec![],
        selected_session_id: String::new(),
        runtime: RuntimeSnapshot {
            models: vec![],
            providers: vec![],
            skills: vec![],
            commands: vec![],
            settings: RuntimeSettings {
                enabled_model_patterns: vec![],
                default_provider: None,
                default_model_id: None,
                default_thinking_level: None,
            },
        },
        global_model_settings: GlobalModelSettings {
            enabled_model_patterns: vec![],
            default_provider: None,
            default_model_id: None,
            default_thinking_level: None,
        },
        theme_mode: "system".to_string(),
        theme_preset_id: "default".to_string(),
        active_view: "threads".to_string(),
        sidebar_collapsed: false,
        composer_draft: String::new(),
        composer_draft_sync_source: None,
        composer_draft_sync_nonce: 0,
        composer_attachments: vec![],
        editing_queued_message_id: None,
        queued_composer_messages: vec![],
        notification_preferences: None,
        integrated_terminal_shell: None,
        enable_transparency: None,
        model_settings_scope_mode: None,
    }
}

// ── Store ───────────────────────────────────────────────────

pub struct Store {
    pub state: Mutex<DesktopState>,
    pub session: Mutex<Option<AgentSession>>,
    pub session_id: Mutex<Option<String>>,
    pub is_streaming: AtomicBool,
}

impl Store {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(default_state()),
            session: Mutex::new(None),
            session_id: Mutex::new(None),
            is_streaming: AtomicBool::new(false),
        })
    }

    pub fn new_with_runtime() -> Arc<Self> {
        let restored = persistence::restore_state();
        let store = Self::new();
        {
            let mut state = store.state.blocking_lock();
            let mut s = default_state();
            if !restored.selected_session_id.is_empty() {
                s.selected_session_id = restored.selected_session_id.clone();
            }
            s.sessions = super::session::scan_existing_sessions();
            s.runtime = super::runtime::build_runtime_snapshot();
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
        persistence::persist_state(&result);
        drop(state);
        result
    }

    /// Create an AgentSession for an EXISTING session record (no duplicate push).
    async fn init_session(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
        current_sid: &str,
        session_file: Option<String>,
    ) -> Result<(), String> {
        pi_ai::providers::register_builtins::register_built_in_api_providers();

        let (provider, model_id, thinking_level) = {
            let state = self.state.lock().await;
            (
                state.runtime.settings.default_provider.clone(),
                state.runtime.settings.default_model_id.clone(),
                state.runtime.settings.default_thinking_level.clone(),
            )
        };

        use pi_coding_agent::core::model_registry::ModelRegistry;
        let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
        let initial_model = provider
            .as_ref()
            .and_then(|p| model_id.as_ref().and_then(|m| registry.find(p, m)));
        let stream_fn = pi_coding_agent::core::sdk::create_default_stream_fn();

        let opts = CreateAgentSessionOptions {
            cwd: cwd.to_string(),
            agent_dir: None,
            model: initial_model.clone(),
            thinking_level,
            scoped_models: None,
            no_tools: None,
            tools: None,
            exclude_tools: None,
            custom_prompt: None,
            append_system_prompt: None,
            session_name: None,
            stream_fn: Some(stream_fn.clone()),
            convert_to_llm: None,
            extension_paths: vec![],
            enable_extensions: false,
            cli_provider: None,
            cli_model: None,
            persist_session: true,
            session_file: session_file.clone(),
            fork_from: None,
            session_dir: None,
        };
        let (mut session, _result) = create_agent_session(opts)
            .await
            .map_err(|e| format!("{e}"))?;

        let sess_file_path = session
            .get_session_manager()
            .get_session_file()
            .map(|p| p.to_string_lossy().to_string());
        let sid = current_sid.to_string();
        *self.session_id.lock().await = Some(sid.clone());
        self.mutate(app, |s| {
            if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sid) {
                if let Some(fp) = &sess_file_path {
                    sess.session_file = Some(fp.clone());
                }
            }
            s.selected_session_id = sid.clone();
        }).await;

        let store = self.clone();
        let a = app.clone();
        let sid2 = sid.clone();
        session
            .subscribe(Arc::new(move |event: AgentEvent, _signal| {
                let store = store.clone();
                let app = a.clone();
                let sid = sid2.clone();
                Box::pin(async move {
                    let (et, data) = serialize_event(&event);
                    if et == "agent_start" || et == "turn_start" {
                        store.mutate(&app, |s| { set_sess_status(s, &sid, "running"); }).await;
                    } else if et == "agent_end" || et == "turn_end" {
                        store.mutate(&app, |s| { set_sess_status(s, &sid, "idle"); }).await;
                    }
                    let _ = app.emit("agent-event", FrontendEvent { event_type: et, session_id: sid, data });
                })
            }))
            .await;
        *self.session.lock().await = Some(session);
        Ok(())
    }

    /// Create an agent session. Pushes a new session record.
    pub async fn create_agent_session(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
        session_file: Option<String>,
    ) -> Result<String, String> {
        pi_ai::providers::register_builtins::register_built_in_api_providers();

        let (provider, model_id, thinking_level) = {
            let state = self.state.lock().await;
            (
                state.runtime.settings.default_provider.clone(),
                state.runtime.settings.default_model_id.clone(),
                state.runtime.settings.default_thinking_level.clone(),
            )
        };

        eprintln!("[LLM] create session: provider={provider:?} model={model_id:?} session_file={session_file:?}");

        use pi_coding_agent::core::model_registry::ModelRegistry;
        let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
        let initial_model = provider
            .as_ref()
            .and_then(|p| model_id.as_ref().and_then(|m| registry.find(p, m)));

        let stream_fn = pi_coding_agent::core::sdk::create_default_stream_fn();

        let sf = session_file.clone();
        let opts = || CreateAgentSessionOptions {
            cwd: cwd.to_string(),
            agent_dir: None,
            model: initial_model.clone(),
            thinking_level: thinking_level.clone(),
            scoped_models: None,
            no_tools: None,
            tools: None,
            exclude_tools: None,
            custom_prompt: None,
            append_system_prompt: None,
            session_name: None,
            stream_fn: Some(stream_fn.clone()),
            convert_to_llm: None,
            extension_paths: vec![],
            enable_extensions: false,
            cli_provider: None,
            cli_model: None,
            persist_session: true,
            session_file: sf.clone(),
            fork_from: None,
            session_dir: None,
        };
        let (mut session, result) = create_agent_session(opts())
            .await
            .map_err(|e| format!("{e}"))?;
        eprintln!("[LLM] session created: model_fallback={:?}", result.model_fallback_message);
        eprintln!("[LLM] session cwd={} id={} name={:?}",
            session.get_cwd(), session.get_session_id(), session.get_session_name());
        eprintln!("[LLM] session scoped_models count={}", session.get_scoped_models().len());

        let sess_file_path = session
            .get_session_manager()
            .get_session_file()
            .map(|p| p.to_string_lossy().to_string());
        eprintln!("[LLM] session file: {:?}", sess_file_path);
        let sid = format!("sess-{}", uuid::Uuid::new_v4());
        *self.session_id.lock().await = Some(sid.clone());
        self.mutate(app, |s| {
            s.sessions.push(SessionRecord {
                id: sid.clone(),
                title: "New thread".to_string(),
                updated_at: now_iso(),
                preview: String::new(),
                status: "idle".to_string(),
                has_unseen_update: false,
                session_file: sess_file_path.clone(),
                archived_at: None,
                config: None,
                thinking_level: None,
            });
            s.selected_session_id = sid.clone();
        }).await;

        let store = self.clone();
        let a = app.clone();
        let sid2 = sid.clone();
        session
            .subscribe(Arc::new(move |event: AgentEvent, _signal| {
                let store = store.clone();
                let app = a.clone();
                let sid = sid2.clone();
                Box::pin(async move {
                    let (et, data) = serialize_event(&event);
                    if et == "agent_start" || et == "turn_start" {
                        store.mutate(&app, |s| { set_sess_status(s, &sid, "running"); }).await;
                    } else if et == "agent_end" || et == "turn_end" {
                        store.mutate(&app, |s| { set_sess_status(s, &sid, "idle"); }).await;
                    }
                    let _ = app.emit("agent-event", FrontendEvent { event_type: et, session_id: sid, data });
                })
            }))
            .await;
        *self.session.lock().await = Some(session);
        Ok(sid)
    }

    pub async fn send_message(self: &Arc<Self>, app: &AppHandle, text: &str) -> Result<(), String> {
        let sid = self.session_id.lock().await.clone().ok_or("No session")?;
        let mut session = self.session.lock().await.take().ok_or("No session")?;
        self.is_streaming.store(true, Ordering::SeqCst);
        let s = self.clone();
        let a = app.clone();
        let t = text.to_string();
        let sid2 = sid.clone();
        let _ = app.emit("agent-event", FrontendEvent {
            event_type: "user_message".into(),
            session_id: sid,
            data: json!({"text": text, "timestamp": chrono::Utc::now().timestamp_millis()}),
        });

        let state_snapshot = self.state.lock().await.clone();
        let diag_provider = state_snapshot.runtime.settings.default_provider.clone();
        let diag_model = state_snapshot.runtime.settings.default_model_id.clone();
        eprintln!("[LLM] send: provider={diag_provider:?} model={diag_model:?}");
        drop(state_snapshot);

        tokio::spawn(async move {
            eprintln!("[LLM] <<< {}", &t);
            session.add_user_text(&t).await;
            eprintln!("[LLM] add_user_text done");
            let msgs = session.get_messages().await;
            for msg in &msgs {
                if let pi_agent_core::types::AgentMessage::Assistant { content, error_message, api, provider, model, .. } = msg {
                    if let Some(e) = error_message {
                        eprintln!("[LLM] error: {e}");
                        let err_debug = format!("{:#?}", e);
                        if err_debug != e.to_string() { eprintln!("[LLM] error debug: {err_debug}"); }
                    }
                    eprintln!("[LLM] assistant msg: api={api} provider={provider} model={model}");
                    let text: String = content.iter()
                        .filter_map(|b| if let pi_agent_core::pi_ai_types::ContentBlock::Text { text, .. } = b { Some(text.clone()) } else { None })
                        .collect();
                    if !text.is_empty() { eprintln!("[LLM] >>> {text}"); }
                }
            }
            *s.session.lock().await = Some(session);
            s.is_streaming.store(false, Ordering::SeqCst);
            let _ = a.emit("agent-event", FrontendEvent {
                event_type: "turn_end".into(),
                session_id: sid2.clone(),
                data: json!({"message": null, "tool_results": []}),
            });
            let msgs2 = s.get_messages().await;
            // Use captured sid2 (not state.selected_session_id) to avoid
            // emitting transcript for the wrong session after a switch.
            let transcript: Vec<serde_json::Value> = msgs2.iter().filter_map(|msg| {
                let (role, content, ts) = match msg {
                    AgentMessage::User { content, timestamp } => ("user", content, *timestamp),
                    AgentMessage::Assistant { content, timestamp, .. } => ("assistant", content, *timestamp),
                    _ => return None,
                };
                let text: String = content.iter()
                    .filter_map(|b| if let pi_agent_core::pi_ai_types::ContentBlock::Text { text, .. } = b { Some(text.clone()) } else { None })
                    .collect();
                let ts_secs = ts as f64 / 1000.0;
                let created = chrono::DateTime::from_timestamp(ts_secs as i64, 0)
                    .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                    .unwrap_or_else(now_iso);
                Some(json!({"id": format!("msg-{}", ts), "kind": "message", "role": role, "text": text, "createdAt": created}))
            }).collect();
            if !transcript.is_empty() {
                let payload = json!({"sessionId": sid2, "transcript": transcript});
                let _ = a.emit("pi-gui:selected-transcript-changed", &payload);
            }
        });
        Ok(())
    }

    /// Ensure an AgentSession exists. If none is attached, reads the current
    /// UI state to find the selected session record and attaches to it.
    pub async fn ensure_session(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        if self.session.lock().await.is_some() {
            return Ok(());
        }
        let (sid, cwd, session_file) = {
            let state = self.state.lock().await;
            let sid = state.selected_session_id.clone();
            let cwd = std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| {
                    std::env::var("HOME")
                        .map(|h| format!("{}/.pi-rs", h))
                        .unwrap_or_else(|_| "/tmp".into())
                });
            let file = state.sessions.iter()
                .find(|s| s.id == sid)
                .and_then(|s| s.session_file.as_ref().filter(|f| !f.is_empty()))
                .cloned();
            (sid, cwd, file)
        };
        if sid.is_empty() {
            return Err("No active session".into());
        }
        self.init_session(app, &cwd, &sid, session_file).await
    }

    pub async fn abort(&self) {
        if let Some(s) = self.session.lock().await.as_ref() {
            s.abort().await;
        }
        self.is_streaming.store(false, Ordering::SeqCst);
    }

    pub async fn get_messages(&self) -> Vec<AgentMessage> {
        match self.session.lock().await.as_ref() {
            Some(s) => s.get_messages().await,
            None => vec![],
        }
    }
}
