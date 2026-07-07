use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use pi_agent_core::pi_ai_types::ContentBlock;
use pi_agent_core::types::{AgentEvent, AgentMessage};
use pi_coding_agent::core::agent_session::AgentSession;
use pi_coding_agent::core::sdk::{create_agent_session, CreateAgentSessionOptions};

type DesktopState = serde_json::Value;

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn next_id(prefix: &str) -> String {
    format!("{}-{}", prefix, chrono::Utc::now().timestamp_millis())
}

#[derive(Debug, Clone, Serialize)]
pub struct FrontendEvent {
    pub event_type: String,
    pub session_id: String,
    pub data: serde_json::Value,
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
        state["runtimeByWorkspace"]["ws-default"] = build_runtime_snapshot();
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
        let had_key = std::env::var("ANTHROPIC_API_KEY").is_ok();
        let opts = || CreateAgentSessionOptions {
            cwd: cwd.to_string(), agent_dir: None, model: None, thinking_level: None,
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
        tokio::spawn(async move {
            let _ = a.emit("agent-event", FrontendEvent {
                event_type: "user_message".into(), session_id: sid.clone(),
                data: json!({"text": t, "timestamp": chrono::Utc::now().timestamp_millis()}),
            });
            session.add_user_text(&t).await;
            *s.session.lock().await = Some(session);
            s.is_streaming.store(false, Ordering::SeqCst);
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

fn set_sess_status(s: &mut DesktopState, sid: &str, status: &str) {
    if let Some(arr) = s["workspaces"][0]["sessions"].as_array_mut() {
        for sess in arr.iter_mut() {
            if sess["id"] == sid { sess["status"] = json!(status); return; }
        }
    }
}

fn serialize_event(event: &AgentEvent) -> (String, serde_json::Value) {
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

// ── Runtime snapshot builder ──────────────────────────────

/// Reads the pi-ai model registry + settings + env vars to build
/// the runtime snapshot that the frontend needs for model lists.
/// Mirrors what `runtimeSupervisor.refreshRuntime()` does in the original.
fn build_runtime_snapshot() -> serde_json::Value {
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    use pi_coding_agent::core::model_registry::ModelRegistry;
    use pi_coding_agent::core::settings_manager::SettingsManager;
    use pi_coding_agent::core::provider_display_names::BUILT_IN_PROVIDER_DISPLAY_NAMES;

    let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
    let s = SettingsManager::create("/tmp", None);
    let settings = s.get_settings();

    let env_keys: std::collections::HashMap<&str, &str> = [
        ("anthropic","ANTHROPIC_API_KEY"),("openai","OPENAI_API_KEY"),
        ("google","GOOGLE_API_KEY"),("deepseek","DEEPSEEK_API_KEY"),
        ("openrouter","OPENROUTER_API_KEY"),("mistral","MISTRAL_API_KEY"),
        ("groq","GROQ_API_KEY"),("xai","XAI_API_KEY"),
    ].iter().cloned().collect();

    let providers = registry.get_providers();
    let mut models = Vec::new();
    let mut provider_list = Vec::new();
    let skills: Vec<serde_json::Value> = Vec::new();

    for pid in &providers {
        let has_auth = env_keys.get(pid.as_str())
            .and_then(|k| std::env::var(k).ok())
            .map(|v| !v.is_empty() && v != "placeholder")
            .unwrap_or(false);

        let name = BUILT_IN_PROVIDER_DISPLAY_NAMES
            .get(pid.as_str())
            .map(|n| n.to_string())
            .unwrap_or_else(|| {
                let mut n = pid.clone();
                if let Some(c) = n.as_mut_str().get_mut(0..1) { c.make_ascii_uppercase(); }
                n
            });

        provider_list.push(json!({"id": pid, "name": name, "hasAuth": has_auth}));

        for m in registry.get_models_for_provider(pid) {
            models.push(json!({
                "providerId": pid,
                "modelId": m.id,
                "providerName": name,
                "label": if m.name.is_empty() { m.id } else { m.name },
                "available": has_auth,
            }));
        }
    }

    json!({
        "models": models,
        "providers": provider_list,
        "skills": skills,
        "commands": [],
        "settings": {
            "enabledModelPatterns": [],
            "defaultProvider": settings.default_provider,
            "defaultModelId": settings.default_model,
            "defaultThinkingLevel": settings.thinking_level,
        }
    })
}

// ── Tauri Commands ──────────────────────────────────────────

use tauri::State;

pub mod cmds {
    use super::*;

    macro_rules! stub {
        ($name:ident) => {
            #[tauri::command]
            pub async fn $name(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
                Ok(store.state.lock().await.clone())
            }
        };
        ($name:ident, $($arg:ident: $t:ty),+) => {
            #[tauri::command]
            pub async fn $name(store: State<'_, Arc<Store>>, $($arg: $t),+) -> Result<DesktopState, String> {
                let _ = ($($arg),+);
                Ok(store.state.lock().await.clone())
            }
        };
    }

    #[tauri::command]
    pub async fn ping() -> String { "pong".into() }

    #[tauri::command]
    pub async fn get_state(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
        Ok(store.state.lock().await.clone())
    }

    #[tauri::command]
    pub async fn create_agent_session_cmd(app: AppHandle, store: State<'_, Arc<Store>>, cwd: String) -> Result<String, String> {
        store.create_agent_session(&app, &cwd).await
    }

    #[tauri::command]
    pub async fn send_message_cmd(app: AppHandle, store: State<'_, Arc<Store>>, text: String) -> Result<(), String> {
        store.send_message(&app, &text).await
    }

    #[tauri::command]
    pub async fn abort_cmd(store: State<'_, Arc<Store>>) -> Result<(), String> {
        store.abort().await; Ok(())
    }

    #[tauri::command]
    pub async fn is_streaming_cmd(store: State<'_, Arc<Store>>) -> Result<bool, String> {
        Ok(store.is_streaming.load(Ordering::SeqCst))
    }

    #[tauri::command]
    pub async fn get_messages_cmd(store: State<'_, Arc<Store>>) -> Result<Vec<AgentMessage>, String> {
        Ok(store.get_messages().await)
    }

    #[tauri::command]
    pub async fn add_workspace_path(app: AppHandle, store: State<'_, Arc<Store>>, path: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            s["workspaces"].as_array_mut().unwrap().push(json!({
                "id": next_id("ws"), "name": path.split('/').last().unwrap_or(&path),
                "path": path, "lastOpenedAt": now_iso(), "kind": "primary", "sessions": []
            }));
        }).await)
    }

    #[tauri::command]
    pub async fn select_workspace(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["selectedWorkspaceId"] = json!(workspace_id); }).await)
    }

    #[tauri::command]
    pub async fn rename_workspace(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, display_name: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if let Some(ws) = s["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == workspace_id) {
                ws["name"] = json!(display_name);
            }
        }).await)
    }

    #[tauri::command]
    pub async fn remove_workspace(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            let prev = s["selectedWorkspaceId"].as_str().unwrap_or("").to_string();
            s["workspaces"].as_array_mut().unwrap().retain(|w| w["id"] != workspace_id);
            if prev == workspace_id {
                s["selectedWorkspaceId"] = json!(s["workspaces"].as_array().and_then(|a| a.first()).map(|w| w["id"].as_str().unwrap()).unwrap_or(""));
            }
        }).await)
    }

    #[tauri::command]
    pub async fn reorder_workspaces(app: AppHandle, store: State<'_, Arc<Store>>, workspace_order: Vec<String>) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            let by_id: std::collections::HashMap<&str, &DesktopState> = s["workspaces"].as_array().unwrap().iter().map(|w| (w["id"].as_str().unwrap(), w)).collect();
            s["workspaces"] = json!(workspace_order.iter().filter_map(|id| by_id.get(id.as_str())).map(|w| (*w).clone()).collect::<Vec<_>>());
        }).await)
    }

    #[tauri::command]
    pub async fn select_session(app: AppHandle, store: State<'_, Arc<Store>>, target: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if let Some(ws_id) = target["workspaceId"].as_str() { s["selectedWorkspaceId"] = json!(ws_id); }
            if let Some(sess_id) = target["sessionId"].as_str() { s["selectedSessionId"] = json!(sess_id); }
        }).await)
    }

    #[tauri::command]
    pub async fn archive_session(app: AppHandle, store: State<'_, Arc<Store>>, target: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { set_sess_field(s, &target, "archivedAt", json!(now_iso())); }).await)
    }

    #[tauri::command]
    pub async fn unarchive_session(app: AppHandle, store: State<'_, Arc<Store>>, target: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { set_sess_field(s, &target, "archivedAt", serde_json::Value::Null); }).await)
    }

    #[tauri::command]
    pub async fn set_session_pinned(app: AppHandle, store: State<'_, Arc<Store>>, target: serde_json::Value, pinned: bool) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            set_sess_field(s, &target, "pinnedAt", if pinned { json!(now_iso()) } else { serde_json::Value::Null });
        }).await)
    }

    #[tauri::command]
    pub async fn create_session(app: AppHandle, store: State<'_, Arc<Store>>, input: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            let ws_id = input["workspaceId"].as_str().unwrap_or("ws-default");
            let sess = json!({"id": next_id("sess"), "title": input["title"].as_str().unwrap_or("New thread"), "updatedAt": now_iso(), "preview": "", "status": "idle", "hasUnseenUpdate": false});
            if let Some(ws) = s["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == ws_id) {
                ws["sessions"].as_array_mut().unwrap().push(sess);
                s["selectedSessionId"] = json!(ws["sessions"].as_array().unwrap().last().unwrap()["id"]);
            }
        }).await)
    }

    #[tauri::command]
    pub async fn cancel_current_run(app: AppHandle, store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
        store.abort().await;
        Ok(store.mutate(&app, |s| {
            let ses = s["selectedSessionId"].as_str().unwrap_or("").to_string();
            set_sess_status(s, &ses, "idle");
        }).await)
    }

    #[tauri::command]
    pub async fn submit_composer(app: AppHandle, store: State<'_, Arc<Store>>, text: String, _options: Option<serde_json::Value>) -> Result<DesktopState, String> {
        if store.session.lock().await.is_none() {
            store.create_agent_session(&app, "/tmp").await.map_err(|e| format!("{e}"))?;
        }
        store.send_message(&app, &text).await.map_err(|e| e.to_string())?;
        Ok(store.state.lock().await.clone())
    }

    #[tauri::command]
    pub async fn start_thread(app: AppHandle, store: State<'_, Arc<Store>>, input: serde_json::Value) -> Result<DesktopState, String> {
        if store.session.lock().await.is_none() {
            store.create_agent_session(&app, "/tmp").await.map_err(|e| format!("{e}"))?;
        }
        if let Some(p) = input["prompt"].as_str().filter(|p| !p.is_empty()) {
            store.send_message(&app, p).await.map_err(|e| e.to_string())?;
        }
        Ok(store.state.lock().await.clone())
    }

    #[tauri::command]
    pub async fn set_active_view(app: AppHandle, store: State<'_, Arc<Store>>, view: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["activeView"] = json!(view); }).await)
    }

    #[tauri::command]
    pub async fn set_sidebar_collapsed(app: AppHandle, store: State<'_, Arc<Store>>, collapsed: bool) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["sidebarCollapsed"] = json!(collapsed); }).await)
    }

    #[tauri::command]
    pub async fn set_model_settings_scope_mode(app: AppHandle, store: State<'_, Arc<Store>>, mode: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["modelSettingsScopeMode"] = json!(mode); }).await)
    }

    #[tauri::command]
    pub async fn set_default_model(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, provider: String, model_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if s["runtimeByWorkspace"][&workspace_id].is_null() {
                s["runtimeByWorkspace"][&workspace_id] = json!({"settings": {}});
            }
            s["runtimeByWorkspace"][&workspace_id]["settings"]["defaultProvider"] = json!(provider);
            s["runtimeByWorkspace"][&workspace_id]["settings"]["defaultModelId"] = json!(model_id);
        }).await)
    }

    #[tauri::command]
    pub async fn set_session_model(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, session_id: String, provider: String, model_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if let Some(ws) = s["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == workspace_id) {
                if let Some(sess) = ws["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == session_id) {
                    sess["config"] = json!({"provider": provider, "modelId": model_id});
                }
            }
        }).await)
    }

    #[tauri::command]
    pub async fn update_composer_draft(app: AppHandle, store: State<'_, Arc<Store>>, composer_draft: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["composerDraft"] = json!(composer_draft); }).await)
    }

    #[tauri::command]
    pub async fn add_composer_attachments(app: AppHandle, store: State<'_, Arc<Store>>, attachments: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["composerAttachments"] = attachments; }).await)
    }

    #[tauri::command]
    pub async fn remove_composer_attachment(app: AppHandle, store: State<'_, Arc<Store>>, attachment_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if let Some(arr) = s["composerAttachments"].as_array_mut() { arr.retain(|a| a["id"] != attachment_id); }
        }).await)
    }

    #[tauri::command]
    pub async fn edit_queued_composer_message(app: AppHandle, store: State<'_, Arc<Store>>, message_id: String, current_draft: Option<String>) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            s["editingQueuedMessageId"] = json!(message_id);
            if let Some(d) = current_draft { s["composerDraft"] = json!(d); }
        }).await)
    }

    #[tauri::command]
    pub async fn cancel_queued_composer_edit(app: AppHandle, store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["editingQueuedMessageId"] = serde_json::Value::Null; }).await)
    }

    #[tauri::command]
    pub async fn remove_queued_composer_message(app: AppHandle, store: State<'_, Arc<Store>>, message_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if let Some(arr) = s["queuedComposerMessages"].as_array_mut() { arr.retain(|m| m["id"] != message_id); }
        }).await)
    }

    #[tauri::command]
    pub async fn steer_queued_composer_message(app: AppHandle, store: State<'_, Arc<Store>>, message_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if let Some(arr) = s["queuedComposerMessages"].as_array_mut() {
                if let Some(m) = arr.iter_mut().find(|m| m["id"] == message_id) { m["mode"] = json!("steer"); }
            }
        }).await)
    }

    #[tauri::command]
    pub async fn reorder_pinned_sessions(app: AppHandle, store: State<'_, Arc<Store>>, pinned_session_order: Vec<String>) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["pinnedSessionOrder"] = json!(pinned_session_order); }).await)
    }

    #[tauri::command]
    pub async fn set_theme_mode(app: AppHandle, store: State<'_, Arc<Store>>, mode: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["themeMode"] = json!(mode); }).await)
    }

    #[tauri::command]
    pub async fn set_theme_preset_id(app: AppHandle, store: State<'_, Arc<Store>>, preset_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["themePresetId"] = json!(preset_id); }).await)
    }

    #[tauri::command]
    pub async fn set_notification_preferences(app: AppHandle, store: State<'_, Arc<Store>>, preferences: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["notificationPreferences"] = preferences; }).await)
    }

    #[tauri::command]
    pub async fn set_integrated_terminal_shell(app: AppHandle, store: State<'_, Arc<Store>>, shell: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["integratedTerminalShell"] = json!(shell); }).await)
    }

    #[tauri::command]
    pub async fn set_enable_transparency(app: AppHandle, store: State<'_, Arc<Store>>, enabled: bool) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["enableTransparency"] = json!(enabled); }).await)
    }

    #[tauri::command]
    pub async fn toggle_window_maximize() -> Result<(), String> { Ok(()) }

    #[tauri::command]
    pub async fn open_external(url: String) -> Result<(), String> {
        let _ = open::that(&url);
        Ok(())
    }

    #[tauri::command]
    pub async fn get_selected_transcript(store: State<'_, Arc<Store>>) -> Result<Option<serde_json::Value>, String> {
        let messages = store.get_messages().await;
        if messages.is_empty() {
            return Ok(None);
        }
        let ws_id = store.state.lock().await["selectedWorkspaceId"].as_str().unwrap_or("ws-default").to_string();
        let sess_id = store.state.lock().await["selectedSessionId"].as_str().unwrap_or("").to_string();

        let transcript: Vec<serde_json::Value> = messages.iter().map(|msg| {
            let role = match msg {
                AgentMessage::User { .. } => "user",
                AgentMessage::Assistant { .. } => "assistant",
                _ => return None,
            };
            let (content, ts) = match msg {
                AgentMessage::User { content, timestamp } => (content, timestamp),
                AgentMessage::Assistant { content, timestamp, .. } => (content, timestamp),
                _ => return None,
            };
            let text = content.iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text, .. } => Some(text.clone()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("");

            let ts_secs = *ts as f64 / 1000.0;
            let created = chrono::DateTime::from_timestamp(ts_secs as i64, 0)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                .unwrap_or_else(now_iso);

            Some(json!({
                "id": format!("msg-{}", ts),
                "role": role,
                "text": text,
                "createdAt": created,
            }))
        }).filter_map(|m| m).collect();

        if transcript.is_empty() {
            return Ok(None);
        }

        Ok(Some(json!({
            "workspaceId": ws_id,
            "sessionId": sess_id,
            "transcript": transcript,
        })))
    }

    #[tauri::command]
    pub async fn get_runtime_info() -> Result<serde_json::Value, String> {
        Ok(build_runtime_snapshot())
    }

    // ── Stubs (return correct types matching original API) ──

    // Workspace stubs
    #[tauri::command]
    pub async fn pick_workspace(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
        Ok(store.state.lock().await.clone())
    }
    #[tauri::command]
    pub async fn open_workspace_in_finder(workspace_id: String) -> Result<(), String> {
        let _ = workspace_id; Ok(())
    }
    #[tauri::command]
    pub async fn open_skill_in_finder(workspace_id: String, file_path: String) -> Result<(), String> {
        let _ = (workspace_id, file_path); Ok(())
    }
    #[tauri::command]
    pub async fn open_extension_in_finder(workspace_id: String, file_path: String) -> Result<(), String> {
        let _ = (workspace_id, file_path); Ok(())
    }
    stub!(create_worktree, input: serde_json::Value);
    stub!(remove_worktree, input: serde_json::Value);
    stub!(sync_current_workspace);

    // Session stubs
    stub!(fork_thread, input: serde_json::Value);
    stub!(send_child_thread_follow_up, input: serde_json::Value);
    stub!(set_child_supervision_loop, input: serde_json::Value);

    #[tauri::command]
    pub async fn refresh_runtime(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: Option<String>) -> Result<DesktopState, String> {
        let wid = workspace_id.unwrap_or_else(|| "ws-default".into());
        Ok(store.mutate(&app, |s| {
            s["runtimeByWorkspace"][&wid] = build_runtime_snapshot();
        }).await)
    }

    // Model stubs
    #[tauri::command]
    pub async fn set_default_thinking_level(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, thinking_level: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if s["runtimeByWorkspace"][&workspace_id].is_null() {
                s["runtimeByWorkspace"][&workspace_id] = json!({"settings": {}});
            }
            s["runtimeByWorkspace"][&workspace_id]["settings"]["defaultThinkingLevel"] = json!(thinking_level);
        }).await)
    }
    #[tauri::command]
    pub async fn set_session_thinking_level(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, session_id: String, thinking_level: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| {
            if let Some(ws) = s["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == workspace_id) {
                if let Some(sess) = ws["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == session_id) {
                    sess["thinkingLevel"] = json!(thinking_level);
                }
            }
        }).await)
    }
    stub!(login_provider, workspace_id: String, provider_id: String);
    stub!(logout_provider, workspace_id: String, provider_id: String);
    stub!(set_provider_api_key, workspace_id: String, provider_id: String, api_key: String);
    stub!(set_custom_provider, workspace_id: String, config: serde_json::Value);
    stub!(delete_custom_provider, workspace_id: String, provider_id: String);
    stub!(set_enable_skill_commands, workspace_id: String, enabled: bool);
    stub!(set_scoped_model_patterns, workspace_id: String, patterns: Vec<String>);
    stub!(set_skill_enabled, workspace_id: String, file_path: String, enabled: bool);
    stub!(set_extension_enabled, workspace_id: String, file_path: String, enabled: bool);
    stub!(respond_to_host_ui_request, workspace_id: String, session_id: String, response: serde_json::Value);

    #[tauri::command]
    pub async fn list_custom_providers() -> Result<Vec<serde_json::Value>, String> {
        Ok(vec![])
    }
    #[tauri::command]
    pub async fn probe_custom_provider_models(_input: serde_json::Value) -> Result<serde_json::Value, String> {
        Ok(json!({"ok": false, "error": "not available"}))
    }

    // Composer stubs
    stub!(pick_composer_attachments);

    // Notification permission stubs
    #[tauri::command]
    pub async fn get_notification_permission_status() -> Result<String, String> {
        Ok("default".into())
    }
    #[tauri::command]
    pub async fn request_notification_permission() -> Result<String, String> {
        Ok("default".into())
    }
    #[tauri::command]
    pub async fn open_system_notification_settings() -> Result<(), String> {
        Ok(())
    }

    // Session tree stubs
    #[tauri::command]
    pub async fn get_session_tree(_target: serde_json::Value) -> Result<serde_json::Value, String> {
        Ok(json!({"id": "", "label": "root", "children": []}))
    }
    #[tauri::command]
    pub async fn navigate_session_tree(store: State<'_, Arc<Store>>, _target: serde_json::Value, _target_id: String, _options: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        Ok(json!({"state": store.state.lock().await.clone(), "result": {"cancelled": false}}))
    }

    // Workspace files stubs
    #[tauri::command]
    pub async fn list_workspace_files(_workspace_id: String, _options: Option<serde_json::Value>) -> Result<Vec<String>, String> {
        Ok(vec![])
    }
    #[tauri::command]
    pub async fn read_workspace_file(_workspace_id: String, _file_path: String) -> Result<serde_json::Value, String> {
        Ok(json!({"path": "", "content": "", "truncated": false, "binary": false, "sizeBytes": 0}))
    }
    #[tauri::command]
    pub async fn get_changed_files(_workspace_id: String) -> Result<Vec<serde_json::Value>, String> {
        Ok(vec![])
    }
    #[tauri::command]
    pub async fn get_file_diff(_workspace_id: String, _file_path: String) -> Result<String, String> {
        Ok(String::new())
    }
    #[tauri::command]
    pub async fn stage_file(_workspace_id: String, _file_path: String) -> Result<(), String> {
        Ok(())
    }

    // Theme stubs
    #[tauri::command]
    pub async fn get_theme_mode() -> Result<String, String> {
        Ok("system".into())
    }
    #[tauri::command]
    pub async fn get_resolved_theme() -> Result<String, String> {
        Ok("dark".into())
    }

    // ── Terminal stubs (pty not yet integrated) ──
    #[tauri::command]
    pub async fn ensure_terminal_panel(workspace_id: String, terminal_scope_id: String, _size: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        Ok(json!({"workspaceId": workspace_id, "rootKey": terminal_scope_id, "activeSessionId": "", "sessions": []}))
    }
    #[tauri::command]
    pub async fn create_terminal_session(workspace_id: String, terminal_scope_id: String, _size: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        Ok(json!({"workspaceId": workspace_id, "rootKey": terminal_scope_id, "activeSessionId": "", "sessions": []}))
    }
    #[tauri::command]
    pub async fn set_active_terminal_session(workspace_id: String, terminal_scope_id: String, terminal_id: String) -> Result<serde_json::Value, String> {
        Ok(json!({"workspaceId": workspace_id, "rootKey": terminal_scope_id, "activeSessionId": terminal_id, "sessions": []}))
    }
    #[tauri::command]
    pub async fn write_terminal(_terminal_id: String, _data: String) -> Result<(), String> {
        Ok(())
    }
    #[tauri::command]
    pub async fn resize_terminal(_terminal_id: String, _size: serde_json::Value) -> Result<(), String> {
        Ok(())
    }
    #[tauri::command]
    pub async fn restart_terminal_session(terminal_id: String, _size: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        let _ = terminal_id;
        Ok(json!({"workspaceId": "", "rootKey": "default", "activeSessionId": "", "sessions": []}))
    }
    #[tauri::command]
    pub async fn close_terminal_session(_terminal_id: String) -> Result<Option<serde_json::Value>, String> {
        Ok(None)
    }
    #[tauri::command]
    pub async fn set_terminal_title(_terminal_id: String, _title: String) -> Result<(), String> {
        Ok(())
    }
    #[tauri::command]
    pub async fn set_terminal_focused(_focused: bool) -> Result<(), String> {
        Ok(())
    }
}

fn set_sess_field(s: &mut DesktopState, target: &serde_json::Value, field: &str, value: serde_json::Value) {
    let ws_id = target["workspaceId"].as_str().unwrap_or("");
    let sess_id = target["sessionId"].as_str().unwrap_or("");
    if let Some(ws) = s["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == ws_id) {
        if let Some(sess) = ws["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == sess_id) {
            sess[field] = value;
        }
    }
}
