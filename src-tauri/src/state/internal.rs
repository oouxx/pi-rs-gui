//! Internal helpers, types, and the Store struct.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pi_agent_core::pi_ai_types::ContentBlock;
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
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

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn set_sess_status(s: &mut DesktopState, sid: &str, status: &str) {
    if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sid) {
        sess.status = status.to_string();
    }
}

pub fn serialize_event(event: &AgentEvent) -> (String, serde_json::Value) {
    match event {
        AgentEvent::AgentStart => ("agent_start".into(), json!({})),
        AgentEvent::AgentEnd { messages } => ("agent_end".into(), json!({"messages": messages})),
        AgentEvent::TurnStart => ("turn_start".into(), json!({})),
        AgentEvent::TurnEnd {
            message,
            tool_results,
        } => (
            "turn_end".into(),
            json!({"message": message, "tool_results": tool_results}),
        ),
        AgentEvent::MessageStart { message } => {
            ("message_start".into(), json!({"message": message}))
        }
        AgentEvent::MessageUpdate {
            assistant_message_event,
            ..
        } => (
            "message_update".into(),
            serde_json::to_value(assistant_message_event).unwrap_or_default(),
        ),
        AgentEvent::MessageEnd { message } => ("message_end".into(), json!({"message": message})),
        AgentEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => (
            "tool_execution_start".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args}),
        ),
        AgentEvent::ToolExecutionUpdate {
            tool_call_id,
            tool_name,
            args,
            partial_result,
        } => (
            "tool_execution_update".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args, "partial_result": partial_result}),
        ),
        AgentEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            result,
            is_error,
        } => (
            "tool_execution_end".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "result": result, "is_error": is_error}),
        ),
    }
}

/// Build a display transcript from agent messages, preserving structured
/// content blocks (text/thinking/toolCall) instead of flattening to plain
/// text. Tool results are merged onto their corresponding toolCall blocks so
/// the frontend can render `ToolCallCard` with `status`/`result`/`isError`
/// both after a turn completes and on session reload.
pub fn build_display_transcript(msgs: &[AgentMessage]) -> Vec<serde_json::Value> {
    // First pass: collect tool results keyed by tool_call_id.
    let mut tool_results: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    for msg in msgs {
        if let AgentMessage::ToolResult {
            tool_call_id,
            content,
            is_error,
            ..
        } = msg
        {
            let text: String = content
                .iter()
                .filter_map(|b| {
                    if let ContentBlock::Text { text, .. } = b {
                        Some(text.clone())
                    } else {
                        None
                    }
                })
                .collect();
            tool_results.insert(tool_call_id.clone(), (text, *is_error));
        }
    }

    // Second pass: emit user/assistant messages with structured content blocks.
    let mut out = Vec::new();
    for msg in msgs {
        let (role, content, ts) = match msg {
            AgentMessage::User { content, timestamp } => ("user", content, *timestamp),
            AgentMessage::Assistant {
                content, timestamp, ..
            } => ("assistant", content, *timestamp),
            _ => continue,
        };

        // Serialize full content blocks, then inject tool execution state
        // onto toolCall blocks from the matching toolResult message.
        let mut blocks_val = serde_json::to_value(content).unwrap_or(json!([]));
        if let Some(arr) = blocks_val.as_array_mut() {
            for b in arr.iter_mut() {
                if b.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                    if let Some(id) = b.get("id").and_then(|i| i.as_str()) {
                        if let Some((result, is_error)) = tool_results.get(id) {
                            b["status"] = json!(if *is_error { "error" } else { "success" });
                            b["result"] = json!(result);
                            b["isError"] = json!(is_error);
                        }
                    }
                }
            }
        }

        // Flattened text is kept for backward compatibility; the frontend
        // prefers the structured `content` array when present.
        let text: String = content
            .iter()
            .filter_map(|b| {
                if let ContentBlock::Text { text, .. } = b {
                    Some(text.clone())
                } else {
                    None
                }
            })
            .collect();

        let ts_secs = ts as f64 / 1000.0;
        let created = chrono::DateTime::from_timestamp(ts_secs as i64, 0)
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .unwrap_or_else(now_iso);

        out.push(json!({
            "id": format!("msg-{}", ts),
            "kind": "message",
            "role": role,
            "text": text,
            "content": blocks_val,
            "createdAt": created,
        }));
    }
    out
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
    /// Abort signal that works even when the AgentSession is moved into a tokio task.
    pub abort_flag: Arc<AtomicBool>,
}

impl Store {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(default_state()),
            session: Mutex::new(None),
            session_id: Mutex::new(None),
            is_streaming: AtomicBool::new(false),
            abort_flag: Arc::new(AtomicBool::new(false)),
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
        fork_from: Option<String>,
    ) -> Result<(), String> {
        eprintln!(
            "[CWD] init_session sid={} cwd={:?} exists={} session_file={:?} fork_from={:?}",
            current_sid,
            cwd,
            std::path::Path::new(cwd).exists(),
            session_file,
            fork_from
        );
        if cwd.is_empty() {
            eprintln!("[CWD] WARNING cwd is empty — bash tool will fail");
        } else if !std::path::Path::new(cwd).exists() {
            eprintln!("[CWD] WARNING cwd does not exist — bash tool will fail");
        }
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
            fork_from: fork_from.clone(),
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
        })
        .await;

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
                        store
                            .mutate(&app, |s| {
                                set_sess_status(s, &sid, "running");
                            })
                            .await;
                    } else if et == "agent_end" || et == "turn_end" {
                        store
                            .mutate(&app, |s| {
                                set_sess_status(s, &sid, "idle");
                            })
                            .await;
                    }
                    // Tool-execution diagnostics: log each tool start/end so the
                    // terminal shows what ran and whether it failed. The bash tool
                    // returns "Working directory does not exist" as its result text
                    // when cwd is invalid, so surfacing results here pinpoints the
                    // failure without digging through JSONL files.
                    if et == "tool_execution_start" {
                        eprintln!(
                            "[TOOL] start sid={} id={} name={}",
                            sid,
                            data.get("tool_call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(""),
                            data.get("tool_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?"),
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
                                data.get("result")
                                    .map(|v| v.to_string())
                                    .unwrap_or_default()
                            });
                        let snippet: String = result_str.chars().take(160).collect();
                        eprintln!(
                            "[TOOL] end   sid={} id={} name={} is_error={} result={:?}",
                            sid,
                            data.get("tool_call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(""),
                            data.get("tool_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?"),
                            is_error,
                            snippet,
                        );
                    }
                    let _ = app.emit(
                        "agent-event",
                        FrontendEvent {
                            event_type: et,
                            session_id: sid,
                            data,
                        },
                    );
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
        eprintln!(
            "[LLM] session created: model_fallback={:?}",
            result.model_fallback_message
        );
        eprintln!(
            "[LLM] session cwd={} id={} name={:?}",
            session.get_cwd(),
            session.get_session_id(),
            session.get_session_name()
        );
        eprintln!(
            "[LLM] session scoped_models count={}",
            session.get_scoped_models().len()
        );

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
                cwd: None,
            });
            s.selected_session_id = sid.clone();
        })
        .await;

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
                        store
                            .mutate(&app, |s| {
                                set_sess_status(s, &sid, "running");
                            })
                            .await;
                    } else if et == "agent_end" || et == "turn_end" {
                        store
                            .mutate(&app, |s| {
                                set_sess_status(s, &sid, "idle");
                            })
                            .await;
                    }
                    // Tool-execution diagnostics: log each tool start/end so the
                    // terminal shows what ran and whether it failed. The bash tool
                    // returns "Working directory does not exist" as its result text
                    // when cwd is invalid, so surfacing results here pinpoints the
                    // failure without digging through JSONL files.
                    if et == "tool_execution_start" {
                        eprintln!(
                            "[TOOL] start sid={} id={} name={}",
                            sid,
                            data.get("tool_call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(""),
                            data.get("tool_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?"),
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
                                data.get("result")
                                    .map(|v| v.to_string())
                                    .unwrap_or_default()
                            });
                        let snippet: String = result_str.chars().take(160).collect();
                        eprintln!(
                            "[TOOL] end   sid={} id={} name={} is_error={} result={:?}",
                            sid,
                            data.get("tool_call_id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(""),
                            data.get("tool_name")
                                .and_then(|v| v.as_str())
                                .unwrap_or("?"),
                            is_error,
                            snippet,
                        );
                    }
                    let _ = app.emit(
                        "agent-event",
                        FrontendEvent {
                            event_type: et,
                            session_id: sid,
                            data,
                        },
                    );
                })
            }))
            .await;
        *self.session.lock().await = Some(session);
        Ok(sid)
    }

    pub async fn send_message(self: &Arc<Self>, app: &AppHandle, text: &str) -> Result<(), String> {
        let sid = self.session_id.lock().await.clone().ok_or("No session")?;
        let mut session = self.session.lock().await.take().ok_or("No session")?;
        self.abort_flag.store(false, Ordering::SeqCst);
        self.is_streaming.store(true, Ordering::SeqCst);
        let s = self.clone();
        let a = app.clone();
        let t = text.to_string();
        let sid2 = sid.clone();
        let abort = self.abort_flag.clone();
        let _ = app.emit(
            "agent-event",
            FrontendEvent {
                event_type: "user_message".into(),
                session_id: sid,
                data: json!({"text": text, "timestamp": chrono::Utc::now().timestamp_millis()}),
            },
        );

        let state_snapshot = self.state.lock().await.clone();
        let diag_provider = state_snapshot.runtime.settings.default_provider.clone();
        let diag_model = state_snapshot.runtime.settings.default_model_id.clone();
        eprintln!("[LLM] send: provider={diag_provider:?} model={diag_model:?}");
        drop(state_snapshot);

        tokio::spawn(async move {
            // Check abort before starting agent loop
            if !abort.load(Ordering::SeqCst) {
                eprintln!("[LLM] <<< {}", &t);
                // add_user_text persists the user message AND runs the agent loop.
                // Wrap with a 5-minute timeout to prevent hanging when the LLM
                // API has no timeout configured or no API key is set.
                let agent_fut = session.add_user_text(&t);
                if tokio::time::timeout(std::time::Duration::from_secs(300), agent_fut)
                    .await
                    .is_err()
                {
                    eprintln!("[LLM] add_user_text timed out after 300s, aborting");
                    session.abort().await;
                }
            }
            eprintln!("[LLM] add_user_text done");
            // Put session back regardless of outcome
            *s.session.lock().await = Some(session);
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

    /// Ensure an AgentSession exists. If none is attached, reads the current
    /// UI state to find the selected session record and attaches to it.
    pub async fn ensure_session(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        if self.session.lock().await.is_some() {
            return Ok(());
        }
        let (sid, cwd, session_file) = {
            let state = self.state.lock().await;
            let sid = state.selected_session_id.clone();
            let sess_cwd = state
                .sessions
                .iter()
                .find(|s| s.id == sid)
                .and_then(|s| s.cwd.as_deref());
            let cwd = resolve_session_cwd(sess_cwd);
            let file = state
                .sessions
                .iter()
                .find(|s| s.id == sid)
                .and_then(|s| s.session_file.as_ref().filter(|f| !f.is_empty()))
                .cloned();
            let cwd_exists = std::path::Path::new(&cwd).exists();
            eprintln!(
                "[CWD] ensure_session sid={} session_record_cwd={:?} resolved_cwd={:?} exists={} session_file={:?}",
                sid, sess_cwd, cwd, cwd_exists, file
            );
            if !cwd_exists {
                eprintln!("[CWD] WARNING resolved cwd does not exist — bash tool will fail with \"Working directory does not exist\"");
            }
            (sid, cwd, file)
        };
        if sid.is_empty() {
            return Err("No active session".into());
        }
        self.init_session(app, &cwd, &sid, session_file, None).await
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
                // Initialize the new session by forking from the old one.
                // pi-rs copies the history into a new session file under the new cwd.
                let old_file = current_file.clone().unwrap_or_default();
                match self
                    .init_session(
                        app,
                        &new_cwd,
                        &new_id,
                        None,
                        if old_file.is_empty() {
                            None
                        } else {
                            Some(old_file)
                        },
                    )
                    .await
                {
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
        // Set the abort flag first — works even when session is moved into a tokio task
        self.abort_flag.store(true, Ordering::SeqCst);
        // Also try to abort the AgentSession directly if it's available
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
