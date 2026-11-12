//! Extension listing — Rust static extensions registered into the agent runtime.
//!
//! pi-rs does **not** load TS MIT extensions (no JS runtime; see
//! EXTENSION_LOADING_FEASIBILITY.md in pi-rs). The only extensions the
//! runtime knows are the built-in Rust extensions registered by
//! `pi_coding_agent::core::extensions::builtin_extension_registry`
//! (subagent / web_search).
//!
//! Since pi-rs v1.83.15 built-ins are **opt-in** via settings
//! `extensionsEnabled`; this module mirrors that policy so the Extensions
//! view reflects exactly what agent sessions get.

use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::HashMap;
use std::collections::HashMap as Map;

use pi_coding_agent::config;
use pi_coding_agent::core::extensions::{
    builtin_extension_registry, ExtensionRegistry, BUILTIN_EXTENSION_IDS,
};
use pi_coding_agent::core::settings_manager::SettingsManager;
use serde_json::{json, Value};

/// Build a registry for an explicit `extensionsEnabled` map (no settings read).
#[cfg(test)]
fn registry_for(enabled: &HashMap<String, bool>) -> ExtensionRegistry {
    builtin_extension_registry(true, enabled, &Default::default()).unwrap_or_default()
}

/// Derive the extension name from a stamped `<builtin:name>` source path.
fn extension_name(source_path: &str) -> String {
    source_path
        .trim_start_matches("<builtin:")
        .trim_end_matches('>')
        .to_string()
}

/// Summarize the registered extensions for the frontend: one entry per
/// extension, with the tools and slash commands it contributes.
///
/// Built-ins are opt-in, but the view lists **all** of them with an
/// `enabled` flag so the user can turn them on/off. The registry is built
/// with every id enabled to discover each extension's tools/commands.
pub fn list_extensions() -> Vec<Value> {
    let agent_dir = config::get_agent_dir();
    let mgr = SettingsManager::create(
        agent_dir.to_string_lossy().as_ref(),
        Some(agent_dir.to_string_lossy().as_ref()),
    );
    let enabled = mgr.get_extensions_enabled();
    let all_enabled: Map<String, bool> = BUILTIN_EXTENSION_IDS
        .iter()
        .map(|id| ((*id).to_string(), true))
        .collect();
    let registry = builtin_extension_registry(
        true,
        &all_enabled,
        &mgr.get_web_search_config(),
    )
    .unwrap_or_default();

    let mut items = summarize(&registry);
    for item in &mut items {
        let name = item["name"].as_str().unwrap_or("");
        item["enabled"] = json!(enabled.get(name).copied().unwrap_or(false));
    }
    items
}

/// Toggle one built-in extension. Persists `extensionsEnabled` through the
/// same `SettingsManager` the agent reads; sessions pick it up on the next
/// actor restart.
pub fn set_extension_enabled(name: &str, enabled: bool) -> Result<(), String> {
    if !BUILTIN_EXTENSION_IDS.contains(&name) {
        return Err(format!("unknown built-in extension '{name}'"));
    }
    let agent_dir = config::get_agent_dir();
    let mut mgr = SettingsManager::create(
        agent_dir.to_string_lossy().as_ref(),
        Some(agent_dir.to_string_lossy().as_ref()),
    );
    let mut map = mgr.get_extensions_enabled();
    map.insert(name.to_string(), enabled);
    mgr.set_global("extensionsEnabled", json!(map));
    Ok(())
}

/// One entry per registered extension, with the tools and slash commands it
/// contributes.
fn summarize(reg: &ExtensionRegistry) -> Vec<Value> {
    let mut tools: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut commands: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();

    for tool in reg.tools() {
        let name = extension_name(&tool.source_info.path);
        tools.entry(name).or_default().push(tool.name.clone());
    }
    for cmd in reg.commands() {
        let name = extension_name(&cmd.source_info.path);
        commands
            .entry(name)
            .or_default()
            .push((cmd.name.clone(), cmd.description.clone()));
    }

    let mut names: Vec<String> = tools.keys().chain(commands.keys()).cloned().collect();
    names.sort();
    names.dedup();

    names
        .into_iter()
        .map(|name| {
            json!({
                "name": name,
                "location": "builtin",
                "tools": tools.get(&name).cloned().unwrap_or_default(),
                "commands": commands
                    .get(&name)
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|(n, d)| json!({"name": n, "description": d}))
                    .collect::<Vec<_>>(),
            })
        })
        .collect()
}

/// Get a single extension by name.
pub fn get_extension(name: &str) -> Option<Value> {
    list_extensions().into_iter().find(|e| e["name"] == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Enabled built-ins are listed and flagged as builtin.
    #[test]
    fn lists_enabled_builtin_extensions() {
        let enabled: HashMap<String, bool> = pi_coding_agent::core::extensions::BUILTIN_EXTENSION_IDS
            .iter()
            .map(|id| ((*id).to_string(), true))
            .collect();
        let ext = summarize(&registry_for(&enabled));
        let names: Vec<&str> = ext.iter().map(|e| e["name"].as_str().unwrap()).collect();
        for expected in ["subagent", "web_search"] {
            assert!(
                names.contains(&expected),
                "missing builtin extension {expected:?}; got {names:?}"
            );
        }
        // every listed extension must be flagged builtin
        for e in &ext {
            assert_eq!(e["location"], "builtin");
        }
    }

    /// Opt-in policy: missing ids register nothing.
    #[test]
    fn disabled_builtins_are_not_listed() {
        assert!(summarize(&registry_for(&HashMap::new())).is_empty());
    }
}
