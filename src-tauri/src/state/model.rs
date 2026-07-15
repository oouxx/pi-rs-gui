//! Model/provider settings — delegates to pi-rs SettingsManager for persistence.

use crate::state::DesktopState;
use serde_json::json;

/// Persist global settings to disk via pi-coding-agent's SettingsManager.
fn with_settings_mgr<F>(f: F)
where
    F: FnOnce(&mut pi_coding_agent::core::settings_manager::SettingsManager),
{
    let agent_dir = pi_coding_agent::config::get_agent_dir();
    let mut mgr = pi_coding_agent::core::settings_manager::SettingsManager::create(
        agent_dir.to_string_lossy().as_ref(),
        Some(agent_dir.to_string_lossy().as_ref()),
    );
    f(&mut mgr);
}

pub fn set_default_model(state: &mut DesktopState, provider: &str, model_id: &str) {
    // Update in-memory state
    state.global_model_settings.default_provider = Some(provider.to_string());
    state.global_model_settings.default_model_id = Some(model_id.to_string());
    // Persist via pi-rs SettingsManager
    with_settings_mgr(|mgr| {
        mgr.set_global("defaultProvider", json!(provider));
        mgr.set_global("defaultModel", json!(model_id));
    });
}

pub fn set_default_thinking_level(state: &mut DesktopState, level: &str) {
    // Update in-memory state
    state.global_model_settings.default_thinking_level = Some(level.to_string());
    // Persist via pi-rs SettingsManager
    with_settings_mgr(|mgr| {
        mgr.set_global("thinkingLevel", json!(level));
    });
}

pub fn get_default_model(state: &DesktopState) -> serde_json::Value {
    json!({
        "defaultProvider": state.global_model_settings.default_provider.as_deref().unwrap_or(""),
        "defaultModelId": state.global_model_settings.default_model_id.as_deref().unwrap_or(""),
        "defaultThinkingLevel": state.global_model_settings.default_thinking_level.as_deref().unwrap_or("normal"),
    })
}
