//! General settings — reads/writes delegate to pi-rs `SettingsManager`
//! (same settings.json the agent sessions read), so the GUI never forks its
//! own config format.

use pi_coding_agent::config;
use pi_coding_agent::core::settings_manager::SettingsManager;
use serde_json::{json, Value};

fn with_mgr<F, R>(f: F) -> R
where
    F: FnOnce(&mut SettingsManager) -> R,
{
    let agent_dir = config::get_agent_dir();
    let mut mgr = SettingsManager::create(
        agent_dir.to_string_lossy().as_ref(),
        Some(agent_dir.to_string_lossy().as_ref()),
    );
    f(&mut mgr)
}

/// Snapshot of the general settings the General tab edits, plus read-only
/// environment info for the About tab.
pub fn get_general_settings() -> Value {
    with_mgr(|mgr| {
        let s = mgr.get_settings();
        json!({
            "defaultThinkingLevel": s.default_thinking_level.clone().unwrap_or_else(|| "normal".to_string()),
            "compactionEnabled": mgr.get_compaction_enabled(),
            "compactionReserveTokens": mgr.get_compaction_reserve_tokens(),
            "compactionKeepRecentTokens": mgr.get_compaction_keep_recent_tokens(),
            "retryEnabled": mgr.get_retry_enabled(),
            "hideThinkingBlock": mgr.get_hide_thinking_block(),
            "shellPath": s.shell_path.clone(),
            "quietStartup": mgr.get_quiet_startup(),
            "theme": mgr.get_theme().map(|t| t.to_string()),
            "paths": {
                "agentDir": config::get_agent_dir().to_string_lossy(),
                "settingsPath": config::get_settings_path().to_string_lossy(),
                "sessionsDir": config::get_sessions_dir().to_string_lossy(),
            },
            "version": env!("CARGO_PKG_VERSION"),
        })
    })
}

/// Apply one general setting and return the updated snapshot.
pub fn set_general_setting(key: &str, value: Value) -> Result<(), String> {
    with_mgr(|mgr| {
        match key {
            "defaultThinkingLevel" => {
                let level = value.as_str().ok_or("defaultThinkingLevel must be a string")?;
                mgr.set_default_thinking_level(level);
            }
            "compactionEnabled" => {
                mgr.set_compaction_enabled(value.as_bool().ok_or("compactionEnabled must be a bool")?);
            }
            "retryEnabled" => {
                mgr.set_retry_enabled(value.as_bool().ok_or("retryEnabled must be a bool")?);
            }
            "hideThinkingBlock" => {
                mgr.set_hide_thinking_block(value.as_bool().ok_or("hideThinkingBlock must be a bool")?);
            }
            "shellPath" => {
                let path = value
                    .as_str()
                    .map(|s| s.to_string())
                    .filter(|s| !s.trim().is_empty());
                mgr.set_shell_path(path);
            }
            "quietStartup" => {
                mgr.set_quiet_startup(value.as_bool().ok_or("quietStartup must be a bool")?);
            }
            "theme" => {
                mgr.set_theme(value.as_str().ok_or("theme must be a string")?);
            }
            _ => return Err(format!("unknown setting '{key}'")),
        }
        Ok(())
    })
}
