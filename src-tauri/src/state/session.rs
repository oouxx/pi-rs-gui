//! Session operations.
//!
//! Session file I/O delegated to pi-rs `SessionManager`.

use crate::state::{now_iso, DesktopState, SessionRecord};
use pi_coding_agent::core::session_manager::SessionManager;
use serde_json::json;

/// Extract a short preview of the LAST message from a session file by reading
/// only the file tail (cheap — no full JSONL parse).
fn last_message_preview(path: &str) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let last_line = content
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with("{\"type\":\"message\""))
        .map(|l| l.to_string());
    let Some(line) = last_line else {
        return String::new();
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
        return String::new();
    };
    let message = v.get("message");
    let role = message
        .and_then(|m| m.get("role"))
        .and_then(|r| r.as_str())
        .unwrap_or("");
    let mut text = String::new();
    if let Some(content) = message.and_then(|m| m.get("content")).and_then(|c| c.as_array()) {
        for block in content {
            if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                    text.push_str(t);
                }
            }
        }
    }
    let text = text.trim();
    if text.is_empty() {
        return String::new();
    }
    let prefix = if role == "user" { "You: " } else { "AI: " };
    let truncated: String = text.chars().take(80).collect();
    if truncated != text {
        format!("{prefix}{truncated}…")
    } else {
        format!("{prefix}{text}")
    }
}

/// Map a pi-rs `SessionInfo` to the UI-facing record.
///
/// pi-rs `list_all` scans every subdirectory of the sessions dir, including
/// `archived/` — callers filter those out so archived sessions don't reappear.
fn record_from_info(info: pi_coding_agent::core::session_manager::SessionInfo) -> SessionRecord {
    let title = info.name.unwrap_or_else(|| {
        if !info.first_message.is_empty() && info.first_message != "(no messages)" {
            info.first_message.chars().take(60).collect()
        } else {
            info.path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string()
        }
    });
    let preview = info
        .path
        .to_str()
        .map(last_message_preview)
        .unwrap_or_default();
    SessionRecord {
        id: info.id.clone(),
        title,
        updated_at: info
            .modified
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        preview,
        status: "idle".to_string(),
        session_file: Some(info.path.to_string_lossy().to_string()),
        archived_at: None,
        config: None,
        thinking_level: None,
        cwd: (!info.cwd.is_empty()).then_some(info.cwd),
    }
}

fn records_from_infos(
    sessions: Vec<pi_coding_agent::core::session_manager::SessionInfo>,
) -> Vec<SessionRecord> {
    sessions
        .into_iter()
        .filter(|info| !info.path.to_string_lossy().contains("/archived/"))
        .map(record_from_info)
        .collect()
}

/// Scan `~/.pi-rs/agent/sessions/` for `.jsonl` files and return session records.
/// Delegates to pi-rs `SessionManager::list_all()` (which provides the title,
/// first-message text, and timestamps — no manual JSONL parsing here).
///
/// Blocking variant for pre-runtime startup (`Store::new_with_runtime`). Async
/// call sites must use [`scan_existing_sessions_async`] instead: blocking a
/// tokio worker while scanning every session file stalls all other tasks.
pub fn scan_existing_sessions() -> Vec<SessionRecord> {
    records_from_infos(futures::executor::block_on(SessionManager::list_all(None)))
}

/// Async variant used from runtime paths (fork/import/select).
pub async fn scan_existing_sessions_async() -> Vec<SessionRecord> {
    records_from_infos(SessionManager::list_all(None).await)
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
    // Consecutive assistant messages (each step of a tool-calling run) are
    // merged into one message (Claude Code style).
    let mut messages: Vec<serde_json::Value> = Vec::new();
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

            if role == "assistant" {
                if let Some(last) = messages.last_mut() {
                    if last.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                        // Merge: append this step's blocks and recompute text.
                        if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                            if let Some(blocks_arr) = blocks.as_array() {
                                arr.extend(blocks_arr.iter().cloned());
                            }
                        }
                        if let Some(arr) = last.get("content").and_then(|c| c.as_array()) {
                            let merged_text: String = arr
                                .iter()
                                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                                .collect();
                            last["text"] = json!(merged_text);
                        }
                        continue;
                    }
                }
            }

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

/// Create a new session. `cwd` optionally pins the session to a project
/// directory (Codex-style "new conversation in the current project"); when
/// omitted it falls back to the process current directory.
#[cfg(test)]
pub fn create_session_simple(state: &mut DesktopState, title: &str, cwd: Option<&str>) {
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
        session_file: None,
        archived_at: None,
        config: None,
        thinking_level: None,
        cwd: cwd
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .or_else(|| {
                std::env::current_dir()
                    .ok()
                    .map(|p| p.to_string_lossy().into_owned())
            }),
    });
    state.selected_session_id = id;
}

/// Rename a session by ID.
pub fn rename_session_by_id(state: &mut DesktopState, session_id: &str, title: &str) {
    if let Some(sess) = state.sessions.iter_mut().find(|s| s.id == session_id) {
        sess.title = title.to_string();
    }
}


/// Full-text search across session message text (user + assistant).
///
/// `sessions` is `(id, title, session_file)`. Returns matching snippets in
/// file order, capped at `limit` overall and 3 matches per session.
 pub fn search_session_texts(
    sessions: &[(String, String, String)],
    query: &str,
    limit: usize,
) -> Vec<serde_json::Value> {
    let query = query.trim().to_lowercase();
    if query.is_empty() || limit == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    for (session_id, title, file) in sessions {
        if out.len() >= limit {
            break;
        }
        let Ok(text) = std::fs::read_to_string(file) else {
            continue;
        };
        let mut per_session = 0usize;
        for line in text.lines() {
            if out.len() >= limit || per_session >= 3 {
                break;
            }
            if !line.starts_with("{\"type\":\"message\"") {
                continue;
            }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
                continue;
            };
            let Some(message) = value.get("message") else {
                continue;
            };
            let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
            if role != "user" && role != "assistant" {
                continue;
            }
            let mut message_text = String::new();
            if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
                for block in content {
                    if block.get("type").and_then(|t| t.as_str()) == Some("text") {
                        if let Some(part) = block.get("text").and_then(|t| t.as_str()) {
                            message_text.push_str(part);
                            message_text.push('\n');
                        }
                    }
                }
            }
            if !message_text.to_lowercase().contains(&query) {
                continue;
            }
            // Snippet: a readable prefix around the message start.
            let snippet: String = message_text
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(180)
                .collect();
            let timestamp = message.get("timestamp").and_then(|t| t.as_i64());
            out.push(serde_json::json!({
                "sessionId": session_id,
                "title": title,
                "role": role,
                "snippet": snippet,
                "timestamp": timestamp,
            }));
            per_session += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_finds_message_text_and_snippets() {
        let dir = tempfile::tempdir().expect("tempdir");
        let file = dir.path().join("session.jsonl");
        std::fs::write(
            &file,
            concat!(
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Hello world\"}],\"timestamp\":1}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"The QUICK brown fox\"}],\"timestamp\":2}}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"content\":[{\"type\":\"text\",\"text\":\"quick ignored\"}],\"timestamp\":3}}\n"
            ),
        )
        .expect("write");

        let sessions = vec![(
            "session-id".to_string(),
            "Title".to_string(),
            file.to_string_lossy().to_string(),
        )];
        let hits = search_session_texts(&sessions, "quick", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0]["role"], "assistant");
        assert_eq!(hits[0]["sessionId"], "session-id");
        assert!(hits[0]["snippet"]
            .as_str()
            .expect("snippet")
            .contains("QUICK"));
    }
}
