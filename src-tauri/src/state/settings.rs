//! General settings — reads/writes delegate to pi-rs `SettingsManager`
//! (same settings.json the agent sessions read), so the GUI never forks its
//! own config format.

use pi_coding_agent::config;
use pi_coding_agent::core::settings_manager::{
    CacheWarmingMode, DefaultProjectTrust, FollowUpMode, SettingsManager, SteeringMode,
    TransportSetting,
};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};

fn parse<T: DeserializeOwned>(value: &Value, key: &str) -> Result<T, String> {
    serde_json::from_value(value.clone()).map_err(|e| format!("invalid {key}: {e}"))
}

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
            "defaultThinkingLevel": s.default_thinking_level.clone().unwrap_or_else(|| "medium".to_string()),
            "compactionEnabled": mgr.get_compaction_enabled(),
            "compactionReserveTokens": mgr.get_compaction_reserve_tokens(),
            "compactionKeepRecentTokens": mgr.get_compaction_keep_recent_tokens(),
            "retryEnabled": mgr.get_retry_enabled(),
            "hideThinkingBlock": mgr.get_hide_thinking_block(),
            "shellPath": s.shell_path.clone(),
            "quietStartup": mgr.get_quiet_startup(),
            "theme": mgr.get_theme().map(|t| t.to_string()),
            "enableSkillCommands": mgr.get_enable_skill_commands(),
            "skillPaths": mgr.get_skills(),
            "promptPaths": mgr.get_prompts(),
            "steeringMode": mgr.get_steering_mode(),
            "followUpMode": mgr.get_follow_up_mode(),
            "transport": mgr.get_transport(),
            "cacheWarming": mgr.get_cache_warming_mode(),
            "showCacheMissNotices": mgr.get_show_cache_miss_notices(),
            "externalEditor": mgr.get_external_editor_command(),
            "defaultProjectTrust": mgr.get_default_project_trust(),
            "shellCommandPrefix": mgr.get_shell_command_prefix(),
            "npmCommand": mgr.get_npm_command(),
            "collapseChangelog": mgr.get_collapse_changelog(),
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
            "enableSkillCommands" => {
                mgr.set_enable_skill_commands(
                    value.as_bool().ok_or("enableSkillCommands must be a bool")?,
                );
            }
            "skillPaths" => {
                let paths = value
                    .as_array()
                    .ok_or("skillPaths must be an array of strings")?
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                mgr.set_skills(paths);
            }
            "promptPaths" => {
                let paths = value
                    .as_array()
                    .ok_or("promptPaths must be an array of strings")?
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect::<Vec<_>>();
                mgr.set_prompts(paths);
            }
            "steeringMode" => {
                mgr.set_steering_mode(parse::<SteeringMode>(&value, key)?);
            }
            "followUpMode" => {
                mgr.set_follow_up_mode(parse::<FollowUpMode>(&value, key)?);
            }
            "transport" => {
                mgr.set_transport(parse::<TransportSetting>(&value, key)?);
            }
            "cacheWarming" => {
                mgr.set_cache_warming_mode(parse::<CacheWarmingMode>(&value, key)?);
            }
            "compactionReserveTokens" => {
                let tokens = value
                    .as_u64()
                    .ok_or("compactionReserveTokens must be a number")?;
                let mut compaction = mgr.get_compaction_settings();
                compaction.reserve_tokens = Some(tokens);
                mgr.set_global(
                    "compaction",
                    serde_json::to_value(compaction).map_err(|e| e.to_string())?,
                );
            }
            "compactionKeepRecentTokens" => {
                let tokens = value
                    .as_u64()
                    .ok_or("compactionKeepRecentTokens must be a number")?;
                let mut compaction = mgr.get_compaction_settings();
                compaction.keep_recent_tokens = Some(tokens);
                mgr.set_global(
                    "compaction",
                    serde_json::to_value(compaction).map_err(|e| e.to_string())?,
                );
            }
            "showCacheMissNotices" => {
                mgr.set_show_cache_miss_notices(
                    value
                        .as_bool()
                        .ok_or("showCacheMissNotices must be a bool")?,
                );
            }
            "externalEditor" => {
                let editor = value
                    .as_str()
                    .map(str::to_string)
                    .filter(|s| !s.trim().is_empty());
                mgr.set_global("externalEditor", json!(editor));
            }
            "defaultProjectTrust" => {
                mgr.set_default_project_trust(parse::<DefaultProjectTrust>(&value, key)?);
            }
            "shellCommandPrefix" => {
                let prefix = value
                    .as_str()
                    .map(str::to_string)
                    .filter(|s| !s.trim().is_empty());
                mgr.set_shell_command_prefix(prefix);
            }
            "collapseChangelog" => {
                mgr.set_collapse_changelog(
                    value
                        .as_bool()
                        .ok_or("collapseChangelog must be a bool")?,
                );
            }
            _ => return Err(format!("unknown setting '{key}'")),
        }
        Ok(())
    })
}

