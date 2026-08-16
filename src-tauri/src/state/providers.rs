//! Custom provider CRUD — manages ~/.pi-rs/agent/models.json for custom
//! (user-added) AI providers, and reads built-in provider key status.
//!
//! Provider API keys are persisted via pi-rs `AuthStorage` (auth.json), which
//! the agent sessions already read by default — no env-var hacks needed.

use pi_coding_agent::config;
use pi_coding_agent::core::auth_storage::{AuthCredential, AuthStorage};
use serde_json::{json, Map, Value};

/// Build an `AuthStorage` backed by the agent auth.json. pi-rs sessions are
/// created with `auth_storage: None`, which makes them default to this same
/// file, so keys stored here are picked up automatically.
fn auth_storage() -> AuthStorage {
    let path = config::get_agent_dir().join("auth.json");
    AuthStorage::create(path)
}

/// Read the raw custom models.json as a map of provider arrays.
fn read_models_map() -> Map<String, Value> {
    let path = config::get_models_path();
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str::<Value>(&c).ok())
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// Write the map back to models.json.
fn write_models_map(map: &Map<String, Value>) {
    let path = config::get_models_path();
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let content = serde_json::to_string_pretty(map).unwrap_or_default();
    let _ = std::fs::write(&path, &content);
}

/// List custom providers from ~/.pi-rs/agent/models.json
// TODO: delegate to pi-rs once it provides a custom provider CRUD API
pub fn list_custom_providers() -> Vec<Value> {
    let map = read_models_map();
    map.values()
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
}

/// Get a single custom provider by ID.
pub fn get_custom_provider(provider_id: &str) -> Option<Value> {
    list_custom_providers()
        .into_iter()
        .find(|p| p["id"].as_str() == Some(provider_id))
}

/// Create or update a custom provider. Merges the entry into models.json
/// under the provider key (kebab-case provider ID). Returns the updated provider.
pub fn set_custom_provider(config: &Value) -> Result<Value, String> {
    let provider_id = config["id"]
        .as_str()
        .ok_or("missing provider id")?
        .to_string();
    let provider = config["provider"].as_str().ok_or("missing provider")?;
    let entry = json!({
        "id": provider_id,
        "provider": provider,
        "api": config["api"].as_str().unwrap_or("openai-completions"),
        "baseUrl": config["baseUrl"].as_str().unwrap_or(""),
        "name": config["name"].as_str().unwrap_or(&provider_id),
        "apiKeyEnvVar": config["apiKeyEnvVar"].as_str().unwrap_or(""),
    });

    let mut map = read_models_map();
    let arr = map
        .entry(provider.to_string())
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or("invalid models.json format")?;

    // Replace existing entry with same id, or append
    if let Some(pos) = arr.iter().position(|e| e["id"] == provider_id) {
        arr[pos] = entry.clone();
    } else {
        arr.push(entry.clone());
    }
    write_models_map(&map);
    Ok(entry)
}

/// Delete a custom provider by ID.
pub fn delete_custom_provider(provider_id: &str) -> Result<(), String> {
    let mut map = read_models_map();
    let mut found = false;
    for (_key, arr_val) in map.iter_mut() {
        if let Some(arr) = arr_val.as_array_mut() {
            let before = arr.len();
            arr.retain(|e| e["id"].as_str() != Some(provider_id));
            if arr.len() != before {
                found = true;
            }
        }
    }
    if !found {
        return Err(format!("provider '{provider_id}' not found"));
    }
    write_models_map(&map);
    Ok(())
}

/// Check if a provider has authentication configured (stored in auth.json,
/// set at runtime, or via env var). Delegates to pi-rs `AuthStorage`.
pub fn has_provider_auth(provider_id: &str) -> bool {
    auth_storage().has_auth(provider_id)
}

/// Set a provider's API key. Persists via pi-rs `AuthStorage` to auth.json
/// (survives restarts). Returns the env var name used for display.
pub fn set_provider_api_key(provider_id: &str, api_key: &str) -> Result<String, String> {
    let var_name = pi_ai::env_api_keys::get_env_var_name(provider_id)
        .ok_or_else(|| format!("unknown provider '{provider_id}'"))?;
    let mut storage = auth_storage();
    storage.set(provider_id, AuthCredential::ApiKey {
        key: Some(api_key.to_string()),
        env: None,
    });
    Ok(var_name.to_string())
}

/// Remove a provider's stored API key from auth.json.
pub fn clear_provider_auth(provider_id: &str) {
    let mut storage = auth_storage();
    storage.remove(provider_id);
}

