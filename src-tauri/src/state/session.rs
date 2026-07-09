//! Session operations.

use std::path::PathBuf;
use serde_json::json;
use crate::state::internal::{DesktopState, SessionRecord, now_iso};

/// Scan `~/.pi-rs/agent/sessions/` for `.jsonl` files and return session records.
pub fn scan_existing_sessions() -> Vec<SessionRecord> {
    let dir = match std::env::var("HOME") {
        Ok(h) => PathBuf::from(h).join(".pi-rs").join("agent").join("sessions"),
        Err(_) => return vec![],
    };
    if !dir.exists() { return vec![]; }

    let mut sessions: Vec<SessionRecord> = vec![];
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") { continue; }
            let path_str = path.to_string_lossy().to_string();
            let id = path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let title = extract_session_title(&path);

            sessions.push(SessionRecord {
                id,
                title,
                updated_at: now_iso(),
                preview: String::new(),
                status: "idle".to_string(),
                has_unseen_update: false,
                session_file: Some(path_str),
                archived_at: None,
                config: None,
                thinking_level: None,
            });
        }
    }
    sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    sessions
}

/// Read transcript messages directly from a JSONL session file (append-only).
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
        if val.get("type").and_then(|t| t.as_str()) == Some("session") { continue; }
        let msg = match val.get("message") {
            Some(m) => m,
            None => continue,
        };
        let role = match msg.get("role").and_then(|r| r.as_str()) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
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

/// Select a session by ID.
pub fn select_session_by_id(state: &mut DesktopState, session_id: &str) {
    state.selected_session_id = session_id.to_string();
}

/// Archive a session by ID. After archiving, selects the next available session.
pub fn archive_session_by_id(state: &mut DesktopState, session_id: &str) {
    if let Some(sess) = state.sessions.iter_mut().find(|s| s.id == session_id) {
        sess.archived_at = Some(now_iso());
    }
    let next_id = state.sessions.iter()
        .find(|s| s.id != session_id && s.archived_at.is_none())
        .map(|s| s.id.clone());
    state.selected_session_id = next_id.unwrap_or_default();
}

/// Create a new session.
pub fn create_session_simple(state: &mut DesktopState, title: &str) {
    let id = format!("sess-{}", chrono::Utc::now().timestamp_millis());
    state.sessions.push(SessionRecord {
        id: id.clone(),
        title: if title.is_empty() { "New thread".to_string() } else { title.to_string() },
        updated_at: now_iso(),
        preview: String::new(),
        status: "idle".to_string(),
        has_unseen_update: false,
        session_file: None,
        archived_at: None,
        config: None,
        thinking_level: None,
    });
    state.selected_session_id = id;
}

/// Rename a session by ID.
pub fn rename_session_by_id(state: &mut DesktopState, session_id: &str, title: &str) {
    if let Some(sess) = state.sessions.iter_mut().find(|s| s.id == session_id) {
        sess.title = title.to_string();
    }
}

/// Find and update a session's status.
pub fn set_session_status(state: &mut DesktopState, sid: &str, status: &str) {
    if let Some(sess) = state.sessions.iter_mut().find(|s| s.id == sid) {
        sess.status = status.to_string();
    }
}
