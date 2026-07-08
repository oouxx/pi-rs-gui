//! Session operations — mirrors original `app-store-session-state.ts` + session parts of `app-store-workspace.ts`.

use serde_json::json;
use crate::state::internal::{DesktopState, set_sess_field, now_iso};

pub fn select_session(state: &mut DesktopState, target: &serde_json::Value) {
    if let Some(ws_id) = target["workspaceId"].as_str() { state["selectedWorkspaceId"] = json!(ws_id); }
    if let Some(sess_id) = target["sessionId"].as_str() { state["selectedSessionId"] = json!(sess_id); }
}

/// After archiving, select the next available non-archived session in the
/// same workspace, or clear selectedSessionId if none remain.
pub fn archive_session(state: &mut DesktopState, target: &serde_json::Value) {
    set_sess_field(state, target, "archivedAt", json!(now_iso()));
    // Pick the next sibling session (first non-archived, non-self session
    // in the workspace), or clear the selection.
    let ws_id = target["workspaceId"].as_str().unwrap_or("");
    let sess_id = target["sessionId"].as_str().unwrap_or("");
    let next_id: Option<String> = state["workspaces"].as_array()
        .and_then(|ws| ws.iter().find(|w| w["id"] == ws_id))
        .and_then(|w| w["sessions"].as_array())
        .and_then(|sessions| {
            sessions.iter()
                .find(|s| s["id"] != sess_id && s["archivedAt"].is_null())
                .and_then(|s| s["id"].as_str().map(String::from))
        });
    match next_id {
        Some(n) => state["selectedSessionId"] = json!(n),
        None => state["selectedSessionId"] = json!(""),
    }
}

pub fn unarchive_session(state: &mut DesktopState, target: &serde_json::Value) {
    set_sess_field(state, target, "archivedAt", serde_json::Value::Null);
    // If no session is currently selected, select the newly unarchived one.
    if state["selectedSessionId"].as_str().unwrap_or("").is_empty() {
        if let Some(sess_id) = target["sessionId"].as_str() {
            state["selectedSessionId"] = json!(sess_id);
        }
    }
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
    let ws_list = match state["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    if let Some(ws) = ws_list.iter_mut().find(|w| w["id"] == workspace_id) {
        let sessions = match ws["sessions"].as_array_mut() {
            Some(a) => a,
            None => return,
        };
        sessions.push(sess);
        if let Some(last) = sessions.last() {
            state["selectedSessionId"] = json!(last["id"]);
        }
    }
}

pub fn rename_session(state: &mut DesktopState, target: &serde_json::Value, title: &str) {
    let ws_id = target["workspaceId"].as_str().unwrap_or("");
    let sess_id = target["sessionId"].as_str().unwrap_or("");
    if let Some(ws) = state["workspaces"].as_array_mut()
        .and_then(|ws| ws.iter_mut().find(|w| w["id"] == ws_id))
    {
        if let Some(sess) = ws["sessions"].as_array_mut()
            .and_then(|ss| ss.iter_mut().find(|s| s["id"] == sess_id))
        {
            sess["title"] = json!(title);
        }
    }
}

/// Find and update a session's status, searching across **all** workspaces
/// (not just the first one).
pub fn set_session_status(state: &mut DesktopState, sid: &str, status: &str) {
    let ws_list = match state["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    for ws in ws_list.iter_mut() {
        let sessions = match ws["sessions"].as_array_mut() {
            Some(a) => a,
            None => continue,
        };
        for sess in sessions.iter_mut() {
            if sess["id"] == sid {
                sess["status"] = json!(status);
                return;
            }
        }
    }
}
