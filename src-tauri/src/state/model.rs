//! Model/provider settings — mirrors model settings parts of original `app-store.ts`.

use serde_json::json;
use crate::state::internal::DesktopState;

/// Ensure a runtime entry exists for the given workspace, creating it if absent.
pub fn ensure_runtime(state: &mut DesktopState, ws_id: &str) {
    if state["runtimeByWorkspace"][ws_id].is_null() {
        state["runtimeByWorkspace"][ws_id] = json!({"settings": {}});
    }
}

pub fn set_default_model(state: &mut DesktopState, ws_id: &str, provider: &str, model_id: &str) {
    ensure_runtime(state, ws_id);
    state["runtimeByWorkspace"][ws_id]["settings"]["defaultProvider"] = json!(provider);
    state["runtimeByWorkspace"][ws_id]["settings"]["defaultModelId"] = json!(model_id);
    // Also sync to globalModelSettings — when modelSettingsScopeMode is "app-global"
    // the frontend's getEffectiveModelRuntime applies globalModelSettings on top of
    // runtime settings, which would nuke these values if only stored in runtimeByWorkspace.
    state["globalModelSettings"]["defaultProvider"] = json!(provider);
    state["globalModelSettings"]["defaultModelId"] = json!(model_id);
}

pub fn set_default_thinking_level(state: &mut DesktopState, ws_id: &str, level: &str) {
    ensure_runtime(state, ws_id);
    state["runtimeByWorkspace"][ws_id]["settings"]["defaultThinkingLevel"] = json!(level);
    state["globalModelSettings"]["defaultThinkingLevel"] = json!(level);
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
