//! Skill CRUD.
//!
//! Delegates to pi-rs `skills::load_skills()` for discovery and parsing.

use pi_coding_agent::core::skills::{self, LoadSkillsOptions, LoadSkillsResult, Skill};

/// List all skills — merged from global agent dir and workspace dir.
/// Delegates to pi-rs `skills::load_skills()`.
pub fn list_skills(workspace_path: &str) -> LoadSkillsResult {
    let result = skills::load_skills(&LoadSkillsOptions {
        cwd: workspace_path.to_string(),
        include_defaults: true,
        ..Default::default()
    });
    result
}
