//! Model/provider settings — CRUD for default model, thinking level,
//! and per-session model overrides.  Persists to ~/.pi-rs/agent/settings.json
//! via pi-coding-agent's SettingsManager.

use serde_json::json;
use crate::state::internal::DesktopState;

/// Persist global settings to disk via pi-coding-agent's SettingsManager.
fn persist_global_settings(provider: Option<&str>, model: Option<&str>, thinking: Option<&str>) {
    let agent_dir = pi_coding_agent::config::get_agent_dir();
    let mut mgr = pi_coding_agent::core::settings_manager::SettingsManager::create(
        agent_dir.to_string_lossy().as_ref(),
        Some(agent_dir.to_string_lossy().as_ref()),
    );
    if let Some(p) = provider { mgr.set_global("default_provider", json!(p)); }
    if let Some(m) = model { mgr.set_global("default_model", json!(m)); }
    if let Some(t) = thinking { mgr.set_global("thinking_level", json!(t)); }
}

/// Ensure a runtime entry exists for the given workspace.
pub fn ensure_runtime(state: &mut DesktopState, ws_id: &str) {
    if state["runtimeByWorkspace"][ws_id].is_null() {
        state["runtimeByWorkspace"][ws_id] = json!({"settings": {}});
    }
}

/// Set the default provider+model for a workspace. Persists globally.
pub fn set_default_model(state: &mut DesktopState, ws_id: &str, provider: &str, model_id: &str) {
    ensure_runtime(state, ws_id);
    state["runtimeByWorkspace"][ws_id]["settings"]["defaultProvider"] = json!(provider);
    state["runtimeByWorkspace"][ws_id]["settings"]["defaultModelId"] = json!(model_id);
    state["globalModelSettings"]["defaultProvider"] = json!(provider);
    state["globalModelSettings"]["defaultModelId"] = json!(model_id);
    persist_global_settings(Some(provider), Some(model_id), None);
}

/// Set the default thinking level for a workspace. Persists globally.
pub fn set_default_thinking_level(state: &mut DesktopState, ws_id: &str, level: &str) {
    ensure_runtime(state, ws_id);
    state["runtimeByWorkspace"][ws_id]["settings"]["defaultThinkingLevel"] = json!(level);
    state["globalModelSettings"]["defaultThinkingLevel"] = json!(level);
    persist_global_settings(None, None, Some(level));
}

fn find_session<'a>(state: &'a mut DesktopState, ws_id: &str, session_id: &str) -> Option<&'a mut serde_json::Value> {
    let ws_list = state["workspaces"].as_array_mut()?;
    let ws = ws_list.iter_mut().find(|w| w["id"] == ws_id)?;
    let sessions = ws["sessions"].as_array_mut()?;
    sessions.iter_mut().find(|s| s["id"] == session_id)
}

pub fn set_session_model(state: &mut DesktopState, ws_id: &str, session_id: &str, provider: &str, model_id: &str) {
    if let Some(sess) = find_session(state, ws_id, session_id) {
        sess["config"] = json!({"provider": provider, "modelId": model_id});
    }
}

pub fn set_session_thinking_level(state: &mut DesktopState, ws_id: &str, session_id: &str, level: &str) {
    if let Some(sess) = find_session(state, ws_id, session_id) {
        sess["thinkingLevel"] = json!(level);
    }
}

pub fn set_model_settings_scope(state: &mut DesktopState, mode: &str) {
    state["modelSettingsScopeMode"] = json!(mode);
}

/// Read default model from settings (returns provider+model).
pub fn get_default_model(state: &DesktopState, ws_id: &str) -> serde_json::Value {
    let settings = &state["runtimeByWorkspace"][ws_id]["settings"];
    json!({
        "defaultProvider": settings["defaultProvider"].as_str().unwrap_or(""),
        "defaultModelId": settings["defaultModelId"].as_str().unwrap_or(""),
        "defaultThinkingLevel": settings["defaultThinkingLevel"].as_str().unwrap_or("normal"),
    })
}
