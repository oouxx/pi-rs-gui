//! State persistence — mirrors original `app-store-persistence.ts`.
//! Persists/restores UI state to ~/.pi-rs/agent/ui-state.json.

use std::path::PathBuf;
use serde_json::Value;
use crate::state::internal::{DesktopState, default_state};

/// Agent config directory root used by pi-rs (`~/.pi-rs/agent/`).
fn agent_dir() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(&home).join(".pi-rs").join("agent"))
}

fn get_state_path() -> Option<PathBuf> {
    let dir = agent_dir()?;
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

/// Deep-merge `patch` into `base`, returning a new Value.
/// `patch`'s fields win; if both sides are objects the merge is recursive.
fn merge_into(base: &Value, patch: &Value) -> Value {
    match (base, patch) {
        (Value::Object(a), Value::Object(b)) => {
            let mut out = a.clone();
            for (k, v) in b {
                out.insert(k.clone(), merge_into(a.get(k).unwrap_or(&Value::Null), v));
            }
            Value::Object(out)
        }
        _ => patch.clone(),
    }
}

/// Restore previously persisted state, merged on top of a fresh default
/// skeleton so missing keys don't break the app.
/// Returns the full skeleton when no persisted file exists yet.
pub fn restore_state() -> DesktopState {
    let skeleton = default_state();
    let persisted: Option<Value> = get_state_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok());
    match persisted {
        Some(p) => merge_into(&skeleton, &p),
        None => skeleton,
    }
}
