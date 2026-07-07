//! Session operations — mirrors original `app-store-session-state.ts` + session parts of `app-store.ts`.

use serde_json::json;
use crate::store::internal::{DesktopState, set_sess_field, now_iso};

pub fn select_session(state: &mut DesktopState, target: &serde_json::Value) {
    if let Some(ws_id) = target["workspaceId"].as_str() { state["selectedWorkspaceId"] = json!(ws_id); }
    if let Some(sess_id) = target["sessionId"].as_str() { state["selectedSessionId"] = json!(sess_id); }
}

pub fn archive_session(state: &mut DesktopState, target: &serde_json::Value) {
    set_sess_field(state, target, "archivedAt", json!(now_iso()));
}

pub fn unarchive_session(state: &mut DesktopState, target: &serde_json::Value) {
    set_sess_field(state, target, "archivedAt", serde_json::Value::Null);
}

pub fn set_session_pinned(state: &mut DesktopState, target: &serde_json::Value, pinned: bool) {
    set_sess_field(state, target, "pinnedAt",
        if pinned { json!(now_iso()) } else { serde_json::Value::Null });
}

pub fn create_session(state: &mut DesktopState, workspace_id: &str, title: &str) {
    let sess = json!({
        "id": format!("sess-{}", chrono::Utc::now().timestamp_millis()),
        "title": if title.is_empty() { "New thread" } else { title },
        "updatedAt": now_iso(), "preview": "", "status": "idle", "hasUnseenUpdate": false,
    });
    if let Some(ws) = state["workspaces"].as_array_mut().unwrap().iter_mut().find(|w| w["id"] == workspace_id) {
        ws["sessions"].as_array_mut().unwrap().push(sess);
        state["selectedSessionId"] = json!(ws["sessions"].as_array().unwrap().last().unwrap()["id"]);
    }
}

pub fn set_session_status(state: &mut DesktopState, sid: &str, status: &str) {
    if let Some(arr) = state["workspaces"][0]["sessions"].as_array_mut() {
        for sess in arr.iter_mut() {
            if sess["id"] == sid { sess["status"] = json!(status); return; }
        }
    }
}
