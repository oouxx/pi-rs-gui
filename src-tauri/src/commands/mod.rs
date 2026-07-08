use crate::state::*;
use crate::state::{
    composer, extensions, git, model, persistence, providers, session, skills,
    theme, timeline, workspace,
};
use pi_agent_core::pi_ai_types::ContentBlock;
use pi_agent_core::types::AgentMessage;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use tauri::{AppHandle, State};

fn cwd_fallback(path: Option<String>) -> String {
    path.or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().to_string())
    })
    .unwrap_or_else(|| {
        std::env::var("HOME")
            .map(|h| format!("{}/.pi-rs", h))
            .unwrap_or_else(|_| "/tmp".into())
    })
}

// ── Core ──

#[tauri::command]
pub async fn ping() -> String {
    eprintln!("[IPC →] ping");
    "pong".into()
}

#[tauri::command]
pub async fn get_state(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
    let state = store.state.lock().await.clone();
    Ok(state)
}

#[tauri::command]
pub async fn create_agent_session_cmd(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    cwd: String,
) -> Result<String, String> {
    store.create_agent_session(&app, &cwd, None).await
}

#[tauri::command]
pub async fn send_message_cmd(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    text: String,
) -> Result<(), String> {
    store.send_message(&app, &text).await
}

#[tauri::command]
pub async fn abort_cmd(store: State<'_, Arc<Store>>) -> Result<(), String> {
    store.abort().await;
    Ok(())
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
pub async fn add_workspace_path(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    path: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| workspace::add_workspace(s, &path))
        .await)
}

#[tauri::command]
pub async fn select_workspace(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| workspace::select_workspace(s, &workspace_id))
        .await)
}

#[tauri::command]
pub async fn rename_workspace(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    display_name: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            workspace::rename_workspace(s, &workspace_id, &display_name)
        })
        .await)
}

#[tauri::command]
pub async fn remove_workspace(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| workspace::remove_workspace(s, &workspace_id))
        .await)
}

#[tauri::command]
pub async fn reorder_workspaces(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_order: Vec<String>,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| workspace::reorder_workspaces(s, &workspace_order))
        .await)
}

#[tauri::command]
pub async fn pick_workspace(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
    Ok(store.state.lock().await.clone())
}

#[tauri::command]
pub async fn open_workspace_in_finder(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<(), String> {
    let state = store.state.lock().await;
    let path = workspace::workspace_path(&state, &workspace_id);
    drop(state);
    if let Some(p) = path {
        let _ = open::that(&p);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_skill_in_finder(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    file_path: String,
) -> Result<(), String> {
    let state = store.state.lock().await;
    let path = workspace::workspace_path(&state, &workspace_id).map(|base| {
        std::path::Path::new(&base)
            .join(&file_path)
            .to_string_lossy()
            .to_string()
    });
    drop(state);
    if let Some(p) = path {
        let _ = open::that(&p);
    }
    Ok(())
}

#[tauri::command]
pub async fn open_extension_in_finder(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    file_path: String,
) -> Result<(), String> {
    let state = store.state.lock().await;
    let path = workspace::workspace_path(&state, &workspace_id).map(|base| {
        std::path::Path::new(&base)
            .join(&file_path)
            .to_string_lossy()
            .to_string()
    });
    drop(state);
    if let Some(p) = path {
        let _ = open::that(&p);
    }
    Ok(())
}

#[tauri::command]
pub async fn sync_current_workspace(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
    let state = store.state.lock().await.clone();
    persistence::persist_state(&state);
    Ok(state)
}

#[tauri::command]
pub async fn reorder_pinned_sessions(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    pinned_session_order: Vec<String>,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["pinnedSessionOrder"] = json!(pinned_session_order);
        })
        .await)
}

// ── Session ──

#[tauri::command]
pub async fn select_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    target: serde_json::Value,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| session::select_session(s, &target))
        .await)
}

#[tauri::command]
pub async fn archive_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    target: serde_json::Value,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| session::archive_session(s, &target))
        .await)
}

#[tauri::command]
pub async fn unarchive_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    target: serde_json::Value,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| session::unarchive_session(s, &target))
        .await)
}

#[tauri::command]
pub async fn set_session_pinned(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    target: serde_json::Value,
    pinned: bool,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| session::set_session_pinned(s, &target, pinned))
        .await)
}

#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    input: serde_json::Value,
) -> Result<DesktopState, String> {
    let ws_id = input["workspaceId"].as_str().unwrap_or("ws-default");
    let title = input["title"].as_str().unwrap_or("New thread");
    Ok(store
        .mutate(&app, |s| session::create_session(s, ws_id, title))
        .await)
}

#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    target: serde_json::Value,
    title: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| session::rename_session(s, &target, &title))
        .await)
}

#[tauri::command]
pub async fn cancel_current_run(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<DesktopState, String> {
    store.abort().await;
    Ok(store
        .mutate(&app, |s| {
            let ses = s["selectedSessionId"].as_str().unwrap_or("").to_string();
            session::set_session_status(s, &ses, "idle");
        })
        .await)
}

// ── Agent-session flow ──

#[tauri::command]
pub async fn submit_composer(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    text: String,
    _options: Option<serde_json::Value>,
) -> Result<DesktopState, String> {
    if store.session.lock().await.is_none() {
        eprintln!("[LLM] no session, creating one");
        let state = store.state.lock().await;
        let sid = state["selectedSessionId"].as_str().unwrap_or("");
        let ws_id = state["selectedWorkspaceId"]
            .as_str()
            .unwrap_or("ws-default");
        let cwd = cwd_fallback(workspace::workspace_path(&state, ws_id).or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        }));
        // Look up sessionFile for an existing (restored) session
        let session_file: Option<String> = state["workspaces"]
            .as_array()
            .and_then(|ws| ws.iter().find(|w| w["id"] == ws_id))
            .and_then(|w| w["sessions"].as_array())
            .and_then(|ss| ss.iter().find(|s| s["id"] == sid))
            .and_then(|s| s["sessionFile"].as_str().filter(|f| !f.is_empty()))
            .map(String::from);
        drop(state);
        store
            .create_agent_session(&app, &cwd, session_file)
            .await
            .map_err(|e| format!("{e}"))?;
    }
    eprintln!("[LLM] sending message...");
    store
        .send_message(&app, &text)
        .await
        .map_err(|e| e.to_string())?;
    eprintln!("[LLM] send_message returned OK");
    Ok(store.state.lock().await.clone())
}

#[tauri::command]
pub async fn start_thread(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    input: serde_json::Value,
) -> Result<DesktopState, String> {
    let ws_id = input["rootWorkspaceId"].as_str().unwrap_or("ws-default");
    {
        let mut state = store.state.lock().await;
        if let Some(p) = input["provider"].as_str() {
            model::set_default_model(
                &mut state,
                ws_id,
                p,
                input["modelId"].as_str().unwrap_or(""),
            );
        }
        if let Some(tl) = input["thinkingLevel"].as_str() {
            model::set_default_thinking_level(&mut state, ws_id, tl);
        }
    }
    if store.session.lock().await.is_none() {
        let state = store.state.lock().await;
        let sid = state["selectedSessionId"].as_str().unwrap_or("");
        let cwd = cwd_fallback(workspace::workspace_path(&state, ws_id).or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        }));
        let session_file: Option<String> = state["workspaces"]
            .as_array()
            .and_then(|ws| ws.iter().find(|w| w["id"] == ws_id))
            .and_then(|w| w["sessions"].as_array())
            .and_then(|ss| ss.iter().find(|s| s["id"] == sid))
            .and_then(|s| s["sessionFile"].as_str().filter(|f| !f.is_empty()))
            .map(String::from);
        drop(state);
        store
            .create_agent_session(&app, &cwd, session_file)
            .await
            .map_err(|e| format!("{e}"))?;
    }
    if let Some(p) = input["prompt"].as_str().filter(|p| !p.is_empty()) {
        store
            .send_message(&app, p)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(store.state.lock().await.clone())
}

// ── View ──

#[tauri::command]
pub async fn set_active_view(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    view: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["activeView"] = json!(view);
        })
        .await)
}

#[tauri::command]
pub async fn set_sidebar_collapsed(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    collapsed: bool,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["sidebarCollapsed"] = json!(collapsed);
        })
        .await)
}

// ── Model ──

#[tauri::command]
pub async fn set_model_settings_scope_mode(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    mode: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| model::set_model_settings_scope(s, &mode))
        .await)
}

#[tauri::command]
pub async fn set_default_model(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    provider: String,
    model_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            model::set_default_model(s, &workspace_id, &provider, &model_id)
        })
        .await)
}

#[tauri::command]
pub async fn set_default_thinking_level(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    thinking_level: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            model::set_default_thinking_level(s, &workspace_id, &thinking_level)
        })
        .await)
}

#[tauri::command]
pub async fn set_session_model(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    session_id: String,
    provider: String,
    model_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            model::set_session_model(s, &workspace_id, &session_id, &provider, &model_id)
        })
        .await)
}

#[tauri::command]
pub async fn set_session_thinking_level(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    session_id: String,
    thinking_level: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            model::set_session_thinking_level(s, &workspace_id, &session_id, &thinking_level)
        })
        .await)
}

#[tauri::command]
pub async fn set_enable_skill_commands(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    enabled: bool,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["runtimeByWorkspace"][&workspace_id]["skillCommandsEnabled"] = json!(enabled);
        })
        .await)
}
#[tauri::command]
pub async fn set_scoped_model_patterns(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    patterns: Vec<String>,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["runtimeByWorkspace"][&workspace_id]["scopedModelPatterns"] = json!(patterns);
        })
        .await)
}
#[tauri::command]
pub async fn set_skill_enabled(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    _workspace_id: String,
    file_path: String,
    enabled: bool,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["skills"] = json!({"filePath": file_path, "enabled": enabled});
        })
        .await)
}
#[tauri::command]
pub async fn set_extension_enabled(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    _workspace_id: String,
    file_path: String,
    enabled: bool,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["extensions"] = json!({"filePath": file_path, "enabled": enabled});
        })
        .await)
}
#[tauri::command]
pub async fn respond_to_host_ui_request(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    session_id: String,
    response: serde_json::Value,
) -> Result<DesktopState, String> {
    // Store the host UI response — will be consumed by the session driver
    Ok(store
        .mutate(&app, |s| {
            s["pendingHostUiResponses"] =
                json!({"workspaceId": workspace_id, "sessionId": session_id, "response": response});
        })
        .await)
}

// ── Orchestration ──
#[tauri::command]
pub async fn fork_thread(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    input: serde_json::Value,
) -> Result<DesktopState, String> {
    let _ws_id = input["rootWorkspaceId"].as_str().unwrap_or("ws-default");
    let parent_sid = input["parentSessionId"].as_str().unwrap_or("");
    let new_sid = format!("sess-fork-{}", chrono::Utc::now().timestamp_millis());
    Ok(store
        .mutate(&app, |s| {
            let fork = json!({
                "id": new_sid,
                "parentId": parent_sid,
                "title": input["title"].as_str().unwrap_or("Fork"),
                "updatedAt": crate::state::internal::now_iso(),
                "status": "idle",
            });
            if let Some(arr) = s["orchestrationChildren"].as_array_mut() {
                arr.push(fork);
            } else {
                s["orchestrationChildren"] = json!([fork]);
            }
            s["selectedSessionId"] = json!(new_sid);
        })
        .await)
}
#[tauri::command]
pub async fn send_child_thread_follow_up(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    _input: serde_json::Value,
) -> Result<DesktopState, String> {
    // Stub: accept and store the follow-up message for later processing
    Ok(store.mutate(&app, |_s| {}).await)
}
#[tauri::command]
pub async fn set_child_supervision_loop(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    input: serde_json::Value,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["supervisionLoop"] = json!(input);
        })
        .await)
}

// ── Runtime ──
#[tauri::command]
pub async fn refresh_runtime(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: Option<String>,
) -> Result<DesktopState, String> {
    let wid = workspace_id.unwrap_or_else(|| "ws-default".into());
    Ok(store
        .mutate(&app, |s| {
            s["runtimeByWorkspace"][&wid] = build_runtime_snapshot();
        })
        .await)
}

#[tauri::command]
pub async fn get_runtime_info() -> Result<serde_json::Value, String> {
    Ok(build_runtime_snapshot())
}

// ── Composer ──

#[tauri::command]
pub async fn update_composer_draft(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    composer_draft: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            composer::update_composer_draft(s, &composer_draft)
        })
        .await)
}

#[tauri::command]
pub async fn add_composer_attachments(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    attachments: serde_json::Value,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| composer::set_composer_attachments(s, attachments))
        .await)
}

#[tauri::command]
pub async fn remove_composer_attachment(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    attachment_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            composer::remove_composer_attachment(s, &attachment_id)
        })
        .await)
}

#[tauri::command]
pub async fn edit_queued_composer_message(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    message_id: String,
    current_draft: Option<String>,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            composer::edit_queued_message(s, &message_id, current_draft.as_deref())
        })
        .await)
}

#[tauri::command]
pub async fn cancel_queued_composer_edit(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| composer::cancel_queued_edit(s))
        .await)
}

#[tauri::command]
pub async fn remove_queued_composer_message(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    message_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| composer::remove_queued_message(s, &message_id))
        .await)
}

#[tauri::command]
pub async fn steer_queued_composer_message(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    message_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| composer::steer_queued_message(s, &message_id))
        .await)
}

#[tauri::command]
pub async fn pick_composer_attachments(
    _app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<DesktopState, String> {
    // Return current state with attachments as-is (frontend handles file picker dialog)
    Ok(store.state.lock().await.clone())
}

// ── Theme ──

#[tauri::command]
pub async fn set_theme_mode(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    mode: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| theme::set_theme_mode(s, &mode))
        .await)
}

#[tauri::command]
pub async fn set_theme_preset_id(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    preset_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| theme::set_theme_preset(s, &preset_id))
        .await)
}

#[tauri::command]
pub async fn get_theme_mode() -> Result<String, String> {
    Ok("system".into())
}

#[tauri::command]
pub async fn get_resolved_theme() -> Result<String, String> {
    Ok("dark".into())
}

// ── Notifications ──

#[tauri::command]
pub async fn set_notification_preferences(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    preferences: serde_json::Value,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| { s["notificationPreferences"] = preferences; }).await)
}

#[tauri::command]
pub async fn set_integrated_terminal_shell(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    shell: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| { s["integratedTerminalShell"] = json!(shell); }).await)
}

#[tauri::command]
pub async fn set_enable_transparency(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    enabled: bool,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| { s["enableTransparency"] = json!(enabled); }).await)
}

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

// ── Timeline / Session tree ──

#[tauri::command]
pub async fn get_session_tree(
    store: State<'_, Arc<Store>>,
    target: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let sid = target["sessionId"]
        .as_str()
        .or_else(|| state["selectedSessionId"].as_str())
        .unwrap_or("")
        .to_string();
    drop(state);
    let msgs = store.get_messages().await;
    Ok(timeline::build_session_tree(&sid, &msgs))
}

#[tauri::command]
pub async fn navigate_session_tree(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    target: serde_json::Value,
    _target_id: String,
    _options: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let new_state = store
        .mutate(&app, |s| {
            if let Some(sid) = target["sessionId"].as_str() {
                s["selectedSessionId"] = json!(sid);
            }
        })
        .await;
    Ok(json!({"state": new_state, "result": {"cancelled": false}}))
}

// ── Transcript ──

#[tauri::command]
pub async fn get_selected_transcript(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<Option<serde_json::Value>, String> {
    // If no active session but the selected session has a sessionFile, auto-load it
    if store.session.lock().await.is_none() {
        let state = store.state.lock().await;
        let sid = state["selectedSessionId"].as_str().unwrap_or("");
        let ws_id = state["selectedWorkspaceId"]
            .as_str()
            .unwrap_or("ws-default");
        let session_file: Option<String> = state["workspaces"]
            .as_array()
            .and_then(|ws| ws.iter().find(|w| w["id"] == ws_id))
            .and_then(|w| w["sessions"].as_array())
            .and_then(|ss| ss.iter().find(|s| s["id"] == sid))
            .and_then(|s| s["sessionFile"].as_str().filter(|f| !f.is_empty()))
            .map(String::from);
        let cwd = cwd_fallback(workspace::workspace_path(&state, ws_id).or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|p| p.to_string_lossy().to_string())
        }));
        drop(state);
        if let Some(sf) = session_file {
            eprintln!("[LLM] auto-loading session from: {sf}");
            let _ = store.create_agent_session(&app, &cwd, Some(sf)).await;
        }
    }
    let messages = store.get_messages().await;
    if messages.is_empty() {
        return Ok(None);
    }
    let ws_id = store.state.lock().await["selectedWorkspaceId"]
        .as_str()
        .unwrap_or("ws-default")
        .to_string();
    let sess_id = store.state.lock().await["selectedSessionId"]
        .as_str()
        .unwrap_or("")
        .to_string();
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
            Some(json!({"id": format!("msg-{}", ts), "kind": "message", "role": role, "text": text, "createdAt": created}))
        }).filter_map(|m| m).collect();
    if transcript.is_empty() {
        eprintln!("[IPC ←] get_selected_transcript: empty");
        return Ok(None);
    }
    let result = json!({"workspaceId": ws_id, "sessionId": sess_id, "transcript": transcript});
    let state2 = store.state.lock().await;
    drop(state2);
    Ok(Some(result))
}

// ── Workspace files (git) ──

#[tauri::command]
pub async fn list_workspace_files(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    _options: Option<serde_json::Value>,
) -> Result<Vec<String>, String> {
    let state = store.state.lock().await;
    let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
    drop(state);
    git::list_workspace_files(&path)
}

#[tauri::command]
pub async fn read_workspace_file(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    file_path: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
    drop(state);
    git::read_workspace_file(&path, &file_path)
}

#[tauri::command]
pub async fn get_changed_files(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let state = store.state.lock().await;
    let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
    drop(state);
    git::get_changed_files(&path)
}

#[tauri::command]
pub async fn get_file_diff(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    file_path: String,
) -> Result<String, String> {
    let state = store.state.lock().await;
    let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
    drop(state);
    git::get_file_diff(&path, &file_path)
}

#[tauri::command]
pub async fn stage_file(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    file_path: String,
) -> Result<(), String> {
    let state = store.state.lock().await;
    let path = workspace::workspace_path(&state, &workspace_id).ok_or("unknown workspace")?;
    drop(state);
    git::stage_file(&path, &file_path)
}

// ── Window ──

#[tauri::command]
pub async fn toggle_window_maximize() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub async fn open_external(url: String) -> Result<(), String> {
    let _ = open::that(&url);
    Ok(())
}

// ── Model CRUD ──

#[tauri::command]
pub async fn get_default_model(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    Ok(model::get_default_model(&state, &workspace_id))
}

#[tauri::command]
pub async fn get_models(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let snapshot = state["runtimeByWorkspace"][&workspace_id].clone();
    let models = snapshot["models"].as_array().cloned().unwrap_or_default();
    Ok(json!({"models": models}))
}

#[tauri::command]
pub async fn get_providers(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let snapshot = state["runtimeByWorkspace"][&workspace_id].clone();
    let providers_list = snapshot["providers"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    Ok(json!({"providers": providers_list}))
}

#[tauri::command]
pub async fn get_model_settings(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let settings = state["runtimeByWorkspace"][&workspace_id]["settings"].clone();
    let global = state["globalModelSettings"].clone();
    Ok(json!({"settings": settings, "globalModelSettings": global}))
}

// ── Providers CRUD ──

#[tauri::command]
pub async fn login_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    _provider_id: String,
) -> Result<DesktopState, String> {
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    Ok(store
        .mutate(&app, |s| {
            s["runtimeByWorkspace"][&workspace_id] = build_runtime_snapshot();
        })
        .await)
}

#[tauri::command]
pub async fn logout_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    _provider_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            s["runtimeByWorkspace"][&workspace_id] = build_runtime_snapshot();
        })
        .await)
}

#[tauri::command]
pub async fn set_provider_api_key(
    store: State<'_, Arc<Store>>,
    _workspace_id: String,
    provider_id: String,
    api_key: String,
) -> Result<DesktopState, String> {
    providers::set_provider_api_key(&provider_id, &api_key).map_err(|e| format!("{e}"))?;
    Ok(store.state.lock().await.clone())
}

#[tauri::command]
pub async fn list_custom_providers() -> Result<Vec<serde_json::Value>, String> {
    Ok(providers::list_custom_providers())
}

#[tauri::command]
pub async fn get_custom_provider(provider_id: String) -> Result<serde_json::Value, String> {
    providers::get_custom_provider(&provider_id)
        .ok_or_else(|| format!("provider '{provider_id}' not found"))
}

#[tauri::command]
pub async fn set_custom_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    config: serde_json::Value,
) -> Result<DesktopState, String> {
    providers::set_custom_provider(&config)?;
    Ok(store
        .mutate(&app, |s| {
            s["runtimeByWorkspace"][&workspace_id] = build_runtime_snapshot();
        })
        .await)
}

#[tauri::command]
pub async fn delete_custom_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    provider_id: String,
) -> Result<DesktopState, String> {
    providers::delete_custom_provider(&provider_id)?;
    Ok(store
        .mutate(&app, |s| {
            s["runtimeByWorkspace"][&workspace_id] = build_runtime_snapshot();
        })
        .await)
}

#[tauri::command]
pub async fn probe_custom_provider_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    Ok(providers::probe_custom_provider_models(
        &base_url,
        api_key.as_deref(),
    ))
}

#[tauri::command]
pub async fn has_provider_auth(provider_id: String) -> Result<bool, String> {
    Ok(providers::has_provider_auth(&provider_id))
}

// ── Skill CRUD ──

#[tauri::command]
pub async fn list_skills(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, &workspace_id);
    drop(state);
    Ok(skills::list_skills(ws_path.as_deref(), &workspace_id))
}

#[tauri::command]
pub async fn get_skill(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    name: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, &workspace_id);
    drop(state);
    skills::get_skill(ws_path.as_deref(), &workspace_id, &name)
        .ok_or_else(|| format!("skill '{name}' not found"))
}

#[tauri::command]
pub async fn delete_skill(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    name: String,
) -> Result<(), String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, &workspace_id);
    drop(state);
    skills::delete_skill(ws_path.as_deref(), &name)
}

// ── Extension CRUD ──

#[tauri::command]
pub async fn list_extensions(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, &workspace_id);
    drop(state);
    Ok(extensions::list_extensions(
        ws_path.as_deref(),
        &workspace_id,
    ))
}

#[tauri::command]
pub async fn get_extension(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    name: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, &workspace_id);
    drop(state);
    extensions::get_extension(ws_path.as_deref(), &workspace_id, &name)
        .ok_or_else(|| format!("extension '{name}' not found"))
}

#[tauri::command]
pub async fn delete_extension(
    store: State<'_, Arc<Store>>,
    workspace_id: String,
    name: String,
) -> Result<(), String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, &workspace_id);
    drop(state);
    extensions::delete_extension(ws_path.as_deref(), &name)
}
