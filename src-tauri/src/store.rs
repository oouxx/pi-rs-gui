use std::sync::atomic::Ordering;
use std::sync::Arc;

use pi_agent_core::pi_ai_types::ContentBlock;
use pi_agent_core::types::AgentMessage;
use serde_json::json;
use tauri::AppHandle;

mod git;
mod terminal;
mod internal;
mod runtime;
mod workspace;
mod session;
mod composer;
mod model;
mod theme;
mod notifications;
mod orchestration;
mod worktree;
mod timeline;
mod providers;
mod persistence;

pub use internal::*;
pub use runtime::build_runtime_snapshot;

use tauri::State;

pub mod cmds {
    use super::*;
    use super::{workspace, session, composer, model, theme, notifications, git, terminal, timeline, providers, persistence};

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

    // ── Core ──

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

    // ── Workspace ──

    #[tauri::command]
    pub async fn add_workspace_path(app: AppHandle, store: State<'_, Arc<Store>>, path: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| workspace::add_workspace(s, &path)).await)
    }

    #[tauri::command]
    pub async fn select_workspace(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| workspace::select_workspace(s, &workspace_id)).await)
    }

    #[tauri::command]
    pub async fn rename_workspace(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, display_name: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| workspace::rename_workspace(s, &workspace_id, &display_name)).await)
    }

    #[tauri::command]
    pub async fn remove_workspace(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| workspace::remove_workspace(s, &workspace_id)).await)
    }

    #[tauri::command]
    pub async fn reorder_workspaces(app: AppHandle, store: State<'_, Arc<Store>>, workspace_order: Vec<String>) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| workspace::reorder_workspaces(s, &workspace_order)).await)
    }

    #[tauri::command]
    pub async fn pick_workspace(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
        Ok(store.state.lock().await.clone())
    }

    #[tauri::command]
    pub async fn open_workspace_in_finder(store: State<'_, Arc<Store>>, workspace_id: String) -> Result<(), String> {
        let state = store.state.lock().await;
        let path = workspace::workspace_path(&state, &workspace_id);
        drop(state);
        if let Some(p) = path { let _ = open::that(&p); }
        Ok(())
    }

    #[tauri::command]
    pub async fn open_skill_in_finder(store: State<'_, Arc<Store>>, workspace_id: String, file_path: String) -> Result<(), String> {
        let state = store.state.lock().await;
        let path = workspace::workspace_path(&state, &workspace_id)
            .map(|base| std::path::Path::new(&base).join(&file_path).to_string_lossy().to_string());
        drop(state);
        if let Some(p) = path { let _ = open::that(&p); }
        Ok(())
    }

    #[tauri::command]
    pub async fn open_extension_in_finder(store: State<'_, Arc<Store>>, workspace_id: String, file_path: String) -> Result<(), String> {
        let state = store.state.lock().await;
        let path = workspace::workspace_path(&state, &workspace_id)
            .map(|base| std::path::Path::new(&base).join(&file_path).to_string_lossy().to_string());
        drop(state);
        if let Some(p) = path { let _ = open::that(&p); }
        Ok(())
    }

    stub!(create_worktree, input: serde_json::Value);
    stub!(remove_worktree, input: serde_json::Value);

    #[tauri::command]
    pub async fn sync_current_workspace(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
        let state = store.state.lock().await.clone();
        persistence::persist_state(&state);
        Ok(state)
    }

    #[tauri::command]
    pub async fn reorder_pinned_sessions(app: AppHandle, store: State<'_, Arc<Store>>, pinned_session_order: Vec<String>) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["pinnedSessionOrder"] = json!(pinned_session_order); }).await)
    }

    // ── Session ──

    #[tauri::command]
    pub async fn select_session(app: AppHandle, store: State<'_, Arc<Store>>, target: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| session::select_session(s, &target)).await)
    }

    #[tauri::command]
    pub async fn archive_session(app: AppHandle, store: State<'_, Arc<Store>>, target: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| session::archive_session(s, &target)).await)
    }

    #[tauri::command]
    pub async fn unarchive_session(app: AppHandle, store: State<'_, Arc<Store>>, target: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| session::unarchive_session(s, &target)).await)
    }

    #[tauri::command]
    pub async fn set_session_pinned(app: AppHandle, store: State<'_, Arc<Store>>, target: serde_json::Value, pinned: bool) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| session::set_session_pinned(s, &target, pinned)).await)
    }

    #[tauri::command]
    pub async fn create_session(app: AppHandle, store: State<'_, Arc<Store>>, input: serde_json::Value) -> Result<DesktopState, String> {
        let ws_id = input["workspaceId"].as_str().unwrap_or("ws-default");
        let title = input["title"].as_str().unwrap_or("New thread");
        Ok(store.mutate(&app, |s| session::create_session(s, ws_id, title)).await)
    }

    #[tauri::command]
    pub async fn cancel_current_run(app: AppHandle, store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
        store.abort().await;
        Ok(store.mutate(&app, |s| {
            let ses = s["selectedSessionId"].as_str().unwrap_or("").to_string();
            session::set_session_status(s, &ses, "idle");
        }).await)
    }

    // ── Agent-session flow ──

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
        let ws_id = input["rootWorkspaceId"].as_str().unwrap_or("ws-default");
        {
            let mut state = store.state.lock().await;
            if let Some(p) = input["provider"].as_str() {
                model::set_default_model(&mut state, ws_id, p, input["modelId"].as_str().unwrap_or(""));
            }
            if let Some(tl) = input["thinkingLevel"].as_str() {
                model::set_default_thinking_level(&mut state, ws_id, tl);
            }
        }
        if store.session.lock().await.is_none() {
            store.create_agent_session(&app, "/tmp").await.map_err(|e| format!("{e}"))?;
        }
        if let Some(p) = input["prompt"].as_str().filter(|p| !p.is_empty()) {
            store.send_message(&app, p).await.map_err(|e| e.to_string())?;
        }
        Ok(store.state.lock().await.clone())
    }

    // ── View ──

    #[tauri::command]
    pub async fn set_active_view(app: AppHandle, store: State<'_, Arc<Store>>, view: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["activeView"] = json!(view); }).await)
    }

    #[tauri::command]
    pub async fn set_sidebar_collapsed(app: AppHandle, store: State<'_, Arc<Store>>, collapsed: bool) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| { s["sidebarCollapsed"] = json!(collapsed); }).await)
    }

    // ── Model ──

    #[tauri::command]
    pub async fn set_model_settings_scope_mode(app: AppHandle, store: State<'_, Arc<Store>>, mode: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| model::set_model_settings_scope(s, &mode)).await)
    }

    #[tauri::command]
    pub async fn set_default_model(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, provider: String, model_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| model::set_default_model(s, &workspace_id, &provider, &model_id)).await)
    }

    #[tauri::command]
    pub async fn set_default_thinking_level(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, thinking_level: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| model::set_default_thinking_level(s, &workspace_id, &thinking_level)).await)
    }

    #[tauri::command]
    pub async fn set_session_model(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, session_id: String, provider: String, model_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| model::set_session_model(s, &workspace_id, &session_id, &provider, &model_id)).await)
    }

    #[tauri::command]
    pub async fn set_session_thinking_level(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: String, session_id: String, thinking_level: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| model::set_session_thinking_level(s, &workspace_id, &session_id, &thinking_level)).await)
    }

    // ── Providers ──

    stub!(login_provider, workspace_id: String, provider_id: String);
    stub!(logout_provider, workspace_id: String, provider_id: String);

    #[tauri::command]
    pub async fn set_provider_api_key(store: State<'_, Arc<Store>>, _workspace_id: String, provider_id: String, api_key: String) -> Result<DesktopState, String> {
        if let Some(var_name) = pi_ai::env_api_keys::get_env_var_name(&provider_id) {
            std::env::set_var(var_name, &api_key);
        }
        Ok(store.state.lock().await.clone())
    }

    stub!(set_custom_provider, workspace_id: String, config: serde_json::Value);
    stub!(delete_custom_provider, workspace_id: String, provider_id: String);
    stub!(set_enable_skill_commands, workspace_id: String, enabled: bool);
    stub!(set_scoped_model_patterns, workspace_id: String, patterns: Vec<String>);
    stub!(set_skill_enabled, workspace_id: String, file_path: String, enabled: bool);
    stub!(set_extension_enabled, workspace_id: String, file_path: String, enabled: bool);
    stub!(respond_to_host_ui_request, workspace_id: String, session_id: String, response: serde_json::Value);

    #[tauri::command]
    pub async fn list_custom_providers() -> Result<Vec<serde_json::Value>, String> {
        Ok(providers::list_custom_providers())
    }

    #[tauri::command]
    pub async fn probe_custom_provider_models(_input: serde_json::Value) -> Result<serde_json::Value, String> {
        Ok(providers::probe_custom_provider_models())
    }

    // ── Orchestration ──
    stub!(fork_thread, input: serde_json::Value);
    stub!(send_child_thread_follow_up, input: serde_json::Value);
    stub!(set_child_supervision_loop, input: serde_json::Value);

    // ── Runtime ──
    #[tauri::command]
    pub async fn refresh_runtime(app: AppHandle, store: State<'_, Arc<Store>>, workspace_id: Option<String>) -> Result<DesktopState, String> {
        let wid = workspace_id.unwrap_or_else(|| "ws-default".into());
        Ok(store.mutate(&app, |s| { s["runtimeByWorkspace"][&wid] = build_runtime_snapshot(); }).await)
    }

    #[tauri::command]
    pub async fn get_runtime_info() -> Result<serde_json::Value, String> {
        Ok(build_runtime_snapshot())
    }

    // ── Composer ──

    #[tauri::command]
    pub async fn update_composer_draft(app: AppHandle, store: State<'_, Arc<Store>>, composer_draft: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| composer::update_composer_draft(s, &composer_draft)).await)
    }

    #[tauri::command]
    pub async fn add_composer_attachments(app: AppHandle, store: State<'_, Arc<Store>>, attachments: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| composer::set_composer_attachments(s, attachments)).await)
    }

    #[tauri::command]
    pub async fn remove_composer_attachment(app: AppHandle, store: State<'_, Arc<Store>>, attachment_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| composer::remove_composer_attachment(s, &attachment_id)).await)
    }

    #[tauri::command]
    pub async fn edit_queued_composer_message(app: AppHandle, store: State<'_, Arc<Store>>, message_id: String, current_draft: Option<String>) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| composer::edit_queued_message(s, &message_id, current_draft.as_deref())).await)
    }

    #[tauri::command]
    pub async fn cancel_queued_composer_edit(app: AppHandle, store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| composer::cancel_queued_edit(s)).await)
    }

    #[tauri::command]
    pub async fn remove_queued_composer_message(app: AppHandle, store: State<'_, Arc<Store>>, message_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| composer::remove_queued_message(s, &message_id)).await)
    }

    #[tauri::command]
    pub async fn steer_queued_composer_message(app: AppHandle, store: State<'_, Arc<Store>>, message_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| composer::steer_queued_message(s, &message_id)).await)
    }

    stub!(pick_composer_attachments);

    // ── Theme ──

    #[tauri::command]
    pub async fn set_theme_mode(app: AppHandle, store: State<'_, Arc<Store>>, mode: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| theme::set_theme_mode(s, &mode)).await)
    }

    #[tauri::command]
    pub async fn set_theme_preset_id(app: AppHandle, store: State<'_, Arc<Store>>, preset_id: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| theme::set_theme_preset(s, &preset_id)).await)
    }

    #[tauri::command]
    pub async fn get_theme_mode() -> Result<String, String> { Ok("system".into()) }

    #[tauri::command]
    pub async fn get_resolved_theme() -> Result<String, String> { Ok("dark".into()) }

    // ── Notifications ──

    #[tauri::command]
    pub async fn set_notification_preferences(app: AppHandle, store: State<'_, Arc<Store>>, preferences: serde_json::Value) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| notifications::set_notification_preferences(s, preferences)).await)
    }

    #[tauri::command]
    pub async fn set_integrated_terminal_shell(app: AppHandle, store: State<'_, Arc<Store>>, shell: String) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| notifications::set_integrated_terminal_shell(s, &shell)).await)
    }

    #[tauri::command]
    pub async fn set_enable_transparency(app: AppHandle, store: State<'_, Arc<Store>>, enabled: bool) -> Result<DesktopState, String> {
        Ok(store.mutate(&app, |s| notifications::set_enable_transparency(s, enabled)).await)
    }

    #[tauri::command]
    pub async fn get_notification_permission_status() -> Result<String, String> { Ok("default".into()) }

    #[tauri::command]
    pub async fn request_notification_permission() -> Result<String, String> { Ok("default".into()) }

    #[tauri::command]
    pub async fn open_system_notification_settings() -> Result<(), String> { Ok(()) }

    // ── Timeline / Session tree ──

    #[tauri::command]
    pub async fn get_session_tree(_target: serde_json::Value) -> Result<serde_json::Value, String> {
        Ok(timeline::stub_session_tree())
    }

    #[tauri::command]
    pub async fn navigate_session_tree(store: State<'_, Arc<Store>>, _target: serde_json::Value, _target_id: String, _options: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        let state = store.state.lock().await;
        Ok(timeline::stub_navigate_result(&state))
    }

    // ── Transcript ──

    #[tauri::command]
    pub async fn get_selected_transcript(store: State<'_, Arc<Store>>) -> Result<Option<serde_json::Value>, String> {
        let messages = store.get_messages().await;
        if messages.is_empty() { return Ok(None); }
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
                .filter_map(|block| match block { ContentBlock::Text { text, .. } => Some(text.clone()), _ => None })
                .collect::<Vec<_>>().join("");
            let ts_secs = *ts as f64 / 1000.0;
            let created = chrono::DateTime::from_timestamp(ts_secs as i64, 0)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)).unwrap_or_else(now_iso);
            Some(json!({"id": format!("msg-{}", ts), "role": role, "text": text, "createdAt": created}))
        }).filter_map(|m| m).collect();
        if transcript.is_empty() { return Ok(None); }
        Ok(Some(json!({"workspaceId": ws_id, "sessionId": sess_id, "transcript": transcript})))
    }

    // ── Workspace files (git) ──

    #[tauri::command]
    pub async fn list_workspace_files(store: State<'_, Arc<Store>>, workspace_id: String, _options: Option<serde_json::Value>) -> Result<Vec<String>, String> {
        let state = store.state.lock().await;
        let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
        drop(state);
        git::list_workspace_files(&path)
    }

    #[tauri::command]
    pub async fn read_workspace_file(store: State<'_, Arc<Store>>, workspace_id: String, file_path: String) -> Result<serde_json::Value, String> {
        let state = store.state.lock().await;
        let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
        drop(state);
        git::read_workspace_file(&path, &file_path)
    }

    #[tauri::command]
    pub async fn get_changed_files(store: State<'_, Arc<Store>>, workspace_id: String) -> Result<Vec<serde_json::Value>, String> {
        let state = store.state.lock().await;
        let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
        drop(state);
        git::get_changed_files(&path)
    }

    #[tauri::command]
    pub async fn get_file_diff(store: State<'_, Arc<Store>>, workspace_id: String, file_path: String) -> Result<String, String> {
        let state = store.state.lock().await;
        let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
        drop(state);
        git::get_file_diff(&path, &file_path)
    }

    #[tauri::command]
    pub async fn stage_file(store: State<'_, Arc<Store>>, workspace_id: String, file_path: String) -> Result<(), String> {
        let state = store.state.lock().await;
        let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
        drop(state);
        git::stage_file(&path, &file_path)
    }

    // ── Window ──

    #[tauri::command]
    pub async fn toggle_window_maximize() -> Result<(), String> { Ok(()) }

    #[tauri::command]
    pub async fn open_external(url: String) -> Result<(), String> {
        let _ = open::that(&url);
        Ok(())
    }

    // ── Terminal ──

    #[tauri::command]
    pub async fn ensure_terminal_panel(workspace_id: String, terminal_scope_id: String, _size: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        Ok(terminal::stub_terminal_panel(&workspace_id, &terminal_scope_id))
    }
    #[tauri::command]
    pub async fn create_terminal_session(workspace_id: String, terminal_scope_id: String, _size: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        Ok(terminal::stub_terminal_panel(&workspace_id, &terminal_scope_id))
    }
    #[tauri::command]
    pub async fn set_active_terminal_session(workspace_id: String, terminal_scope_id: String, terminal_id: String) -> Result<serde_json::Value, String> {
        let mut p = terminal::stub_terminal_panel(&workspace_id, &terminal_scope_id);
        p["activeSessionId"] = json!(terminal_id);
        Ok(p)
    }
    #[tauri::command]
    pub async fn write_terminal(_terminal_id: String, _data: String) -> Result<(), String> { Ok(()) }
    #[tauri::command]
    pub async fn resize_terminal(_terminal_id: String, _size: serde_json::Value) -> Result<(), String> { Ok(()) }
    #[tauri::command]
    pub async fn restart_terminal_session(_terminal_id: String, _size: Option<serde_json::Value>) -> Result<serde_json::Value, String> {
        Ok(terminal::stub_terminal_panel("", "default"))
    }
    #[tauri::command]
    pub async fn close_terminal_session(_terminal_id: String) -> Result<Option<serde_json::Value>, String> { Ok(None) }
    #[tauri::command]
    pub async fn set_terminal_title(_terminal_id: String, _title: String) -> Result<(), String> { Ok(()) }
    #[tauri::command]
    pub async fn set_terminal_focused(_focused: bool) -> Result<(), String> { Ok(()) }
}

// ── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_initial_state() {
        let store = Store::new();
        let state = store.state.lock().await;
        assert_eq!(state["revision"], 1);
        assert_eq!(state["selectedWorkspaceId"], "ws-default");
        assert_eq!(state["activeView"], "threads");
        assert_eq!(state["globalModelSettings"]["enabledModelPatterns"].as_array().unwrap().len(), 0);
        assert!(state["runtimeByWorkspace"].as_object().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_default_model_on_new_workspace() {
        let store = Store::new();
        let ws_id = "ws-new".to_string();
        let mut state = store.state.lock().await;
        if state["runtimeByWorkspace"][&ws_id].is_null() {
            state["runtimeByWorkspace"][&ws_id] = json!({"settings": {}});
        }
        state["runtimeByWorkspace"][&ws_id]["settings"]["defaultProvider"] = json!("openrouter");
        state["runtimeByWorkspace"][&ws_id]["settings"]["defaultModelId"] = json!("free");
        drop(state);
        let state = store.state.lock().await;
        assert_eq!(state["runtimeByWorkspace"]["ws-new"]["settings"]["defaultProvider"], "openrouter");
        assert_eq!(state["runtimeByWorkspace"]["ws-new"]["settings"]["defaultModelId"], "free");
    }

    #[tokio::test]
    #[ignore = "Requires OPENROUTER_API_KEY"]
    async fn test_conversation_with_openrouter_free() {
        let key = std::env::var("OPENROUTER_API_KEY").expect("Set OPENROUTER_API_KEY env var");
        pi_ai::providers::register_builtins::register_built_in_api_providers();
        let model = pi_agent_core::pi_ai_types::Model {
            id: "free".into(), name: "OpenRouter Free".into(), api: "openai-completions".into(),
            provider: "openrouter".into(), base_url: "https://openrouter.ai/api/v1".into(),
            reasoning: false, thinking_level_map: None, input: vec!["text".into()],
            cost: pi_agent_core::pi_ai_types::ModelCost { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
            context_window: 100_000, max_tokens: 1_000, headers: None,
            compat: Some(pi_agent_core::pi_ai_types::ModelCompat::OpenAICompletions(
                pi_agent_core::pi_ai_types::OpenAICompletionsCompat {
                    supports_store: None, supports_developer_role: None, supports_reasoning_effort: None,
                    supports_usage_in_streaming: None, max_tokens_field: None, requires_tool_result_name: None,
                    requires_assistant_after_tool_result: None, requires_thinking_as_text: None,
                    requires_reasoning_content_on_assistant_messages: None, thinking_format: None,
                    open_router_routing: None, vercel_gateway_routing: None, zai_tool_stream: None,
                    supports_strict_mode: None, cache_control_format: None, send_session_affinity_headers: None,
                    supports_long_cache_retention: None,
                },
            )),
        };
        std::env::set_var("OPENROUTER_API_KEY", &key);
        let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| "/tmp".into());
        let agent_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(".pi-rs-test-agent-openrouter");
        std::fs::create_dir_all(&agent_dir).ok();
        let options = pi_coding_agent::core::sdk::CreateAgentSessionOptions {
            cwd, agent_dir: Some(agent_dir.to_string_lossy().to_string()),
            model: Some(model), thinking_level: Some("normal".into()),
            scoped_models: None, no_tools: None, tools: None, exclude_tools: None,
            custom_prompt: Some("You are a helpful assistant. Keep responses very brief.".into()),
            append_system_prompt: None, session_name: Some("test-openrouter".into()),
            stream_fn: None, convert_to_llm: None, extension_paths: vec![], enable_extensions: false,
        };
        let (mut session, _result) = pi_coding_agent::core::sdk::create_agent_session(options).await.expect("create_agent_session failed");
        let response_text = Arc::new(tokio::sync::Mutex::new(String::new()));
        let rt = response_text.clone();
        use pi_agent_core::pi_ai_types::AssistantMessageEvent;
        use pi_agent_core::types::AgentEvent;
        let listener: Arc<dyn Fn(AgentEvent, Option<tokio::sync::watch::Receiver<bool>>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync> = Arc::new(move |event: AgentEvent, _signal| {
            let rt = rt.clone();
            Box::pin(async move {
                match &event {
                    AgentEvent::MessageUpdate { assistant_message_event, .. } => {
                        if let AssistantMessageEvent::TextDelta { delta, .. } = assistant_message_event { rt.lock().await.push_str(delta); }
                    }
                    AgentEvent::MessageEnd { message: msg } => {
                        if let pi_agent_core::types::AgentMessage::Assistant { content, .. } = msg {
                            let t: String = content.iter().filter_map(|b| if let pi_agent_core::pi_ai_types::ContentBlock::Text { text, .. } = b { Some(text.clone()) } else { None }).collect();
                            if !t.is_empty() { rt.lock().await.push_str(&t); }
                        }
                    }
                    _ => {}
                }
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        });
        session.subscribe(listener).await;
        session.add_user_text("Say 'hello' in one word.").await;
        session.wait_for_idle().await;
        let turn1 = response_text.lock().await.clone();
        eprintln!("[test] Turn1: '{turn1}'"); assert!(!turn1.is_empty(), "Turn 1 empty");
        response_text.lock().await.clear();
        session.add_user_text("Now say 'goodbye' in one word.").await;
        session.wait_for_idle().await;
        let turn2 = response_text.lock().await.clone();
        eprintln!("[test] Turn2: '{turn2}'"); assert!(!turn2.is_empty(), "Turn 2 empty");
        response_text.lock().await.clear();
        session.add_user_text("What was the first word I asked you to say?").await;
        session.wait_for_idle().await;
        let turn3 = response_text.lock().await.clone();
        eprintln!("[test] Turn3: '{turn3}'"); assert!(!turn3.is_empty(), "Turn 3 empty");
        assert!(turn3.to_lowercase().contains("hello"), "Turn 3 should refer to 'hello'");
        let messages = session.get_messages().await;
        eprintln!("[test] Total messages: {}", messages.len());
        assert!(messages.len() >= 6, "Expected ≥6 messages");
    }
}
