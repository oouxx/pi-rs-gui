//! Session operations.
//!
//! Session file I/O delegated to pi-rs `SessionManager`.

use crate::state::{now_iso, DesktopState, SessionRecord};
use pi_coding_agent::core::session_manager::SessionManager;
use serde_json::json;

/// Extract the first user message text from a JSONL session file.
///
/// Handles the modern content-block array format:
/// `{"role":"user","content":[{"type":"text","text":"hello"}]}`
/// as well as the legacy plain-string format:
/// `{"role":"user","content":"hello"}`.
fn first_user_text_from_file(path: &std::path::Path) -> Option<String> {
    let content = std::fs::read_to_string(path).ok()?;
    for line in content.lines() {
        let value: serde_json::Value = serde_json::from_str(line).ok()?;
        // Skip the session header
        if value.get("type").and_then(|t| t.as_str()) == Some("session") {
            continue;
        }
        // Only process message entries
        if value.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let msg = value.get("message")?;
        if msg.get("role").and_then(|r| r.as_str())? != "user" {
            continue;
        }
        // Try content as a plain string (legacy format) …
        if let Some(text) = msg.get("content").and_then(|c| c.as_str()) {
            if !text.is_empty() {
                return Some(text.to_string());
            }
        // … then as an array of content blocks (modern format).
        } else if let Some(blocks) = msg.get("content").and_then(|c| c.as_array()) {
            let text: String = blocks
                .iter()
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect();
            if !text.is_empty() {
                return Some(text);
            }
        }
        // First user message found but no text – stop looking.
        return None;
    }
    None
}

/// Scan `~/.pi-rs/agent/sessions/` for `.jsonl` files and return session records.
/// Delegates to pi-rs `SessionManager::list_all()`.
pub fn scan_existing_sessions() -> Vec<SessionRecord> {
    let sessions = futures::executor::block_on(SessionManager::list_all(None));
    sessions
        .into_iter()
        .map(|info| {
            let title = info.name.unwrap_or_else(|| {
                let first = &info.first_message;
                if !first.is_empty() && first != "(no messages)" {
                    first.chars().take(60).collect()
                } else if let Some(text) = first_user_text_from_file(&info.path) {
                    text.chars().take(60).collect()
                } else {
                    info.path
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .unwrap_or("Untitled")
                        .to_string()
                }
            });
            SessionRecord {
                id: info.id.clone(),
                title,
                updated_at: info
                    .modified
                    .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                preview: String::new(),
                status: "idle".to_string(),
                has_unseen_update: false,
                session_file: Some(info.path.to_string_lossy().to_string()),
                archived_at: None,
                config: None,
                thinking_level: None,
                cwd: None,
            }
        })
        .collect()
}

/// Read transcript messages from a JSONL session file using pi-rs `SessionManager`.
pub fn read_transcript_from_file(path: &str) -> Vec<serde_json::Value> {
    let session_dir = match std::path::PathBuf::from(path).parent() {
        Some(p) => p.to_string_lossy().to_string(),
        None => return vec![],
    };
    let mgr = SessionManager::new("", &session_dir, Some(path), false, None);
    let entries = mgr.get_entries();

    // First pass: collect tool results keyed by tool_call_id so we can merge
    // them onto their corresponding toolCall blocks in the next pass.
    use pi_coding_agent::core::session_manager::SessionEntry;
    let mut tool_results: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    for entry in &entries {
        if let SessionEntry::Message { message, .. } = entry {
            if message.get("role").and_then(|r| r.as_str()) == Some("toolResult") {
                let id = message
                    .get("tool_call_id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_error = message
                    .get("is_error")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                let text: String = message
                    .get("content")
                    .and_then(|c| c.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                            .collect()
                    })
                    .unwrap_or_default();
                if !id.is_empty() {
                    tool_results.insert(id, (text, is_error));
                }
            }
        }
    }

    // Second pass: emit user/assistant messages with structured content blocks.
    let mut messages = Vec::new();
    for entry in &entries {
        if let SessionEntry::Message { message, .. } = entry {
            let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }

            // Build structured content blocks (clone so we can inject tool state).
            let mut blocks = message.get("content").cloned().unwrap_or(json!([]));
            // Handle legacy plain-string content by wrapping it as a text block.
            if blocks.is_string() {
                blocks = json!([{ "type": "text", "text": blocks }]);
            }
            if let Some(arr) = blocks.as_array_mut() {
                for b in arr.iter_mut() {
                    if b.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                        if let Some(id) = b.get("id").and_then(|i| i.as_str()) {
                            if let Some((result, is_error)) = tool_results.get(id) {
                                b["status"] = json!(if *is_error { "error" } else { "success" });
                                b["result"] = json!(result);
                                b["isError"] = json!(is_error);
                            }
                        }
                    }
                }
            }

            let text: String = blocks
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                        .collect()
                })
                .unwrap_or_default();
            let ts = message
                .get("timestamp")
                .and_then(|t| t.as_i64())
                .unwrap_or(0);
            let ts_secs = ts as f64 / 1000.0;
            let created = chrono::DateTime::from_timestamp(ts_secs as i64, 0)
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
                .unwrap_or_else(now_iso);
            messages.push(json!({
                "id": format!("msg-{}", messages.len()),
                "kind": "message",
                "role": role,
                "text": text,
                "content": blocks,
                "createdAt": created,
            }));
        }
    }
    messages
}

/// Select a session by ID.
pub fn select_session_by_id(state: &mut DesktopState, session_id: &str) {
    state.selected_session_id = session_id.to_string();
}

/// Soft-archive a session by ID: moves the file to an `archived/` subdirectory
/// and removes the session from the active list. The file remains on disk for
/// potential recovery. After archiving, selects the next available session.
pub fn archive_session_by_id(state: &mut DesktopState, session_id: &str) {
    // Move the session file to an archived/ subdirectory.
    if let Some(sess) = state.sessions.iter().find(|s| s.id == session_id) {
        if let Some(ref fp) = sess.session_file {
            let path = std::path::Path::new(fp);
            if path.exists() {
                let archived_dir = path.parent().unwrap_or(path).join("archived");
                let _ = std::fs::create_dir_all(&archived_dir);
                let dest = archived_dir.join(path.file_name().unwrap_or_default());
                let _ = std::fs::rename(path, &dest);
            }
        }
    }
    // Remove the session from the in-memory list.
    state.sessions.retain(|s| s.id != session_id);
    // Select the next available session.
    let next_id = state
        .sessions
        .iter()
        .find(|s| s.archived_at.is_none())
        .map(|s| s.id.clone());
    state.selected_session_id = next_id.unwrap_or_default();
}

/// Permanently delete a session by ID: removes the file from disk and the
/// session from the in-memory list. After deletion, selects the next available
/// session.
pub fn delete_session_by_id(state: &mut DesktopState, session_id: &str) {
    // Delete the session file from disk.
    if let Some(sess) = state.sessions.iter().find(|s| s.id == session_id) {
        if let Some(ref fp) = sess.session_file {
            let path = std::path::Path::new(fp);
            if path.exists() {
                let _ = std::fs::remove_file(path);
            }
        }
    }
    // Also remove from archived/ subdirectory if it was moved there.
    if let Some(sess) = state.sessions.iter().find(|s| s.id == session_id) {
        if let Some(ref fp) = sess.session_file {
            let path = std::path::Path::new(fp);
            if let Some(parent) = path.parent() {
                let archived_path = parent
                    .join("archived")
                    .join(path.file_name().unwrap_or_default());
                if archived_path.exists() {
                    let _ = std::fs::remove_file(&archived_path);
                }
            }
        }
    }
    // Remove the session from the in-memory list.
    state.sessions.retain(|s| s.id != session_id);
    // Select the next available session.
    let next_id = state
        .sessions
        .iter()
        .find(|s| s.archived_at.is_none())
        .map(|s| s.id.clone());
    state.selected_session_id = next_id.unwrap_or_default();
}

/// Create a new session.
pub fn create_session_simple(state: &mut DesktopState, title: &str) {
    let id = format!("sess-{}", chrono::Utc::now().timestamp_millis());
    state.sessions.push(SessionRecord {
        id: id.clone(),
        title: if title.is_empty() {
            "New thread".to_string()
        } else {
            title.to_string()
        },
        updated_at: now_iso(),
        preview: String::new(),
        status: "idle".to_string(),
        has_unseen_update: false,
        session_file: None,
        archived_at: None,
        config: None,
        thinking_level: None,
        cwd: std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
    });
    state.selected_session_id = id;
}

/// Rename a session by ID.
pub fn rename_session_by_id(state: &mut DesktopState, session_id: &str, title: &str) {
    if let Some(sess) = state.sessions.iter_mut().find(|s| s.id == session_id) {
        sess.title = title.to_string();
    }
}
