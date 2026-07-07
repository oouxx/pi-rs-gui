//! In-memory terminal session management (no PTY dependency).
//! Sessions are tracked in a global HashMap. Future work will wire
//! real PTY processes via `portable-pty`.

use std::collections::HashMap;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde_json::json;

static TERMINAL_SESSIONS: Lazy<Mutex<HashMap<String, TerminalSession>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

struct TerminalSession {
    id: String,
    title: String,
    created_at: i64,
}

/// Return a full terminal panel snapshot (sessions list + active session ID).
pub fn ensure_terminal_panel(workspace_id: &str, root_key: &str) -> serde_json::Value {
    let sessions = TERMINAL_SESSIONS.lock().unwrap();
    let session_list: Vec<serde_json::Value> = sessions
        .values()
        .map(|s| {
            json!({
                "id": s.id,
                "title": s.title,
                "createdAt": s.created_at,
            })
        })
        .collect();
    json!({
        "workspaceId": workspace_id,
        "rootKey": root_key,
        "activeSessionId": session_list
            .first()
            .and_then(|s| s["id"].as_str().map(String::from))
            .unwrap_or_default(),
        "sessions": session_list,
    })
}

/// Create a new terminal session and return its descriptor.
pub fn create_terminal_session(workspace_id: &str, terminal_scope_id: &str) -> serde_json::Value {
    let id = format!("term-{}", chrono::Utc::now().timestamp_millis());
    let session = TerminalSession {
        id: id.clone(),
        title: "zsh".into(),
        created_at: chrono::Utc::now().timestamp_millis(),
    };
    TERMINAL_SESSIONS.lock().unwrap().insert(id.clone(), session);
    json!({
        "terminalId": id,
        "title": "zsh",
    })
}
