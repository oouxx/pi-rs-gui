//! Skill CRUD.
//!
//! Delegates to pi-rs `skills::load_skills()` for discovery and parsing, and
//! to pi-rs `SettingsManager` for the configured custom skill paths — this GUI
//! layer only maps results to the shape the frontend expects.

use pi_coding_agent::config;
use pi_coding_agent::core::settings_manager::SettingsManager;
use pi_coding_agent::core::skills::{load_skills, LoadSkillsOptions, Skill};
use pi_coding_agent::core::source_info::SourceScope;
use serde_json::{json, Value};

/// Custom skill paths from settings.json (mirrors TS `getSkillPaths()`).
fn configured_skill_paths() -> Vec<String> {
    let agent_dir = config::get_agent_dir();
    let mgr = SettingsManager::create(
        agent_dir.to_string_lossy().as_ref(),
        Some(agent_dir.to_string_lossy().as_ref()),
    );
    mgr.get_skills()
}

/// Map a pi-rs source scope to the frontend category.
fn skill_scope(scope: &SourceScope) -> &'static str {
    match scope {
        SourceScope::User => "global",
        SourceScope::Project => "workspace",
        SourceScope::Temporary => "custom",
    }
}

fn skill_json(skill: &Skill) -> Value {
    json!({
        "name": skill.name,
        "description": skill.description,
        "filePath": skill.file_path,
        "baseDir": skill.base_dir,
        "scope": skill_scope(&skill.source_info.scope),
        "disableModelInvocation": skill.disable_model_invocation,
    })
}

/// List all discoverable skills (global, workspace, and configured paths),
/// sorted by scope then name for a stable UI.
pub fn list_skills(cwd: &str) -> Vec<Value> {
    let agent_dir = config::get_agent_dir().to_string_lossy().to_string();
    let result = load_skills(&LoadSkillsOptions {
        cwd: cwd.to_string(),
        agent_dir: Some(agent_dir),
        skill_paths: configured_skill_paths(),
        include_defaults: true,
    });
    let mut skills: Vec<Value> = result.skills.iter().map(skill_json).collect();
    skills.sort_by(|a, b| {
        a["scope"]
            .as_str()
            .cmp(&b["scope"].as_str())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    skills
}

/// Get a single skill by name.
pub fn get_skill(cwd: &str, name: &str) -> Option<Value> {
    list_skills(cwd).into_iter().find(|s| s["name"] == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_skill_scope_mapping() {
        assert_eq!(skill_scope(&SourceScope::User), "global");
        assert_eq!(skill_scope(&SourceScope::Project), "workspace");
        assert_eq!(skill_scope(&SourceScope::Temporary), "custom");
    }
}
