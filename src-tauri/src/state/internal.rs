//! Internal helpers, types, and the Store struct — matches original
//! `app-store-internals.ts` and part of `app-store.ts`.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pi_agent_core::types::{AgentEvent, AgentMessage};
use pi_coding_agent::core::agent_session::AgentSession;
use pi_coding_agent::core::sdk::{create_agent_session, CreateAgentSessionOptions};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::persistence;

pub type DesktopState = serde_json::Value;

#[derive(Debug, Clone, Serialize)]
pub struct FrontendEvent {
    pub event_type: String,
    pub session_id: String,
    pub data: serde_json::Value,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn next_id(prefix: &str) -> String {
    format!("{}-{}", prefix, chrono::Utc::now().timestamp_millis())
}

pub fn set_sess_status(s: &mut DesktopState, sid: &str, status: &str) {
    let ws_list = match s["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    for ws in ws_list.iter_mut() {
        let sessions = match ws["sessions"].as_array_mut() {
            Some(a) => a,
            None => continue,
        };
        for sess in sessions.iter_mut() {
            if sess["id"] == sid {
                sess["status"] = json!(status);
                return;
            }
        }
    }
}

pub fn set_sess_field(s: &mut DesktopState, target: &serde_json::Value, field: &str, value: serde_json::Value) {
    let ws_id = target["workspaceId"].as_str().unwrap_or("");
    let sess_id = target["sessionId"].as_str().unwrap_or("");
    let ws_list = match s["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    if let Some(ws) = ws_list.iter_mut().find(|w| w["id"] == ws_id) {
        let sessions = match ws["sessions"].as_array_mut() {
            Some(a) => a,
            None => return,
        };
        if let Some(sess) = sessions.iter_mut().find(|s| s["id"] == sess_id) {
            sess[field] = value;
        }
    }
}

pub fn serialize_event(event: &AgentEvent) -> (String, serde_json::Value) {
    match event {
        AgentEvent::AgentStart => ("agent_start".into(), json!({})),
        AgentEvent::AgentEnd { messages } => ("agent_end".into(), json!({"messages": messages})),
        AgentEvent::TurnStart => ("turn_start".into(), json!({})),
        AgentEvent::TurnEnd { message, tool_results } => ("turn_end".into(), json!({"message": message, "tool_results": tool_results})),
        AgentEvent::MessageStart { message } => ("message_start".into(), json!({"message": message})),
        AgentEvent::MessageUpdate { assistant_message_event, .. } => ("message_update".into(), serde_json::to_value(assistant_message_event).unwrap_or_default()),
        AgentEvent::MessageEnd { message } => ("message_end".into(), json!({"message": message})),
        AgentEvent::ToolExecutionStart { tool_call_id, tool_name, args } => ("tool_execution_start".into(), json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args})),
        AgentEvent::ToolExecutionUpdate { tool_call_id, tool_name, args, partial_result } => ("tool_execution_update".into(), json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args, "partial_result": partial_result})),
        AgentEvent::ToolExecutionEnd { tool_call_id, tool_name, result, is_error } => ("tool_execution_end".into(), json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "result": result, "is_error": is_error})),
    }
}

// ── Default state ──────────────────────────────────────────

/// The default UI state skeleton — used by `Store::new()` and by
/// `persistence::restore_state()` as a merge base so that the app
/// never sees a structurally incomplete state.
pub fn default_state() -> DesktopState {
    json!({
        "revision": 1,
        "workspaces": [{
            "id": "ws-default", "name": "default", "path": "",
            "lastOpenedAt": now_iso(), "kind": "primary", "sessions": []
        }],
        "selectedWorkspaceId": "ws-default",
        "selectedSessionId": "",
        "runtimeByWorkspace": {},
        "globalModelSettings": {"enabledModelPatterns": []},
        "themeMode": "system",
        "themePresetId": "default",
    })
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
        // Restore active IDs, scan JSONL files for existing sessions.
        let restored = persistence::restore_state();
        let store = Self::new();
        {
            let mut state = store.state.blocking_lock();
            let mut s = default_state();
            if let Some(ws_id) = restored["selectedWorkspaceId"].as_str().filter(|x| !x.is_empty()) {
                s["selectedWorkspaceId"] = json!(ws_id);
            }
            if let Some(sess_id) = restored["selectedSessionId"].as_str().filter(|x| !x.is_empty()) {
                s["selectedSessionId"] = json!(sess_id);
            }
            // Scan for existing session files on disk
            let scanned = super::session::scan_existing_sessions();
            s["workspaces"][0]["sessions"] = json!(scanned);
            s["runtimeByWorkspace"]["ws-default"] =
                super::runtime::build_runtime_snapshot();
            let rev = s["revision"].as_u64().unwrap_or(0) + 1;
            s["revision"] = json!(rev);
            *state = s;
        }
        store
    }

    pub async fn mutate<F>(self: &Arc<Self>, app: &AppHandle, f: F) -> DesktopState
    where F: FnOnce(&mut DesktopState),
    {
        let mut state = self.state.lock().await;
        f(&mut state);
        let rev = state["revision"].as_u64().unwrap_or(0) + 1;
        state["revision"] = json!(rev);
        let result = state.clone();
        let _ = app.emit("pi-gui:state-changed", &result);
        persistence::persist_state(&result);
        drop(state);
        result
    }

    /// Create an agent session. If `session_file` is provided, it loads
    /// an existing JSONL session file instead of creating a new one.
    pub async fn create_agent_session(self: &Arc<Self>, app: &AppHandle, cwd: &str, session_file: Option<String>) -> Result<String, String> {
        pi_ai::providers::register_builtins::register_built_in_api_providers();

        let state = self.state.lock().await;
        let ws_id = state["selectedWorkspaceId"].as_str().unwrap_or("ws-default").to_string();
        let provider = state["runtimeByWorkspace"][&ws_id]["settings"]["defaultProvider"].as_str().map(|s| s.to_string());
        let model_id = state["runtimeByWorkspace"][&ws_id]["settings"]["defaultModelId"].as_str().map(|s| s.to_string());
        let thinking_level = state["runtimeByWorkspace"][&ws_id]["settings"]["defaultThinkingLevel"].as_str().map(|s| s.to_string());
        drop(state);

        eprintln!("[LLM] create session: provider={provider:?} model={model_id:?} session_file={session_file:?}");

        use pi_coding_agent::core::model_registry::ModelRegistry;
        let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
        let initial_model = provider.as_ref()
            .and_then(|p| model_id.as_ref().and_then(|m| registry.find(p, m)));

        let stream_fn = pi_coding_agent::core::sdk::create_default_stream_fn();

        let sf = session_file.clone();
        let opts = || CreateAgentSessionOptions {
            cwd: cwd.to_string(), agent_dir: None,
            model: initial_model.clone(), thinking_level: thinking_level.clone(),
            scoped_models: None, no_tools: None, tools: None, exclude_tools: None,
            custom_prompt: None, append_system_prompt: None, session_name: None,
            stream_fn: Some(stream_fn.clone()), convert_to_llm: None, extension_paths: vec![],
            enable_extensions: false, cli_provider: None, cli_model: None,
            persist_session: true,
            session_file: sf.clone(),
        };
        let (mut session, result) = create_agent_session(opts()).await.map_err(|e| format!("{e}"))?;
        eprintln!("[LLM] session created: model_fallback={:?}", result.model_fallback_message);
        eprintln!("[LLM] session cwd={} id={} name={:?}", session.get_cwd(), session.get_session_id(), session.get_session_name());
        eprintln!("[LLM] session scoped_models count={}", session.get_scoped_models().len());
        // Capture the session file path for persistence restore
        let sess_file_path = session.get_session_manager().get_session_file()
            .map(|p| p.to_string_lossy().to_string());
        eprintln!("[LLM] session file: {:?}", sess_file_path);
        let sid = format!("sess-{}", uuid::Uuid::new_v4());
        *self.session_id.lock().await = Some(sid.clone());
        self.mutate(app, |s| {
            let sess = json!({
                "id": sid, "title": "New thread", "updatedAt": now_iso(),
                "preview": "", "status": "idle", "hasUnseenUpdate": false,
                "sessionFile": sess_file_path,
            });
            s["workspaces"][0]["sessions"].as_array_mut().unwrap().push(sess);
            s["selectedSessionId"] = json!(&sid);
        }).await;
        let store = self.clone();
        let a = app.clone();
        let sid2 = sid.clone();
        session.subscribe(Arc::new(move |event: AgentEvent, _signal| {
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
        })).await;
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
            event_type: "user_message".into(), session_id: sid,
            data: json!({"text": text, "timestamp": chrono::Utc::now().timestamp_millis()}),
        });

        // ── log provider/model ──────────────────────────────────────
        let state_snapshot = self.state.lock().await.clone();
        let ws_id = state_snapshot["selectedWorkspaceId"].as_str().unwrap_or("?").to_string();
        let diag_provider = state_snapshot["runtimeByWorkspace"][&ws_id]["settings"]["defaultProvider"].as_str().map(|s| s.to_string());
        let diag_model = state_snapshot["runtimeByWorkspace"][&ws_id]["settings"]["defaultModelId"].as_str().map(|s| s.to_string());
        eprintln!("[LLM] send: ws={ws_id} provider={diag_provider:?} model={diag_model:?}");
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
                        if err_debug != e.to_string() {
                            eprintln!("[LLM] error debug: {err_debug}");
                        }
                    }
                    eprintln!("[LLM] assistant msg: api={api} provider={provider} model={model}");
                    let text: String = content.iter().filter_map(|b| if let pi_agent_core::pi_ai_types::ContentBlock::Text { text, .. } = b { Some(text.clone()) } else { None }).collect();
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
            // Push the updated transcript directly — no IPC roundtrip needed
            let msgs2 = s.get_messages().await;
            let state = s.state.lock().await;
            let ws_id = state["selectedWorkspaceId"].as_str().unwrap_or("ws-default");
            let sess_id = state["selectedSessionId"].as_str().unwrap_or("");
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
                let payload = json!({"workspaceId": ws_id, "sessionId": sess_id, "transcript": transcript});
                let _ = a.emit("pi-gui:selected-transcript-changed", &payload);
            }
            drop(state);
        });
        Ok(())
    }

    pub async fn abort(&self) {
        if let Some(s) = self.session.lock().await.as_ref() { s.abort().await; }
        self.is_streaming.store(false, Ordering::SeqCst);
    }

    pub async fn get_messages(&self) -> Vec<AgentMessage> {
        match self.session.lock().await.as_ref() {
            Some(s) => s.get_messages().await,
            None => vec![],
        }
    }
}
