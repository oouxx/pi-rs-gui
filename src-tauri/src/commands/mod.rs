use std::sync::Arc;

use crate::state::*;
use crate::state::{model, providers, session, settings};
use serde_json::json;
use tauri::{AppHandle, Emitter, State};

// ── Core ──

#[tauri::command]
pub async fn ping() -> String {
    "pong".into()
}

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
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| {
            session::create_session_simple(s, title.as_deref().unwrap_or("New thread"))
        })
        .await)
}

#[tauri::command]
pub async fn archive_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| session::archive_session_by_id(s, &session_id))
        .await)
}

#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |s| session::delete_session_by_id(s, &session_id))
        .await)
}

#[tauri::command]
pub async fn rename_session(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    session_id: String,
    title: String,
) -> Result<DesktopState, String> {
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
    _options: Option<serde_json::Value>,
) -> Result<DesktopState, String> {
    store
        .send_message(&app, &text)
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

// ── Model ──

#[tauri::command]
pub async fn get_default_model(store: State<'_, Arc<Store>>) -> Result<serde_json::Value, String> {
    let state = store.state.lock().await;
    Ok(model::get_default_model(&state))
}

#[tauri::command]
pub async fn get_models(store: State<'_, Arc<Store>>) -> Result<serde_json::Value, String> {
    let _state = store.state.lock().await;
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    use pi_coding_agent::core::model_registry::ModelRegistry;
    let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
    let providers = registry.get_providers();
    let mut models = Vec::new();
    for pid in &providers {
        let has_auth = pi_ai::env_api_keys::get_env_var_name(pid)
            .and_then(|var| std::env::var(var).ok())
            .map(|v| !v.is_empty() && v != "placeholder")
            .unwrap_or(false);
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
pub async fn get_providers(store: State<'_, Arc<Store>>) -> Result<serde_json::Value, String> {
    let _state = store.state.lock().await;
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    use pi_coding_agent::core::model_registry::ModelRegistry;
    use pi_coding_agent::core::provider_display_names::BUILT_IN_PROVIDER_DISPLAY_NAMES;
    let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
    let providers = registry.get_providers();
    let mut provider_list = Vec::new();
    for pid in &providers {
        let has_auth = pi_ai::env_api_keys::get_env_var_name(pid)
            .and_then(|var| std::env::var(var).ok())
            .map(|v| !v.is_empty() && v != "placeholder")
            .unwrap_or(false);
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
    Ok(
        json!({"settings": state.global_model_settings, "globalModelSettings": state.global_model_settings}),
    )
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
    providers::set_provider_api_key(&provider_id, &api_key).map_err(|e| format!("{e}"))?;
    Ok(store.state.lock().await.clone())
}

#[tauri::command]
pub async fn login_provider(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    _provider_id: String,
) -> Result<DesktopState, String> {
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    Ok(store
        .mutate(&app, |_s| {
            // Runtime snapshot removed; provider auth is checked on demand
        })
        .await)
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

    // Prefer in-memory session messages (more up-to-date than file),
    // but only if the active AgentSession matches the requested session.
    // During streaming the session is moved into a tokio task, so
    // get_messages() returns empty — fall through to file-based read.
    let active_sid = store.session_id.lock().await.clone().unwrap_or_default();
    if active_sid == sess_id {
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
pub async fn get_skill(
    cwd: Option<String>,
    name: String,
) -> Result<serde_json::Value, String> {
    let cwd = crate::state::cwd::resolve_session_cwd(cwd.as_deref());
    crate::state::skills::get_skill(&cwd, &name)
        .ok_or_else(|| format!("skill '{name}' not found"))
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
    store: State<'_, Arc<Store>>,
) -> Result<Vec<serde_json::Value>, String> {
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
    store.navigate_session_tree(&session_id, &entry_id).await?;
    // Emit the updated transcript so the chat pane switches to the new branch.
    let transcript =
        crate::state::build_display_transcript(&store.get_messages().await);
    let _ = app.emit(
        "pi-gui:selected-transcript-changed",
        &serde_json::json!({
            "sessionId": session_id,
            "transcript": transcript,
        }),
    );
    store.get_session_tree_json(&session_id).await
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
pub async fn terminal_stop(store: State<'_, Arc<Store>>) -> Result<(), String> {
    store.terminal_stop().await;
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
pub async fn get_session_model(
    store: State<'_, Arc<Store>>,
) -> Result<serde_json::Value, String> {
    Ok(store.get_session_model().await)
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
