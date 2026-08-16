//! Project trust — delegates to pi-rs `TrustManager` (trust.json in the agent
//! dir). `Some(true)` = trusted, `Some(false)` = ignored, `None` = unset.

use pi_coding_agent::config;
use pi_coding_agent::core::trust_manager::ProjectTrustStore as TrustManager;
use serde_json::{json, Value};

fn trust_manager() -> TrustManager {
    TrustManager::new(&config::get_agent_dir().to_string_lossy())
}

/// Current trust decision for `cwd` (walks up parent dirs like pi-rs).
pub fn get_project_trust(cwd: &str) -> Value {
    let decision = trust_manager().get(cwd);
    json!({ "cwd": cwd, "decision": decision })
}

/// Set (or clear) the trust decision for `cwd`.
pub fn set_project_trust(cwd: &str, decision: Option<bool>) -> Value {
    trust_manager().set(cwd, decision);
    json!({ "cwd": cwd, "decision": decision })
}

