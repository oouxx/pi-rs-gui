//! Workspace operations — mirrors original `app-store-workspace.ts`.

use serde_json::json;

use crate::store::internal::{DesktopState, now_iso, next_id};

pub fn add_workspace(state: &mut DesktopState, path: &str) {
    state["workspaces"].as_array_mut().unwrap().push(json!({
        "id": next_id("ws"), "name": path.split('/').last().unwrap_or(path),
        "path": path, "lastOpenedAt": now_iso(), "kind": "primary", "sessions": []
    }));
}

pub fn select_workspace(state: &mut DesktopState, workspace_id: &str) {
    state["selectedWorkspaceId"] = json!(workspace_id);
}

pub fn rename_workspace(state: &mut DesktopState, workspace_id: &str, display_name: &str) {
    if let Some(ws) = state["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == workspace_id) {
        ws["name"] = json!(display_name);
    }
}

pub fn remove_workspace(state: &mut DesktopState, workspace_id: &str) {
    let prev = state["selectedWorkspaceId"].as_str().unwrap_or("").to_string();
    state["workspaces"].as_array_mut().unwrap().retain(|w| w["id"] != workspace_id);
    if prev == workspace_id {
        state["selectedWorkspaceId"] = json!(
            state["workspaces"].as_array().and_then(|a| a.first()).map(|w| w["id"].as_str().unwrap()).unwrap_or("")
        );
    }
}

pub fn reorder_workspaces(state: &mut DesktopState, workspace_order: &[String]) {
    let by_id: std::collections::HashMap<&str, &DesktopState> =
        state["workspaces"].as_array().unwrap().iter().map(|w| (w["id"].as_str().unwrap(), w)).collect();
    state["workspaces"] = json!(workspace_order.iter()
        .filter_map(|id| by_id.get(id.as_str()))
        .map(|w| (*w).clone())
        .collect::<Vec<_>>());
}

pub fn workspace_path(state: &DesktopState, ws_id: &str) -> Option<String> {
    state["workspaces"].as_array()
        .and_then(|ws| ws.iter().find(|w| w["id"] == ws_id))
        .and_then(|w| w["path"].as_str())
        .map(|s| s.to_string())
}
