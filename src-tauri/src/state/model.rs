//! Model/provider settings — delegates to pi-rs SettingsManager for persistence.

use serde_json::json;
use crate::state::internal::DesktopState;

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
    state.runtime.settings.default_provider = Some(provider.to_string());
    state.runtime.settings.default_model_id = Some(model_id.to_string());
    state.global_model_settings.default_provider = Some(provider.to_string());
    state.global_model_settings.default_model_id = Some(model_id.to_string());
    // Persist via pi-rs SettingsManager
    with_settings_mgr(|mgr| {
        mgr.set_global("default_provider", json!(provider));
        mgr.set_global("default_model", json!(model_id));
    });
}

pub fn set_default_thinking_level(state: &mut DesktopState, level: &str) {
    // Update in-memory state
    state.runtime.settings.default_thinking_level = Some(level.to_string());
    state.global_model_settings.default_thinking_level = Some(level.to_string());
    // Persist via pi-rs SettingsManager
    with_settings_mgr(|mgr| {
        mgr.set_global("thinking_level", json!(level));
    });
}

pub fn set_model_settings_scope(state: &mut DesktopState, mode: &str) {
    state.model_settings_scope_mode = Some(mode.to_string());
}

pub fn get_default_model(state: &DesktopState) -> serde_json::Value {
    json!({
        "defaultProvider": state.runtime.settings.default_provider.as_deref().unwrap_or(""),
        "defaultModelId": state.runtime.settings.default_model_id.as_deref().unwrap_or(""),
        "defaultThinkingLevel": state.runtime.settings.default_thinking_level.as_deref().unwrap_or("normal"),
    })
}
