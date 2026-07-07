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
    if let Some(arr) = s["workspaces"][0]["sessions"].as_array_mut() {
        for sess in arr.iter_mut() {
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
    if let Some(ws) = s["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == ws_id) {
        if let Some(sess) = ws["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == sess_id) {
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
            state: Mutex::new(json!({
                "revision": 1,
                "workspaces": [{
                    "id": "ws-default", "name": "default", "path": "/tmp",
                    "lastOpenedAt": now_iso(), "kind": "primary", "sessions": []
                }],
                "worktreesByWorkspace": {},
                "selectedWorkspaceId": "ws-default",
                "selectedSessionId": "",
                "activeView": "threads",
                "composerDraft": "",
                "composerDraftSyncSource": "state",
                "composerDraftSyncNonce": 0,
                "composerAttachments": [],
                "queuedComposerMessages": [],
                "runtimeByWorkspace": {},
                "sessionCommandsBySession": {},
                "sessionExtensionUiBySession": {},
                "extensionCommandCompatibilityByWorkspace": {},
                "orchestrationChildren": [],
                "notificationPreferences": {
                    "backgroundCompletion": true,
                    "backgroundFailure": true,
                    "attentionNeeded": true
                },
                "integratedTerminalShell": "",
                "lastViewedAtBySession": {},
                "pinnedAtBySession": {},
                "pinnedSessionOrder": [],
                "workspaceOrder": [],
                "modelSettingsScopeMode": "app-global",
                "globalModelSettings": {"enabledModelPatterns": []},
                "themeMode": "system",
                "themePresetId": "default",
                "sidebarCollapsed": false,
                "enableTransparency": false,
                "lastError": null
            })),
            session: Mutex::new(None),
            session_id: Mutex::new(None),
            is_streaming: AtomicBool::new(false),
        })
    }

    pub fn new_with_runtime() -> Arc<Self> {
        let store = Self::new();
        let mut state = store.state.blocking_lock();
        state["runtimeByWorkspace"]["ws-default"] = super::runtime::build_runtime_snapshot();
        drop(state);
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
        drop(state);
        result
    }

    pub async fn create_agent_session(self: &Arc<Self>, app: &AppHandle, cwd: &str) -> Result<String, String> {
        pi_ai::providers::register_builtins::register_built_in_api_providers();

        let state = self.state.lock().await;
        let ws_id = state["selectedWorkspaceId"].as_str().unwrap_or("ws-default").to_string();
        let provider = state["runtimeByWorkspace"][&ws_id]["settings"]["defaultProvider"].as_str().map(|s| s.to_string());
        let model_id = state["runtimeByWorkspace"][&ws_id]["settings"]["defaultModelId"].as_str().map(|s| s.to_string());
        let thinking_level = state["runtimeByWorkspace"][&ws_id]["settings"]["defaultThinkingLevel"].as_str().map(|s| s.to_string());
        drop(state);

        use pi_coding_agent::core::model_registry::ModelRegistry;
        let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
        let initial_model = provider.as_ref()
            .and_then(|p| model_id.as_ref().and_then(|m| registry.find(p, m)));

        let had_key = std::env::var("ANTHROPIC_API_KEY").is_ok();
        let opts = || CreateAgentSessionOptions {
            cwd: cwd.to_string(), agent_dir: None,
            model: initial_model.clone(), thinking_level: thinking_level.clone(),
            scoped_models: None, no_tools: None, tools: None, exclude_tools: None,
            custom_prompt: None, append_system_prompt: None, session_name: None,
            stream_fn: None, convert_to_llm: None, extension_paths: vec![], enable_extensions: false,
        };
        let result = create_agent_session(opts()).await;
        let (mut session, _) = match result {
            Ok(v) => v,
            Err(ref e) if e.to_string().contains("No models available") && !had_key => {
                std::env::set_var("ANTHROPIC_API_KEY", "placeholder");
                let r = create_agent_session(opts()).await.map_err(|e| format!("{e}"))?;
                std::env::remove_var("ANTHROPIC_API_KEY");
                r
            }
            Err(e) => return Err(format!("{e}")),
        };
        let sid = format!("sess-{}", uuid::Uuid::new_v4());
        *self.session_id.lock().await = Some(sid.clone());
        self.mutate(app, |s| {
            s["workspaces"][0]["sessions"].as_array_mut().unwrap().push(json!({
                "id": sid, "title": "New thread", "updatedAt": now_iso(),
                "preview": "", "status": "idle", "hasUnseenUpdate": false,
            }));
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
        tokio::spawn(async move {
            session.add_user_text(&t).await;
            *s.session.lock().await = Some(session);
            s.is_streaming.store(false, Ordering::SeqCst);
            let _ = a.emit("agent-event", FrontendEvent {
                event_type: "turn_end".into(),
                session_id: sid2,
                data: json!({"message": null, "tool_results": []}),
            });
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
