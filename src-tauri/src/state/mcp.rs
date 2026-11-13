//! MCP server management.
//!
//! Config CRUD is delegated to pi-rs `core::mcp_config` (the same files the
//! TUI `/mcp` manager and `pi-rs mcp` CLI write); live connection state and
//! tools come from the selected session's `McpServerConnection`s. The GUI
//! never re-implements the MCP transport or config format.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use pi_coding_agent::config;
use pi_coding_agent::core::mcp_config::{self, McpServerConfigPatch};
use pi_coding_agent::core::mcp_oauth::{
    self, McpOAuthCredentialStore, McpOAuthSettings, McpSignInPrompt,
};
use pi_coding_agent::core::mcp_servers::{
    global_config_path, project_config_path, validate_mcp_server_config, LoadedServer, McpExposure,
    McpScope,
};
use serde_json::{json, Value};

fn agent_dir() -> String {
    config::get_agent_dir().to_string_lossy().to_string()
}

fn path_for_scope(scope: &str, cwd: &str, agent: &str) -> Result<std::path::PathBuf, String> {
    match scope {
        "global" => Ok(global_config_path(Path::new(agent))),
        "project" => Ok(project_config_path(Path::new(cwd))),
        other => Err(format!("unknown MCP scope '{other}'")),
    }
}

fn find_server<'a>(servers: &'a [LoadedServer], name: &str) -> Option<&'a LoadedServer> {
    servers.iter().find(|server| server.name == name)
}

/// Serializable snapshot of one configured server (config + runtime fields).
fn server_json(server: &LoadedServer) -> Value {
    json!({
        "name": server.name,
        "scope": server.scope.as_str(),
        "source": server.source.to_string_lossy(),
        "overridePath": server
            .override_path
            .as_ref()
            .map(|path| path.to_string_lossy().to_string()),
        "enabled": server.is_enabled(),
        "exposure": server.exposure().to_string(),
        "transport": if server.config.is_stdio() { "stdio" } else { "http" },
        "description": &server.config.description,
        "command": &server.config.command,
        "args": &server.config.args,
        "url": &server.config.url,
        "timeout": server.config.timeout,
        // Raw config round-trips through the edit dialog so fields the GUI does
        // not model (toolExposure, oauth, auth) are preserved on save.
        "config": serde_json::to_value(&server.config).unwrap_or_else(|_| json!({})),
        // Runtime fields, filled from the live session snapshot below.
        "status": if server.is_enabled() { "not-loaded" } else { "disabled" },
        "tools": [],
        "hasResources": false,
    })
}

/// Load configured servers and overlay live state from the selected session.
///
/// `runtime` is the `GetMcpSnapshot` payload (name/state/error/tools/…).
pub fn list_servers(cwd: &str, runtime: &[Value]) -> Value {
    list_servers_in(cwd, &agent_dir(), runtime)
}

fn list_servers_in(cwd: &str, agent: &str, runtime: &[Value]) -> Value {
    let loaded = mcp_config::load_mcp_config(cwd, agent);
    let servers: Vec<Value> = loaded
        .servers
        .iter()
        .map(|server| {
            let mut item = server_json(server);
            if let Some(live) = runtime.iter().find(|entry| {
                entry.get("name").and_then(Value::as_str) == Some(server.name.as_str())
            }) {
                item["status"] = live["state"].clone();
                item["tools"] = live["tools"].clone();
                item["hasResources"] = live["hasResources"].clone();
                if let Some(error) = live.get("error") {
                    item["error"] = error.clone();
                }
                if let Some(instructions) = live.get("instructions") {
                    item["instructions"] = instructions.clone();
                }
            }
            item
        })
        .collect();

    json!({
        "servers": servers,
        "errors": loaded.errors,
        "globalConfigPath": global_config_path(Path::new(agent)).to_string_lossy(),
        "projectConfigPath": project_config_path(Path::new(cwd)).to_string_lossy(),
        "agentDir": agent,
        "cwd": cwd,
    })
}

/// Add or replace a server. Existing servers are written back to the file
/// that defines them; new servers go to the requested scope.
pub fn save_server(name: &str, config: &Value, scope: &str, cwd: &str) -> Result<(), String> {
    save_server_in(name, config, scope, cwd, &agent_dir())
}

fn save_server_in(
    name: &str,
    config: &Value,
    scope: &str,
    cwd: &str,
    agent: &str,
) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Server name is required".to_string());
    }
    validate_mcp_server_config(name, config)?;

    let loaded = mcp_config::load_mcp_config(cwd, agent);
    let path = match find_server(&loaded.servers, name) {
        Some(server) => {
            if server.scope == McpScope::Extension {
                return Err(format!(
                    "MCP server \"{name}\" is provided by an extension and cannot be edited here"
                ));
            }
            server.source.clone()
        }
        None => path_for_scope(scope, cwd, agent)?,
    };

    // pi-rs only allows provider-token auth in the global config (project
    // entries are untrusted overrides in the TS original).
    if path == project_config_path(Path::new(cwd)) && config.get("auth").is_some() {
        return Err(
            "Project MCP config cannot set \"auth\"; move it to the global mcp.json".to_string(),
        );
    }

    mcp_config::add_server(&path, name, config)?;
    Ok(())
}

/// Remove a server from both config files. Returns the files it was removed
/// from (empty when unknown).
pub fn delete_server(name: &str, cwd: &str) -> Result<Vec<String>, String> {
    delete_server_in(name, cwd, &agent_dir())
}

fn delete_server_in(name: &str, cwd: &str, agent: &str) -> Result<Vec<String>, String> {
    let loaded = mcp_config::load_mcp_config(cwd, agent);
    let server = find_server(&loaded.servers, name)
        .ok_or_else(|| format!("MCP server \"{name}\" not found"))?;
    if server.scope == McpScope::Extension {
        return Err(format!(
            "MCP server \"{name}\" is provided by an extension and cannot be deleted here"
        ));
    }

    let mut removed = Vec::new();
    for path in [
        global_config_path(Path::new(agent)),
        project_config_path(Path::new(cwd)),
    ] {
        if mcp_config::remove_server(&path, name)? {
            removed.push(path.to_string_lossy().to_string());
        }
    }
    Ok(removed)
}

/// Update `enabled` / `exposure`. Like the TUI manager, toggles for a global
/// server that has a project override are written to the override file.
pub fn update_server(
    name: &str,
    enabled: Option<bool>,
    exposure: Option<&str>,
    cwd: &str,
) -> Result<(), String> {
    update_server_in(name, enabled, exposure, cwd, &agent_dir())
}

fn update_server_in(
    name: &str,
    enabled: Option<bool>,
    exposure: Option<&str>,
    cwd: &str,
    agent: &str,
) -> Result<(), String> {
    let loaded = mcp_config::load_mcp_config(cwd, agent);
    let server = find_server(&loaded.servers, name)
        .ok_or_else(|| format!("MCP server \"{name}\" not found"))?;
    if server.scope == McpScope::Extension {
        return Err(format!(
            "MCP server \"{name}\" is provided by an extension and cannot be changed here"
        ));
    }

    let exposure = match exposure {
        Some(value) => Some(
            McpExposure::parse(value).ok_or_else(|| format!("unknown MCP exposure '{value}'"))?,
        ),
        None => None,
    };
    let patch = McpServerConfigPatch { enabled, exposure };
    let path = server
        .override_path
        .clone()
        .unwrap_or_else(|| server.source.clone());
    mcp_config::update_server(&path, name, &patch, server.override_path.is_some())?;
    Ok(())
}

/// Run the pi-rs OAuth sign-in flow for an HTTP MCP server.
///
/// The loopback callback handles the redirect on a local desktop; the pasted
/// -redirect fallback used by the TUI is left pending here.
pub async fn sign_in(name: &str, cwd: &str) -> Result<(), String> {
    let agent = agent_dir();
    let loaded = mcp_config::load_mcp_config(cwd, &agent);
    let server = find_server(&loaded.servers, name)
        .ok_or_else(|| format!("MCP server \"{name}\" not found"))?;
    if !mcp_oauth::server_uses_oauth(&server.config) {
        return Err(format!(
            "MCP server \"{name}\" does not use OAuth; only HTTP servers without an Authorization header do"
        ));
    }
    let raw_url = server
        .config
        .url
        .as_deref()
        .ok_or_else(|| format!("MCP server \"{name}\" has no URL"))?;
    let url = url::Url::parse(raw_url)
        .map_err(|error| format!("MCP server \"{name}\" has an invalid URL: {error}"))?;
    let settings = McpOAuthSettings::from_config(server.config.oauth.as_ref(), name)?;
    let store = McpOAuthCredentialStore::new(Path::new(&agent)).for_server(name, url.as_str());

    let prompt = McpSignInPrompt {
        show_authorization_url: Arc::new(move |authorization_url| {
            let _ = open::that(authorization_url.as_str());
        }),
        prompt_for_redirect_url: Arc::new(
            |_cancel| -> futures::future::BoxFuture<'static, Option<String>> {
                // The loopback callback server wins this select on a desktop.
                Box::pin(futures::future::pending())
            },
        ),
    };

    match tokio::time::timeout(
        Duration::from_secs(300),
        mcp_oauth::sign_in_mcp_server(&url, store, &settings, None, prompt, None),
    )
    .await
    {
        Err(_) => Err("MCP sign-in timed out after 300s".to_string()),
        Ok(Err(error)) => Err(error.to_string()),
        Ok(Ok(())) => Ok(()),
    }
}

/// Tail of `mcp.log` for one server (`notifications/message` lines).
pub fn read_log(name: &str, limit: usize) -> String {
    let path = config::get_agent_dir().join("mcp.log");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return String::new();
    };
    let needle = format!("[{name}]");
    let lines: Vec<&str> = text.lines().filter(|line| line.contains(&needle)).collect();
    let start = lines.len().saturating_sub(limit.max(1));
    lines[start..].join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loaded(name: &str, raw: Value) -> LoadedServer {
        LoadedServer {
            name: name.to_string(),
            config: validate_mcp_server_config(name, &raw).expect("valid config"),
            source: std::path::PathBuf::from("/tmp/mcp.json"),
            scope: McpScope::Global,
            override_path: None,
        }
    }

    #[test]
    fn server_json_exposes_transport_and_raw_config() {
        let server = loaded("fs", json!({"command": "npx", "args": ["-y", "server"]}));
        let value = server_json(&server);
        assert_eq!(value["transport"], "stdio");
        assert_eq!(value["status"], "not-loaded");
        assert_eq!(value["config"]["command"], "npx");
        assert_eq!(value["exposure"], "codemode");
    }

    #[test]
    fn project_crud_round_trip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path().join("project");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&cwd).expect("cwd");
        std::fs::create_dir_all(&agent).expect("agent");
        let cwd = cwd.to_string_lossy().to_string();
        let agent = agent.to_string_lossy().to_string();

        save_server_in(
            "mcp-gui-test",
            &json!({"command": "echo", "args": ["hi"]}),
            "project",
            &cwd,
            &agent,
        )
        .expect("save");

        let view = list_servers_in(&cwd, &agent, &[]);
        let entry = view["servers"]
            .as_array()
            .expect("servers")
            .iter()
            .find(|server| server["name"] == "mcp-gui-test")
            .cloned()
            .expect("saved server");
        assert_eq!(entry["enabled"], true);
        assert_eq!(entry["transport"], "stdio");
        assert_eq!(entry["scope"], "project");

        update_server_in("mcp-gui-test", Some(false), Some("direct"), &cwd, &agent)
            .expect("update");
        let view = list_servers_in(&cwd, &agent, &[]);
        let entry = view["servers"]
            .as_array()
            .expect("servers")
            .iter()
            .find(|server| server["name"] == "mcp-gui-test")
            .cloned()
            .expect("updated server");
        assert_eq!(entry["enabled"], false);
        assert_eq!(entry["exposure"], "direct");

        let removed = delete_server_in("mcp-gui-test", &cwd, &agent).expect("delete");
        assert_eq!(removed.len(), 1);
        let view = list_servers_in(&cwd, &agent, &[]);
        assert!(view["servers"]
            .as_array()
            .expect("servers")
            .iter()
            .all(|server| server["name"] != "mcp-gui-test"));
    }

    #[test]
    fn runtime_snapshot_overlays_live_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cwd = dir.path().join("project");
        let agent = dir.path().join("agent");
        std::fs::create_dir_all(&cwd).expect("cwd");
        std::fs::create_dir_all(&agent).expect("agent");
        let cwd = cwd.to_string_lossy().to_string();
        let agent = agent.to_string_lossy().to_string();

        save_server_in(
            "live",
            &json!({"url": "https://example.com/mcp", "exposure": "direct"}),
            "project",
            &cwd,
            &agent,
        )
        .expect("save");

        let runtime = vec![json!({
            "name": "live",
            "state": "connected",
            "error": null,
            "tools": [{"name": "search", "description": "Search"}],
            "hasResources": true,
            "instructions": "Use me",
        })];
        let view = list_servers_in(&cwd, &agent, &runtime);
        let entry = view["servers"]
            .as_array()
            .expect("servers")
            .iter()
            .find(|server| server["name"] == "live")
            .cloned()
            .expect("server");
        assert_eq!(entry["status"], "connected");
        assert_eq!(entry["tools"][0]["name"], "search");
        assert_eq!(entry["hasResources"], true);
        assert_eq!(entry["instructions"], "Use me");
        assert_eq!(entry["transport"], "http");
    }
}
