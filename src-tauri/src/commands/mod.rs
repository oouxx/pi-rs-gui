use std::sync::Arc;

use crate::state::actor::SessionCommand;
use crate::state::*;
use crate::state::{mcp, model, providers, session, settings};
use pi_agent_core::pi_ai_types::ContentBlock;
use serde_json::json;
use tauri::{AppHandle, State};

// ── Core ──

#[tauri::command]
pub async fn get_state(store: State<'_, Arc<Store>>) -> Result<DesktopState, String> {
    Ok(store.state.lock().await.clone())
}

// ── Session CRUD ──

#[tauri::command]
pub async fn select_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<DesktopState, String> {
    store.select_session(&app, &session_id).await
}

#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    title: Option<String>,
    cwd: Option<String>,
) -> Result<DesktopState, String> {
    store
        .create_session_with_runtime(&app, title.as_deref(), cwd.as_deref())
        .await
}

#[tauri::command]
pub async fn archive_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<DesktopState, String> {
    // Destroy the session's actor (abort + remove from the registry).
    store.shutdown_actor(&session_id).await;
    let mut failure: Option<String> = None;
    let state = store
        .mutate(&app, |s| {
            if let Err(error) = session::archive_session_by_id(s, &session_id) {
                failure = Some(error);
            }
        })
        .await;
    if let Some(error) = failure {
        return Err(error);
    }
    // Ensure the newly selected session has an actor ready.
    store.ensure_selected_actor(&app).await.ok();
    Ok(state)
}

#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<DesktopState, String> {
    // Destroy the session's actor (abort + remove from the registry).
    store.shutdown_actor(&session_id).await;
    let mut failure: Option<String> = None;
    let state = store
        .mutate(&app, |s| {
            if let Err(error) = session::delete_session_by_id(s, &session_id) {
                failure = Some(error);
            }
        })
        .await;
    if let Some(error) = failure {
        return Err(error);
    }
    // Ensure the newly selected session has an actor ready.
    store.ensure_selected_actor(&app).await.ok();
    Ok(state)
}

#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
    title: String,
) -> Result<DesktopState, String> {
    // Persist the name to the session file via pi-rs (append_session_info) so
    // renames survive restarts — the in-memory record alone is rebuilt from
    // the files on the next launch. If the session has a live actor, delegate
    // to its SetName command; otherwise open the file directly.
    let has_actor = store.actors.contains(&session_id).await;
    if has_actor {
        store
            .send_cmd(&session_id, |reply| SessionCommand::SetName {
                name: title.clone(),
                reply,
            })
            .await
            .ok();
    } else {
        let file = {
            let state = store.state.lock().await;
            state
                .sessions
                .iter()
                .find(|s| s.id == session_id)
                .and_then(|s| s.session_file.clone())
                .filter(|f| !f.is_empty())
        };
        if let Some(file) = file {
            let mut mgr =
                pi_coding_agent::core::session_manager::SessionManager::open(&file, None, None);
            mgr.append_session_info(&title);
        }
    }
    Ok(store
        .mutate(&app, |s| {
            session::rename_session_by_id(s, &session_id, &title)
        })
        .await)
}

#[tauri::command]
pub async fn set_session_cwd(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
    path: String,
) -> Result<DesktopState, String> {
    store.set_session_cwd(&app, &session_id, &path).await
}

// ── Agent-session flow ──

#[tauri::command]
pub async fn submit_composer(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    text: String,
    options: Option<serde_json::Value>,
) -> Result<DesktopState, String> {
    // options: {
    //   images: [{ data: <raw base64>, mimeType: "image/png" }],
    //   streamingBehavior: "steer" | "followUp"
    // }
    let streaming_behavior = options
        .as_ref()
        .and_then(|o| o.get("streamingBehavior"))
        .and_then(|v| v.as_str())
        .map(str::to_string);
    let images: Option<Vec<ContentBlock>> = options
        .and_then(|o| o.get("images").and_then(|v| v.as_array()).cloned())
        .map(|arr| {
            arr.into_iter()
                .filter_map(|v| {
                    let data = v.get("data").and_then(|d| d.as_str())?;
                    if data.is_empty() {
                        return None;
                    }
                    let mime = v
                        .get("mimeType")
                        .and_then(|m| m.as_str())
                        .filter(|m| !m.is_empty())
                        .unwrap_or("image/png")
                        .to_string();
                    Some(ContentBlock::Image {
                        data: data.to_string(),
                        mime_type: mime,
                    })
                })
                .collect()
        })
        .filter(|v: &Vec<ContentBlock>| !v.is_empty());
    store
        .send_message(&app, &text, images, streaming_behavior)
        .await
        .map_err(|e| e.to_string())?;
    Ok(store.state.lock().await.clone())
}

#[tauri::command]
pub async fn cancel_current_run(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<DesktopState, String> {
    store.abort().await;
    Ok(store
        .mutate(&app, |s| {
            let sid = s.selected_session_id.clone();
            crate::state::set_sess_status(s, &sid, "idle");
        })
        .await)
}

/// Abort a specific session's run (sidebar Stop for a background session).
#[tauri::command]
pub async fn abort_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<DesktopState, String> {
    store.abort_session(&session_id).await;
    Ok(store
        .mutate(&app, |s| {
            crate::state::set_sess_status(s, &session_id, "idle");
        })
        .await)
}

// ── Model ──

#[tauri::command]
pub async fn get_default_model(store: State<'_, Arc<Store>>) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    Ok(model::get_default_model(&state))
}

#[tauri::command]
pub async fn get_models() -> Result<serde_json::Value, String> {
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    use pi_coding_agent::core::model_registry::ModelRegistry;
    let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
    let providers = registry.get_providers();
    // AuthStorage-aware: covers auth.json keys set in the GUI + env vars.
    // One auth.json read for all providers instead of one per provider.
    let authed = providers::providers_with_auth(&providers);
    let mut models = Vec::new();
    for pid in &providers {
        let has_auth = authed.contains(pid);
        for m in registry.get_models_for_provider(pid) {
            models.push(json!({
                "providerId": pid,
                "modelId": m.id,
                "label": if m.name.is_empty() { m.id } else { m.name },
                "available": has_auth,
            }));
        }
    }
    Ok(json!({"models": models}))
}

#[tauri::command]
pub async fn get_providers() -> Result<serde_json::Value, String> {
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    use pi_coding_agent::core::model_registry::ModelRegistry;
    use pi_coding_agent::core::provider_display_names::BUILT_IN_PROVIDER_DISPLAY_NAMES;
    let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
    let providers = registry.get_providers();
    let authed = providers::providers_with_auth(&providers);
    let mut provider_list = Vec::new();
    for pid in &providers {
        let has_auth = authed.contains(pid);
        let name = BUILT_IN_PROVIDER_DISPLAY_NAMES
            .get(pid.as_str())
            .map(|n| n.to_string())
            .unwrap_or_else(|| {
                let mut n = pid.clone();
                if let Some(c) = n.as_mut_str().get_mut(0..1) {
                    c.make_ascii_uppercase();
                }
                n
            });
        provider_list.push(json!({"id": pid, "name": name, "hasAuth": has_auth}));
    }
    Ok(json!({"providers": provider_list}))
}

#[tauri::command]
pub async fn get_model_settings(store: State<'_, Arc<Store>>) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    Ok(json!({ "settings": state.global_model_settings }))
}

#[tauri::command]
pub async fn set_default_model(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    provider: String,
    model_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| model::set_default_model(s, &provider, &model_id))
        .await)
}

#[tauri::command]
pub async fn set_default_thinking_level(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    thinking_level: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            model::set_default_thinking_level(s, &thinking_level)
        })
        .await)
}

#[tauri::command]
pub async fn set_provider_api_key(
    store: State<'_, Arc<Store>>,
    provider_id: String,
    api_key: String,
) -> Result<DesktopState, String> {
    providers::set_provider_api_key(&provider_id, &api_key)?;
    Ok(store.state.lock().await.clone())
}

#[tauri::command]
pub async fn logout_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    provider_id: String,
) -> Result<DesktopState, String> {
    providers::clear_provider_auth(&provider_id);
    Ok(store
        .mutate(&app, |_s| {
            // Runtime snapshot removed; provider auth is read on demand
        })
        .await)
}

#[tauri::command]
pub async fn set_custom_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    config: serde_json::Value,
) -> Result<DesktopState, String> {
    providers::set_custom_provider(&config)?;
    Ok(store
        .mutate(&app, |_s| {
            // Runtime snapshot removed; custom providers are read on demand
        })
        .await)
}

#[tauri::command]
pub async fn delete_custom_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    provider_id: String,
) -> Result<DesktopState, String> {
    providers::delete_custom_provider(&provider_id)?;
    Ok(store
        .mutate(&app, |_s| {
            // Runtime snapshot removed; custom providers are read on demand
        })
        .await)
}

// ── Transcript ──

#[tauri::command]
pub async fn get_selected_transcript(
    store: State<'_, Arc<Store>>,
) -> Result<Option<serde_json::Value>, String> {
    let (sess_id, session_file) = {
        let state = store.state.lock().await;
        let sid = state.selected_session_id.clone();
        let file = state
            .sessions
            .iter()
            .find(|s| s.id == sid)
            .and_then(|s| s.session_file.as_ref().filter(|f| !f.is_empty()))
            .cloned();
        (sid, file)
    };
    if sess_id.is_empty() {
        return Ok(None);
    }

    // Prefer in-memory session messages (more up-to-date than file) whenever
    // the session has a live actor — with multi-session the actor for the
    // selected session may exist even while another session streams.
    if store.actors.contains(&sess_id).await {
        let in_memory = store.get_messages().await;
        if !in_memory.is_empty() {
            let transcript = crate::state::build_display_transcript(&in_memory);
            if !transcript.is_empty() {
                return Ok(Some(
                    json!({"sessionId": sess_id, "transcript": transcript}),
                ));
            }
        }
    }

    let transcript = match session_file {
        Some(ref p) => crate::state::session::read_transcript_from_file(p),
        None => vec![],
    };
    if transcript.is_empty() {
        return Ok(None);
    }

    Ok(Some(
        json!({"sessionId": sess_id, "transcript": transcript}),
    ))
}

// ── Providers CRUD ──

#[tauri::command]
pub async fn list_custom_providers() -> Result<Vec<serde_json::Value>, String> {
    Ok(providers::list_custom_providers())
}

#[tauri::command]
pub async fn get_custom_provider(provider_id: String) -> Result<serde_json::Value, String> {
    providers::get_custom_provider(&provider_id)
        .ok_or_else(|| format!("provider '{provider_id}' not found"))
}

#[tauri::command]
pub async fn has_provider_auth(provider_id: String) -> Result<bool, String> {
    Ok(providers::has_provider_auth(&provider_id))
}

// ── Resources dirs ──

#[tauri::command]
pub async fn get_agent_dir() -> Result<String, String> {
    Ok(pi_coding_agent::config::get_agent_dir()
        .to_string_lossy()
        .to_string())
}

// ── Skills ──

#[tauri::command]
pub async fn list_skills(cwd: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    Ok(crate::state::skills::list_skills(&cwd))
}

#[tauri::command]
pub async fn get_skill(cwd: Option<String>, name: String) -> Result<serde_json::Value, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    crate::state::skills::get_skill(&cwd, &name).ok_or_else(|| format!("skill '{name}' not found"))
}

// ── Extensions ──

#[tauri::command]
pub async fn list_extensions() -> Result<Vec<serde_json::Value>, String> {
    Ok(crate::state::extensions::list_extensions())
}

#[tauri::command]
pub async fn get_extension(name: String) -> Result<serde_json::Value, String> {
    crate::state::extensions::get_extension(&name)
        .ok_or_else(|| format!("extension '{name}' not found"))
}

#[tauri::command]
pub async fn get_extension_settings() -> Result<serde_json::Value, String> {
    Ok(crate::state::extensions::get_extension_settings())
}

#[tauri::command]
pub async fn set_web_search_config(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    provider: String,
    deepseek_base_url: Option<String>,
    deepseek_api_key: Option<String>,
    clear_deepseek_api_key: bool,
    ollama_host: Option<String>,
) -> Result<serde_json::Value, String> {
    let mut out = crate::state::extensions::set_web_search_config(
        &provider,
        deepseek_base_url,
        deepseek_api_key,
        clear_deepseek_api_key,
        ollama_host,
    )?;
    let restart = store.restart_selected_actor(&app).await;
    out["applied"] = serde_json::json!(restart.is_ok());
    if let Err(error) = restart {
        out["warning"] = serde_json::json!(error);
    }
    Ok(out)
}

// ── General settings ──

#[tauri::command]
pub async fn get_general_settings() -> Result<serde_json::Value, String> {
    Ok(settings::get_general_settings())
}

#[tauri::command]
pub async fn set_general_setting(
    key: String,
    value: serde_json::Value,
) -> Result<serde_json::Value, String> {
    settings::set_general_setting(&key, value)?;
    Ok(settings::get_general_settings())
}

// ── Slash commands ──

#[tauri::command]
pub async fn list_slash_commands(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<Vec<serde_json::Value>, String> {
    // The selected session's actor may not exist yet (e.g. right after a
    // fresh launch). Spawn it so the command list isn't empty.
    store.ensure_selected_actor(&app).await.ok();
    Ok(store.list_slash_commands().await)
}

// ── Workspace file completion (composer @ mention / Tab) ──

#[tauri::command]
pub async fn file_completions(
    cwd: Option<String>,
    query: String,
) -> Result<Vec<serde_json::Value>, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    Ok(crate::state::files::file_completions(&cwd, &query))
}

// ── Session export ──

#[tauri::command]
pub async fn export_session(
    store: State<'_, Arc<Store>>,
    session_id: String,
    format: String,
    target_path: String,
) -> Result<String, String> {
    let session_file = {
        let state = store.state.lock().await;
        state
            .sessions
            .iter()
            .find(|s| s.id == session_id)
            .and_then(|s| s.session_file.as_ref())
            .filter(|f| !f.is_empty())
            .cloned()
            .ok_or_else(|| format!("session '{session_id}' has no session file"))?
    };
    crate::state::export::export_session(&session_file, &format, &target_path)
}

// ── Session share (/share via GitHub CLI) ──

/// Share the selected session as a secret GitHub gist. Requires the `gh` CLI
/// to be installed and logged in (`gh auth login`), mirroring TS `/share`.
/// Returns the gist URL.
#[tauri::command]
pub async fn share_session(store: State<'_, Arc<Store>>) -> Result<String, String> {
    use std::process::Stdio;

    // 1. gh must exist and be logged in.
    let auth = tokio::process::Command::new("gh")
        .args(["auth", "status"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .await
        .map_err(|_| {
            "GitHub CLI (gh) is not installed. Install it from https://cli.github.com/".to_string()
        })?;
    if !auth.success() {
        return Err("GitHub CLI is not logged in. Run 'gh auth login' first.".to_string());
    }

    // 2. Resolve the selected session's file.
    let sid = store.state.lock().await.selected_session_id.clone();
    if sid.is_empty() {
        return Err("No session selected".to_string());
    }
    let session_file = {
        let state = store.state.lock().await;
        state
            .sessions
            .iter()
            .find(|s| s.id == sid)
            .and_then(|s| s.session_file.as_ref())
            .filter(|f| !f.is_empty())
            .cloned()
            .ok_or_else(|| "session has no session file".to_string())?
    };

    // 3. Export to a temp HTML file.
    let tmp = std::env::temp_dir().join("pi-gui-share.html");
    crate::state::export::export_session(&session_file, "html", &tmp.to_string_lossy())?;

    // 4. Create a secret gist and extract the URL from the output.
    let out = tokio::process::Command::new("gh")
        .args(["gist", "create", "--public=false", &tmp.to_string_lossy()])
        .output()
        .await
        .map_err(|e| format!("failed to run gh: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "gh gist create failed".to_string()
        } else {
            err
        });
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let url = stdout
        .lines()
        .find_map(|l| {
            let t = l.trim();
            if t.starts_with("https://gist.github.com/") {
                Some(t.to_string())
            } else {
                None
            }
        })
        .ok_or_else(|| format!("could not parse gist URL from: {stdout}"))?;
    Ok(url)
}

// ── Session tree (timeline) ──

#[tauri::command]
pub async fn get_session_tree(
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    store.get_session_tree_json(&session_id).await
}

#[tauri::command]
pub async fn navigate_session_tree(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
    entry_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    // `Store::navigate_session_tree` already emits the transcript update;
    // emitting here too sent every navigation twice.
    store
        .navigate_session_tree(&app, &session_id, &entry_id)
        .await
}

// ── Terminal ──

#[tauri::command]
pub async fn terminal_start(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    cwd: Option<String>,
) -> Result<String, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    store.terminal_start(&app, &cwd).await
}

#[tauri::command]
pub async fn terminal_write(
    store: State<'_, Arc<Store>>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    store.terminal_write(&session_id, &data).await
}

#[tauri::command]
pub async fn terminal_resize(
    store: State<'_, Arc<Store>>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    store.terminal_resize(&session_id, cols, rows).await
}

#[tauri::command]
pub async fn terminal_stop(store: State<'_, Arc<Store>>, session_id: String) -> Result<(), String> {
    store.terminal_stop(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn terminal_stop_all(store: State<'_, Arc<Store>>) -> Result<(), String> {
    store.terminal_stop_all().await;
    Ok(())
}

// ── Session model ──

#[tauri::command]
pub async fn set_session_model(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    provider: String,
    model_id: String,
) -> Result<DesktopState, String> {
    store.set_session_model(&app, &provider, &model_id).await
}

#[tauri::command]
pub async fn get_session_model(store: State<'_, Arc<Store>>) -> Result<serde_json::Value, String> {
    Ok(store.get_session_model().await)
}

#[tauri::command]
pub async fn set_session_thinking_level(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    level: String,
) -> Result<serde_json::Value, String> {
    store.set_session_thinking_level(&app, &level).await
}

#[tauri::command]
pub async fn get_session_usage(
    store: State<'_, Arc<Store>>,
) -> Result<Option<serde_json::Value>, String> {
    Ok(store.get_session_usage().await)
}

// ── Session info ──

#[tauri::command]
pub async fn get_session_info(
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<serde_json::Value, String> {
    Ok(store.get_session_info(&session_id).await)
}

// ── Manual compaction (/compact) ──

#[tauri::command]
pub async fn compact_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    custom_instructions: Option<String>,
) -> Result<DesktopState, String> {
    store
        .compact_session(&app, custom_instructions.as_deref())
        .await
}

// ── Fork / import / reload (/fork, /import, /reload) ──

#[tauri::command]
pub async fn fork_session_at(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    entry_id: String,
) -> Result<DesktopState, String> {
    store.fork_session_at(&app, &entry_id).await
}

#[tauri::command]
pub async fn clone_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<DesktopState, String> {
    store.clone_session(&app).await
}

#[tauri::command]
pub async fn import_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    input_path: String,
) -> Result<DesktopState, String> {
    store.import_session(&app, &input_path).await
}

#[tauri::command]
pub async fn reload_session(store: State<'_, Arc<Store>>) -> Result<(), String> {
    store.reload_session().await
}

// ── Project trust (/trust) ──

#[tauri::command]
pub async fn get_project_trust(cwd: Option<String>) -> Result<serde_json::Value, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    Ok(crate::state::trust::get_project_trust(&cwd))
}

#[tauri::command]
pub async fn set_project_trust(
    cwd: Option<String>,
    decision: Option<bool>,
) -> Result<serde_json::Value, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    Ok(crate::state::trust::set_project_trust(&cwd, decision))
}

// ── MCP servers ──

/// List configured MCP servers with live connection state from the selected
/// session. `cwd` scopes the project `mcp.json` lookup.
#[tauri::command]
pub async fn list_mcp_servers(
    store: State<'_, Arc<Store>>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    let runtime = store.mcp_snapshot().await;
    Ok(mcp::list_servers(&cwd, &runtime))
}

/// Add or replace an MCP server, then restart the selected session so pi-rs
/// reloads its connections. A running turn blocks the restart; the config is
/// still saved and the returned `warning` says so.
#[tauri::command]
pub async fn save_mcp_server(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
    config: serde_json::Value,
    scope: Option<String>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    mcp::save_server(&name, &config, scope.as_deref().unwrap_or("global"), &cwd)?;
    apply_mcp_change(&app, &store, &cwd).await
}

#[tauri::command]
pub async fn delete_mcp_server(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    mcp::delete_server(&name, &cwd)?;
    apply_mcp_change(&app, &store, &cwd).await
}

#[tauri::command]
pub async fn update_mcp_server(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
    enabled: Option<bool>,
    exposure: Option<String>,
    cwd: Option<String>,
) -> Result<serde_json::Value, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    mcp::update_server(&name, enabled, exposure.as_deref(), &cwd)?;
    apply_mcp_change(&app, &store, &cwd).await
}

/// Reconnect one server in the live session (no config change).
#[tauri::command]
pub async fn reconnect_mcp_server(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<(), String> {
    store.ensure_selected_actor(&app).await?;
    store.reconnect_mcp(&name).await
}

/// Run the pi-rs OAuth sign-in flow, then reconnect the live connection.
#[tauri::command]
pub async fn sign_in_mcp_server(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    mcp::sign_in(&name, &cwd).await?;
    store.ensure_selected_actor(&app).await.ok();
    // Best effort: the session may not have an actor/connection yet.
    let _ = store.reconnect_mcp(&name).await;
    Ok(())
}

/// Tail of `mcp.log` for one server.
#[tauri::command]
pub async fn get_mcp_log(name: String, limit: Option<usize>) -> Result<String, String> {
    Ok(mcp::read_log(&name, limit.unwrap_or(200)))
}

/// Restart the selected actor (best effort) and return the refreshed list.
async fn apply_mcp_change(
    app: &AppHandle,
    store: &State<'_, Arc<Store>>,
    cwd: &str,
) -> Result<serde_json::Value, String> {
    let restart = store.restart_selected_actor(app).await;
    let runtime = store.mcp_snapshot().await;
    let mut payload = mcp::list_servers(cwd, &runtime);
    payload["applied"] = serde_json::json!(restart.is_ok());
    if let Err(error) = restart {
        payload["warning"] = serde_json::json!(error);
    }
    Ok(payload)
}

// ── Scoped models (Ctrl/Cmd+P cycling) ──

/// `provider/modelId` patterns persisted in `ui-state.json`.
#[tauri::command]
pub async fn get_scoped_models(store: State<'_, Arc<Store>>) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    Ok(serde_json::json!({
        "patterns": state.global_model_settings.enabled_model_patterns,
    }))
}

/// Persist the scoped-model patterns and restart the selected actor so the
/// new list is picked up. A running turn blocks the restart (config is still
/// saved; `warning` explains it).
#[tauri::command]
pub async fn set_scoped_models(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    patterns: Vec<String>,
) -> Result<serde_json::Value, String> {
    store
        .mutate(&app, |state| {
            state.global_model_settings.enabled_model_patterns = patterns;
        })
        .await;
    let restart = store.restart_selected_actor(&app).await;
    let state = store.state.lock().await;
    let mut out = serde_json::json!({
        "patterns": state.global_model_settings.enabled_model_patterns,
        "applied": restart.is_ok(),
    });
    if let Err(error) = restart {
        out["warning"] = serde_json::json!(error);
    }
    Ok(out)
}

/// Cycle the selected session's model forward/backward.
#[tauri::command]
pub async fn cycle_scoped_model(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    direction: String,
) -> Result<Option<serde_json::Value>, String> {
    store.ensure_selected_actor(&app).await?;
    store.cycle_model(&direction).await
}

// ── Full-text session search ──

/// Search user/assistant message text across all non-archived sessions.
/// Runs on a blocking worker because it reads every JSONL file.
#[tauri::command]
pub async fn search_sessions(
    store: State<'_, Arc<Store>>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<serde_json::Value>, String> {
    if query.trim().is_empty() {
        return Ok(Vec::new());
    }
    let sessions: Vec<(String, String, String)> = {
        let state = store.state.lock().await;
        state
            .sessions
            .iter()
            .filter(|session| session.archived_at.is_none())
            .filter_map(|session| {
                let file = session
                    .session_file
                    .as_ref()
                    .filter(|file| !file.is_empty())?
                    .clone();
                Some((session.id.clone(), session.title.clone(), file))
            })
            .collect()
    };
    let limit = limit.unwrap_or(50).clamp(1, 200);
    tokio::task::spawn_blocking(move || {
        crate::state::session::search_session_texts(&sessions, &query, limit)
    })
    .await
    .map_err(|error| error.to_string())
}

// ── Built-in extensions ──

/// Toggle a built-in extension (`subagent`, `web_search`) and restart the
/// selected actor so the new registry is picked up.
#[tauri::command]
pub async fn set_extension_enabled(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    crate::state::extensions::set_extension_enabled(&name, enabled)?;
    let restart = store.restart_selected_actor(&app).await;
    let mut out = serde_json::json!({ "applied": restart.is_ok() });
    if let Err(error) = restart {
        out["warning"] = serde_json::json!(error);
    }
    Ok(out)
}

// ── MCP resources ──

#[tauri::command]
pub async fn get_mcp_resources(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<serde_json::Value, String> {
    store.ensure_selected_actor(&app).await?;
    store.mcp_resources(&name).await
}

#[tauri::command]
pub async fn read_mcp_resource(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    name: String,
    uri: String,
) -> Result<serde_json::Value, String> {
    store.ensure_selected_actor(&app).await?;
    store.read_mcp_resource(&name, &uri).await
}

// ── Open files in the external editor ──

#[tauri::command]
pub async fn open_file(path: String, cwd: Option<String>) -> Result<(), String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    crate::state::files::open_in_editor(&path, &cwd)
}

// ── Prompt templates ──

#[tauri::command]
pub async fn list_prompt_templates(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<Vec<serde_json::Value>, String> {
    // The selected session's actor may not exist yet (fresh launch).
    store.ensure_selected_actor(&app).await.ok();
    Ok(store.list_prompt_templates().await)
}

// ── In-app text preview ──

#[tauri::command]
pub async fn read_text_file(path: String, cwd: Option<String>) -> Result<String, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    crate::state::files::read_text_file(&path, &cwd)
}
