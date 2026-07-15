use std::sync::Arc;

use crate::state::*;
use crate::state::{model, providers, session};
use serde_json::json;
use tauri::{AppHandle, State};

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
    Ok(store
        .mutate(&app, |s| session::select_session_by_id(s, &session_id))
        .await)
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
    _provider_id: String,
) -> Result<DesktopState, String> {
    Ok(store
        .mutate(&app, |_s| {
            // Runtime snapshot removed; provider auth is checked on demand
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
