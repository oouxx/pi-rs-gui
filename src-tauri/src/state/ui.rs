//! State persistence — stores only the active session ID.

use std::path::PathBuf;
use serde_json::{json, Value};
use crate::state::DesktopState;

fn agent_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(&home).join(".pi-rs").join("agent"))
}

fn get_state_path() -> Option<PathBuf> {
    let dir = agent_dir()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("ui-state.json"))
}

/// Persist only the active session ID.
pub fn persist_state(state: &DesktopState) {
    if let Some(path) = get_state_path() {
        let slim = json!({
            "selectedSessionId": state.selected_session_id,
        });
        if let Ok(json) = serde_json::to_string_pretty(&slim) {
            let _ = std::fs::write(&path, &json);
        }
    }
}

/// Return a minimal state skeleton with the last active session ID restored.
pub fn restore_state() -> DesktopState {
    let persisted: Option<Value> = get_state_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    let mut state = crate::state::default_state();
    if let Some(p) = persisted {
        if let Some(sid) = p["selectedSessionId"].as_str().filter(|x| !x.is_empty()) {
            state.selected_session_id = sid.to_string();
        }
    }
    state
}
