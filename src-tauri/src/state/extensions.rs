//! Extension listing — Rust static extensions registered into the agent runtime.
//!
//! pi-rs does **not** load TS/JS extensions (no JS runtime; see
//! EXTENSION_LOADING_FEASIBILITY.md in pi-rs). The only extensions the
//! runtime knows are Rust extensions registered via `ExtensionRegistry`,
//! mirroring pi-cli's wiring of `pi_extensions::goal` / `subagent`.
//!
//! This module owns the single `build_default_registry()` helper so the
//! Extensions view always reflects exactly what agent sessions get.

use std::collections::BTreeMap;

use pi_coding_agent::core::extensions::{create_builtin_source_info, ExtensionRegistry};
use serde_json::{json, Value};

/// Build the registry with the static Rust extensions the GUI wires into every
/// agent session. Keep in sync with `Store::build_runtime_factory`.
pub fn build_default_registry() -> ExtensionRegistry {
    let mut reg = ExtensionRegistry::new();
    reg.register(
        Box::new(pi_extensions::goal::GoalExtension::new()),
        create_builtin_source_info("goal"),
    );
    reg
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
pub fn list_extensions() -> Vec<Value> {
    let reg = build_default_registry();

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
