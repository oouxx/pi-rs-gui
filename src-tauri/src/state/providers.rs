//! Custom provider management — mirrors custom provider parts of `app-store.ts`.

use serde_json::json;
use pi_coding_agent::config;

/// List custom providers from ~/.pi-rs/agent/models.json
pub fn list_custom_providers() -> Vec<serde_json::Value> {
    let path = config::get_models_path();
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let root: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    root.as_object()
        .map(|obj| {
            obj.values()
                .filter_map(|v| v.as_array())
                .flatten()
                .filter_map(|entry| {
                    let provider = entry["provider"].as_str()?;
                    Some(json!({
                        "id": entry["id"].as_str().unwrap_or(""),
                        "provider": provider,
                        "api": entry["api"].as_str().unwrap_or(""),
                        "baseUrl": entry["baseUrl"].as_str().unwrap_or(""),
                        "name": entry["name"].as_str().unwrap_or(provider),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

pub fn probe_custom_provider_models() -> serde_json::Value {
    json!({"ok": false, "error": "not available"})
}
