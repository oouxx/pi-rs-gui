//! Workspace operations — mirrors original `app-store-workspace.ts`.

use serde_json::json;

use crate::state::internal::{DesktopState, now_iso, next_id};

pub fn add_workspace(state: &mut DesktopState, path: &str) {
    let ws_list = match state["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    ws_list.push(json!({
        "id": next_id("ws"), "name": path.split('/').last().unwrap_or(path),
        "path": path, "lastOpenedAt": now_iso(), "kind": "primary", "sessions": []
    }));
}

pub fn select_workspace(state: &mut DesktopState, workspace_id: &str) {
    state["selectedWorkspaceId"] = json!(workspace_id);
}

pub fn rename_workspace(state: &mut DesktopState, workspace_id: &str, display_name: &str) {
    let ws_list = match state["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    if let Some(ws) = ws_list.iter_mut().find(|w| w["id"] == workspace_id) {
        ws["name"] = json!(display_name);
    }
}

pub fn remove_workspace(state: &mut DesktopState, workspace_id: &str) {
    let prev = state["selectedWorkspaceId"].as_str().unwrap_or("").to_string();
    let ws_list = match state["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    ws_list.retain(|w| w["id"] != workspace_id);
    if prev == workspace_id {
        // Select the first remaining workspace, or clear the selection.
        let fallback = state["workspaces"].as_array()
            .and_then(|a| a.first())
            .and_then(|w| w["id"].as_str())
            .unwrap_or("");
        state["selectedWorkspaceId"] = json!(fallback);
    }
}

pub fn reorder_workspaces(state: &mut DesktopState, workspace_order: &[String]) {
    let ws_list = match state["workspaces"].as_array() {
        Some(a) => a,
        None => return,
    };
    let by_id: std::collections::HashMap<&str, &serde_json::Value> =
        ws_list.iter().map(|w| (w["id"].as_str().unwrap_or(""), w)).collect();
    let reordered: Vec<serde_json::Value> = workspace_order.iter()
        .filter_map(|id| by_id.get(id.as_str()).map(|v| (*v).clone()))
        .collect();
    state["workspaces"] = json!(reordered);
}

pub fn workspace_path(state: &DesktopState, ws_id: &str) -> Option<String> {
    state["workspaces"].as_array()
        .and_then(|ws| ws.iter().find(|w| w["id"] == ws_id))
        .and_then(|w| w["path"].as_str())
        .map(|s| s.to_string())
}
