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
///
/// pi-rs schema: `{ "providers": { "<provider>": { name, baseUrl, api,
/// apiKey, models: [{ id, name, ... }] } } }` (see pi-rs
/// `ModelRegistry::load_models_from_path`). The GUI writes this exact shape
/// so custom providers are actually picked up by the agent.
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

/// Access the `providers` object inside the models.json map.
fn providers_obj_mut(map: &mut Map<String, Value>) -> Option<&mut Map<String, Value>> {
    map.entry("providers".to_string())
        .or_insert_with(|| json!({}))
        .as_object_mut()
}

/// List custom providers from ~/.pi-rs/agent/models.json (pi-rs schema).
/// One entry per model under each provider.
// TODO: delegate to pi-rs once it provides a custom provider CRUD API
pub fn list_custom_providers() -> Vec<Value> {
    let map = read_models_map();
    let Some(providers) = map.get("providers").and_then(|v| v.as_object()) else {
        return vec![];
    };
    let mut out = Vec::new();
    for (provider, def) in providers {
        let api = def["api"].as_str().unwrap_or("openai-completions");
        let base_url = def["baseUrl"].as_str().unwrap_or("");
        let provider_name = def["name"].as_str().unwrap_or(provider);
        if let Some(models) = def["models"].as_array() {
            for m in models {
                out.push(json!({
                    "id": m["id"].as_str().unwrap_or(""),
                    "provider": provider,
                    "api": api,
                    "baseUrl": base_url,
                    "name": m["name"].as_str().unwrap_or(provider_name),
                }));
            }
        } else {
            out.push(json!({
                "id": provider,
                "provider": provider,
                "api": api,
                "baseUrl": base_url,
                "name": provider_name,
            }));
        }
    }
    out
}

/// Get a single custom provider by ID.
pub fn get_custom_provider(provider_id: &str) -> Option<Value> {
    list_custom_providers()
        .into_iter()
        .find(|p| p["id"].as_str() == Some(provider_id))
}

/// Create or update a custom provider. Merges the entry into models.json
/// under the pi-rs `providers` schema (provider object + models array).
/// Returns the updated provider.
pub fn set_custom_provider(config: &Value) -> Result<Value, String> {
    let model_id = config["id"]
        .as_str()
        .ok_or("missing provider id")?
        .to_string();
    let provider = config["provider"].as_str().ok_or("missing provider")?;
    let api = config["api"]
        .as_str()
        .unwrap_or("openai-completions")
        .to_string();
    let base_url = config["baseUrl"].as_str().unwrap_or("").to_string();
    let name = config["name"].as_str().unwrap_or(&model_id).to_string();
    let api_key = config["apiKeyEnvVar"].as_str().unwrap_or("").to_string();
    // pi-rs resolves `${ENV}` templates in the apiKey field at request time —
    // store the env-var reference, not the raw variable name.
    let api_key_field = if api_key.is_empty() {
        String::new()
    } else {
        format!("${{{api_key}}}")
    };

    let mut map = read_models_map();
    let providers = providers_obj_mut(&mut map).ok_or("invalid models.json format")?;
    let entry = providers
        .entry(provider.to_string())
        .or_insert_with(|| json!({}));
    let entry_obj = entry.as_object_mut().ok_or("invalid models.json format")?;
    entry_obj.insert("name".to_string(), json!(name));
    entry_obj.insert("baseUrl".to_string(), json!(base_url));
    entry_obj.insert("api".to_string(), json!(api));
    if !api_key_field.is_empty() {
        entry_obj.insert("apiKey".to_string(), json!(api_key_field));
    }
    // Merge the model into the provider's models array.
    let models = entry_obj
        .entry("models".to_string())
        .or_insert_with(|| json!([]));
    let models_arr = models.as_array_mut().ok_or("invalid models.json format")?;
    if let Some(pos) = models_arr.iter().position(|m| m["id"] == model_id) {
        models_arr[pos] = json!({ "id": model_id, "name": name });
    } else {
        models_arr.push(json!({ "id": model_id, "name": name }));
    }
    write_models_map(&map);
    Ok(json!({
        "id": model_id,
        "provider": provider,
        "api": api,
        "baseUrl": base_url,
        "name": name,
    }))
}

/// Delete a custom provider by ID (removes the model entry).
pub fn delete_custom_provider(provider_id: &str) -> Result<(), String> {
    let mut map = read_models_map();
    let mut found = false;
    if let Some(providers) = map.get_mut("providers").and_then(|v| v.as_object_mut()) {
        for (_key, def) in providers.iter_mut() {
            if let Some(models) = def.get_mut("models").and_then(|v| v.as_array_mut()) {
                let before = models.len();
                models.retain(|m| m["id"].as_str() != Some(provider_id));
                if models.len() != before {
                    found = true;
                }
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


#[cfg(test)]
mod smoke_tmp2 {
    use super::*;

    #[test]
    fn smoke_auth_after_set_key() {
        std::env::set_var("PI_CODING_AGENT_DIR", "/tmp/pi-gui-auth-smoke");
        // Use a provider whose env var is unset here so only auth.json counts.
        // (openrouter has OPENROUTER_API_KEY set in CI/dev shells, which would
        // make has_auth true even after clearing auth.json.)
        let provider = "anthropic";
        if std::env::var("ANTHROPIC_API_KEY").map(|v| !v.is_empty()).unwrap_or(false) {
            eprintln!("skipping: ANTHROPIC_API_KEY set in environment");
            return;
        }
        set_provider_api_key(provider, "sk-test-123").unwrap();
        assert!(has_provider_auth(provider), "stored key should count as auth");
        clear_provider_auth(provider);
        assert!(!has_provider_auth(provider), "after clear no auth");
    }
}
