//! Custom provider management — mirrors custom provider parts of `app-store.ts`.

use serde_json::json;

/// List custom providers from ~/.pi/agent/models.json
pub fn list_custom_providers() -> Vec<serde_json::Value> {
    // ponytail: reads from models.json settings file; stub returns empty
    vec![]
}

pub fn probe_custom_provider_models() -> serde_json::Value {
    json!({"ok": false, "error": "not available"})
}
