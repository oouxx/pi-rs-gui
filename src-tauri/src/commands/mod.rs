use std::sync::Arc;

use crate::state::*;
use crate::state::{composer, extensions, model, providers, session, skills, workspace};
use serde_json::json;
use tauri::{AppHandle, State};

// ── Core ──

#[tauri::command]
pub async fn ping() -> String {
    "pong".into()
}

#[tauri::command]
pub async fn get_state(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
    Ok(store.state.lock().await.clone())
}

// ── Session CRUD (backed by pi-rs) ──

#[tauri::command]
pub async fn select_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| session::select_session_by_id(s, &session_id)).await)
}

#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    title: Option<String>,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| session::create_session_simple(s, title.as_deref().unwrap_or("New thread"))).await)
}

#[tauri::command]
pub async fn archive_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| session::archive_session_by_id(s, &session_id)).await)
}

#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
    title: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| session::rename_session_by_id(s, &session_id, &title)).await)
}

// ── Agent-session flow ──

#[tauri::command]
pub async fn submit_composer(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    text: String,
    _options: Option<serde_json::Value>,
) -> Result<DesktopState, String> {
    store.ensure_session(&app).await?;
    store.send_message(&app, &text).await.map_err(|e| e.to_string())?;
    Ok(store.state.lock().await.clone())
}

#[tauri::command]
pub async fn cancel_current_run(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<DesktopState, String> {
    store.abort().await;
    Ok(store.mutate(&app, |s| {
        let sid = s["selectedSessionId"].as_str().unwrap_or("").to_string();
        crate::state::internal::set_sess_status(s, &sid, "idle");
    }).await)
}

// ── View ──

#[tauri::command]
pub async fn set_active_view(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    view: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| { s["activeView"] = json!(view); }).await)
}

#[tauri::command]
pub async fn set_sidebar_collapsed(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    collapsed: bool,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| { s["sidebarCollapsed"] = json!(collapsed); }).await)
}

// ── Model ──

#[tauri::command]
pub async fn get_default_model(
    store: State<'_, Arc<Store>>,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    Ok(model::get_default_model(&state, "ws-default"))
}

#[tauri::command]
pub async fn get_models(
    store: State<'_, Arc<Store>>,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let snapshot = state["runtimeByWorkspace"]["ws-default"].clone();
    let models = snapshot["models"].as_array().cloned().unwrap_or_default();
    Ok(json!({"models": models}))
}

#[tauri::command]
pub async fn get_providers(
    store: State<'_, Arc<Store>>,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let snapshot = state["runtimeByWorkspace"]["ws-default"].clone();
    let providers_list = snapshot["providers"].as_array().cloned().unwrap_or_default();
    Ok(json!({"providers": providers_list}))
}

#[tauri::command]
pub async fn get_model_settings(
    store: State<'_, Arc<Store>>,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let settings = state["runtimeByWorkspace"]["ws-default"]["settings"].clone();
    let global = state["globalModelSettings"].clone();
    Ok(json!({"settings": settings, "globalModelSettings": global}))
}

#[tauri::command]
pub async fn set_default_model(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    provider: String,
    model_id: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| model::set_default_model(s, "ws-default", &provider, &model_id)).await)
}

#[tauri::command]
pub async fn set_default_thinking_level(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    thinking_level: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| model::set_default_thinking_level(s, "ws-default", &thinking_level)).await)
}

#[tauri::command]
pub async fn set_provider_api_key(
    store: State<'_, Arc<Store>>,
    provider_id: String,
    api_key: String,
) -> Result<DesktopState, String> {
    providers::set_provider_api_key(&provider_id, &api_key).map_err(|e| format!("{e}"))?;
    Ok(store.state.lock().await.clone())
}

#[tauri::command]
pub async fn login_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    _provider_id: String,
) -> Result<DesktopState, String> {
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    Ok(store.mutate(&app, |s| { s["runtimeByWorkspace"]["ws-default"] = build_runtime_snapshot(); }).await)
}

#[tauri::command]
pub async fn logout_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    _provider_id: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| { s["runtimeByWorkspace"]["ws-default"] = build_runtime_snapshot(); }).await)
}

#[tauri::command]
pub async fn set_custom_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    config: serde_json::Value,
) -> Result<DesktopState, String> {
    providers::set_custom_provider(&config)?;
    Ok(store.mutate(&app, |s| { s["runtimeByWorkspace"]["ws-default"] = build_runtime_snapshot(); }).await)
}

#[tauri::command]
pub async fn delete_custom_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    provider_id: String,
) -> Result<DesktopState, String> {
    providers::delete_custom_provider(&provider_id)?;
    Ok(store.mutate(&app, |s| { s["runtimeByWorkspace"]["ws-default"] = build_runtime_snapshot(); }).await)
}

#[tauri::command]
pub async fn set_model_settings_scope_mode(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    mode: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| model::set_model_settings_scope(s, &mode)).await)
}

// ── Theme ──

#[tauri::command]
pub async fn set_theme_mode(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    mode: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| { s["themeMode"] = json!(mode); }).await)
}

#[tauri::command]
pub async fn set_theme_preset_id(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    preset_id: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| { s["themePresetId"] = json!(preset_id); }).await)
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

// ── Transcript ──

#[tauri::command]
pub async fn get_selected_transcript(
    store: State<'_, Arc<Store>>,
) -> Result<Option<serde_json::Value>, String> {
    let (ws_id, sess_id, session_file) = {
        let state = store.state.lock().await;
        let sid = state["selectedSessionId"].as_str().unwrap_or("").to_string();
        (
            state["selectedWorkspaceId"].as_str().unwrap_or("ws-default").to_string(),
            sid.clone(),
            state["workspaces"].as_array()
                .and_then(|ws| ws.iter().find(|w| w["id"] == state["selectedWorkspaceId"].as_str().unwrap_or("")))
                .and_then(|w| w["sessions"].as_array())
                .and_then(|ss| ss.iter().find(|s| s["id"] == sid))
                .and_then(|s| s["sessionFile"].as_str().filter(|f| !f.is_empty()))
                .map(String::from),
        )
    };
    if sess_id.is_empty() { return Ok(None); }

    let transcript = match session_file {
        Some(ref p) => crate::state::session::read_transcript_from_file(p),
        None => vec![],
    };
    if transcript.is_empty() { return Ok(None); }

    Ok(Some(json!({"workspaceId": ws_id, "sessionId": sess_id, "transcript": transcript})))
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

// ── Providers CRUD ──

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
pub async fn probe_custom_provider_models(
    base_url: String,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    Ok(providers::probe_custom_provider_models(&base_url, api_key.as_deref()))
}

#[tauri::command]
pub async fn has_provider_auth(provider_id: String) -> Result<bool, String> {
    Ok(providers::has_provider_auth(&provider_id))
}

// ── Skills ──

#[tauri::command]
pub async fn list_skills(
    store: State<'_, Arc<Store>>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, "ws-default");
    drop(state);
    Ok(skills::list_skills(ws_path.as_deref(), "ws-default"))
}

#[tauri::command]
pub async fn get_skill(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, "ws-default");
    drop(state);
    skills::get_skill(ws_path.as_deref(), "ws-default", &name)
        .ok_or_else(|| format!("skill '{name}' not found"))
}

#[tauri::command]
pub async fn delete_skill(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<(), String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, "ws-default");
    drop(state);
    skills::delete_skill(ws_path.as_deref(), &name)
}

// ── Extensions ──

#[tauri::command]
pub async fn list_extensions(
    store: State<'_, Arc<Store>>,
) -> Result<Vec<serde_json::Value>, String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, "ws-default");
    drop(state);
    Ok(extensions::list_extensions(ws_path.as_deref(), "ws-default"))
}

#[tauri::command]
pub async fn get_extension(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, "ws-default");
    drop(state);
    extensions::get_extension(ws_path.as_deref(), "ws-default", &name)
        .ok_or_else(|| format!("extension '{name}' not found"))
}

#[tauri::command]
pub async fn delete_extension(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<(), String> {
    let state = store.state.lock().await;
    let ws_path = workspace::workspace_path(&state, "ws-default");
    drop(state);
    extensions::delete_extension(ws_path.as_deref(), &name)
}

// ── Composer ──

#[tauri::command]
pub async fn update_composer_draft(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    composer_draft: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| composer::update_composer_draft(s, &composer_draft)).await)
}

#[tauri::command]
pub async fn add_composer_attachments(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    attachments: serde_json::Value,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| composer::set_composer_attachments(s, attachments)).await)
}

#[tauri::command]
pub async fn remove_composer_attachment(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    attachment_id: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| composer::remove_composer_attachment(s, &attachment_id)).await)
}

#[tauri::command]
pub async fn edit_queued_composer_message(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    message_id: String,
    current_draft: Option<String>,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| composer::edit_queued_message(s, &message_id, current_draft.as_deref())).await)
}

#[tauri::command]
pub async fn cancel_queued_composer_edit(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| composer::cancel_queued_edit(s)).await)
}

#[tauri::command]
pub async fn remove_queued_composer_message(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    message_id: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| composer::remove_queued_message(s, &message_id)).await)
}

#[tauri::command]
pub async fn steer_queued_composer_message(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    message_id: String,
) -> Result<DesktopState, String> {
    Ok(store.mutate(&app, |s| composer::steer_queued_message(s, &message_id)).await)
}

#[tauri::command]
pub async fn pick_composer_attachments(
    _app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<DesktopState, String> {
    Ok(store.state.lock().await.clone())
}
