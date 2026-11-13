//! State persistence — active session ID + scoped-model patterns.

use crate::state::DesktopState;
use serde_json::{json, Value};
use std::path::PathBuf;

/// `ui-state.json` lives next to pi-rs's own state files. Resolve the agent
/// dir through pi-rs so env/dir overrides are honored (never hardcode `$HOME`).
fn get_state_path() -> Option<PathBuf> {
    let dir = pi_coding_agent::config::get_agent_dir();
    if let Err(error) = std::fs::create_dir_all(&dir) {
        eprintln!("[ui-state] cannot create {}: {error}", dir.display());
        return None;
    }
    Some(dir.join("ui-state.json"))
}

/// Persist the active session ID and the scoped-model patterns used for
/// Ctrl/Cmd+P cycling (pi-rs has no settings key for the latter).
pub fn persist_state(state: &DesktopState) {
    if let Some(path) = get_state_path() {
        let slim = json!({
            "selectedSessionId": state.selected_session_id,
            "enabledModelPatterns": state.global_model_settings.enabled_model_patterns,
        });
        match serde_json::to_string_pretty(&slim) {
            Ok(json) => {
                if let Err(error) = std::fs::write(&path, &json) {
                    eprintln!("[ui-state] cannot write {}: {error}", path.display());
                }
            }
            Err(error) => eprintln!("[ui-state] cannot serialize state: {error}"),
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
        if let Some(patterns) = p["enabledModelPatterns"].as_array() {
            state.global_model_settings.enabled_model_patterns = patterns
                .iter()
                .filter_map(|value| value.as_str().map(str::to_string))
                .collect();
        }
    }
    state
}
