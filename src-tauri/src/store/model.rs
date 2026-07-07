//! Model/provider settings — mirrors model settings parts of original `app-store.ts`.

use serde_json::json;
use crate::store::internal::DesktopState;

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
}

pub fn set_default_thinking_level(state: &mut DesktopState, ws_id: &str, level: &str) {
    ensure_runtime(state, ws_id);
    state["runtimeByWorkspace"][ws_id]["settings"]["defaultThinkingLevel"] = json!(level);
}

pub fn set_session_model(state: &mut DesktopState, ws_id: &str, session_id: &str, provider: &str, model_id: &str) {
    if let Some(ws) = state["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == ws_id) {
        if let Some(sess) = ws["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == session_id) {
            sess["config"] = json!({"provider": provider, "modelId": model_id});
        }
    }
}

pub fn set_session_thinking_level(state: &mut DesktopState, ws_id: &str, session_id: &str, level: &str) {
    if let Some(ws) = state["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == ws_id) {
        if let Some(sess) = ws["sessions"].as_array_mut().unwrap().iter_mut().find(|s| s["id"] == session_id) {
            sess["thinkingLevel"] = json!(level);
        }
    }
}

pub fn set_model_settings_scope(state: &mut DesktopState, mode: &str) {
    state["modelSettingsScopeMode"] = json!(mode);
}
