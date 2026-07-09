//! Session operations — mirrors original `app-store-session-state.ts` + session parts of `app-store-workspace.ts`.

use std::path::PathBuf;
use serde_json::json;
use crate::state::internal::{DesktopState, set_sess_field, now_iso};

/// Scan `~/.pi-rs/agent/sessions/` for `.jsonl` files and return session records.
/// Each `.jsonl` file = one session.  Title is read from the file header/name;
/// falls back to the filename stem (timestamp_id).
pub fn scan_existing_sessions() -> Vec<serde_json::Value> {
    let dir = match std::env::var("HOME") {
        Ok(h) => PathBuf::from(h).join(".pi-rs").join("agent").join("sessions"),
        Err(_) => return vec![],
    };
    if !dir.exists() { return vec![]; }

    let mut sessions: Vec<serde_json::Value> = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let path_str = path.to_string_lossy().to_string();
            let id = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            // Read first lines to extract the header name if present
            let title = extract_session_title(&path);

            sessions.push(json!({
                "id": id,
                "title": title,
                "updatedAt": now_iso(),
                "preview": "",
                "status": "idle",
                "hasUnseenUpdate": false,
                "sessionFile": path_str,
            }));
        }
    }
    sessions.sort_by(|a, b| {
        let a = a["updatedAt"].as_str().unwrap_or("");
        let b = b["updatedAt"].as_str().unwrap_or("");
        b.cmp(a) // newest first
    });
    sessions
}

/// Read transcript messages directly from a JSONL session file (append-only).
/// Returns the messages as a JSON array of {id, kind, role, text, createdAt}.
/// Read transcript messages directly from a JSONL session file (append-only).
/// Format per line:
///   {"type":"session","cwd":"..."}  ← header, skipped
///   {"type":"message","message":{"content":[{"text":"..."}],"role":"user|assistant"}}
pub fn read_transcript_from_file(path: &str) -> Vec<serde_json::Value> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let mut messages = Vec::new();
    for line in content.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // Skip header lines (type=session)
        if val.get("type").and_then(|t| t.as_str()) == Some("session") { continue; }
        // Extract message object
        let msg = match val.get("message") {
            Some(m) => m,
            None => continue,
        };
        let role = match msg.get("role").and_then(|r| r.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        // content is an array of blocks like [{"text":"...","type":"text"}]
        let text: String = msg.get("content").and_then(|c| c.as_array())
            .map(|arr| arr.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect())
            .unwrap_or_default();
        let ts = val.get("timestamp").and_then(|t| t.as_str()).unwrap_or("");
        messages.push(json!({
            "id": format!("msg-{}", messages.len()),
            "kind": "message",
            "role": role,
            "text": text,
            "createdAt": ts,
        }));
    }
    messages
}

/// Extract a title from the first user message in a JSONL session file.
fn extract_session_title(path: &PathBuf) -> String {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return path.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled").to_string(),
    };
    for line in content.lines() {
        let val: serde_json::Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if val.get("type").and_then(|t| t.as_str()) != Some("message") { continue; }
        let msg = match val.get("message") {
            Some(m) => m,
            None => continue,
        };
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") { continue; }
        let text: String = msg.get("content").and_then(|c| c.as_array())
            .map(|arr| arr.iter().filter_map(|b| b.get("text").and_then(|t| t.as_str())).collect())
            .unwrap_or_default();
        if !text.is_empty() { return text.chars().take(60).collect(); }
    }
    path.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled").to_string()
}

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

/// Select a session by ID (uses first/ws-default workspace).
pub fn select_session_by_id(state: &mut DesktopState, session_id: &str) {
    state["selectedSessionId"] = json!(session_id);
}

/// Archive a session by ID (uses first/ws-default workspace).
/// After archiving, selects the next available session.
pub fn archive_session_by_id(state: &mut DesktopState, session_id: &str) {
    let ws_list = match state["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    for ws in ws_list.iter_mut() {
        let sessions = match ws["sessions"].as_array_mut() {
            Some(a) => a,
            None => continue,
        };
        if let Some(sess) = sessions.iter_mut().find(|s| s["id"] == session_id) {
            sess["archivedAt"] = json!(now_iso());
        }
    }
    // Select next non-archived session
    let all_sessions: Vec<&serde_json::Value> = ws_list.iter()
        .flat_map(|ws| ws["sessions"].as_array().into_iter().flatten())
        .collect();
    let next_id: Option<String> = all_sessions.iter()
        .find(|s| s["id"] != session_id && s["archivedAt"].is_null())
        .and_then(|s| s["id"].as_str().map(String::from));
    match next_id {
        Some(n) => state["selectedSessionId"] = json!(n),
        None => state["selectedSessionId"] = json!(""),
    }
}

/// Create a new session in the first/ws-default workspace.
pub fn create_session_simple(state: &mut DesktopState, title: &str) {
    let id = format!("sess-{}", chrono::Utc::now().timestamp_millis());
    let sess = json!({
        "id": id,
        "title": if title.is_empty() { "New thread" } else { title },
        "updatedAt": now_iso(), "preview": "", "status": "idle", "hasUnseenUpdate": false,
    });
    let ws_list = match state["workspaces"].as_array_mut() {
        Some(a) => a,
        None => return,
    };
    // Push to first workspace
    if let Some(ws) = ws_list.first_mut() {
        if let Some(arr) = ws["sessions"].as_array_mut() {
            arr.push(sess);
        }
    }
    state["selectedSessionId"] = json!(id);
}

/// Rename a session by ID (uses first/ws-default workspace).
pub fn rename_session_by_id(state: &mut DesktopState, session_id: &str, title: &str) {
    for ws in state["workspaces"].as_array_mut().into_iter().flatten() {
        if let Some(sess) = ws["sessions"].as_array_mut()
            .and_then(|ss| ss.iter_mut().find(|s| s["id"] == session_id))
        {
            sess["title"] = json!(title);
            return;
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
