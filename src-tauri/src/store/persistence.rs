//! State persistence — mirrors original `app-store-persistence.ts`.
//! Persists/restores UI state to ~/.pi/agent/ui-state.json.

use std::path::PathBuf;
use crate::store::internal::DesktopState;

fn get_state_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    let dir = PathBuf::from(&home).join(".pi").join("agent");
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("ui-state.json"))
}

/// Persist current state to disk. Best-effort (swallows errors like original).
pub fn persist_state(state: &DesktopState) {
    if let Some(path) = get_state_path() {
        if let Ok(json) = serde_json::to_string_pretty(state) {
            let _ = std::fs::write(&path, &json);
        }
    }
}

/// Restore previously persisted state. Returns empty object on failure.
pub fn restore_state() -> DesktopState {
    get_state_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| serde_json::json!({}))
}
