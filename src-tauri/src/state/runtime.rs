//! Agent runtime creation and actor lifecycle (`impl Store`).
//!
//! Extracted from `store.rs`: building the pi-rs runtime factory, spawning one
//! `SessionActor` per session, and starting/stopping actors on demand.

use std::sync::Arc;

use pi_coding_agent::core::agent_session::AgentSessionEvent;
use pi_coding_agent::core::agent_session_runtime::{
    create_agent_session_runtime, CreateAgentSessionRuntimeFactory,
    CreateAgentSessionRuntimeParams, CreateAgentSessionRuntimeResult,
};
use pi_coding_agent::core::agent_session_services::{
    create_agent_session_from_services, create_agent_session_services,
    CreateAgentSessionFromServicesOptions, CreateAgentSessionServicesOptions,
};
use tauri::{AppHandle, Emitter};

use super::actor::{SessionActor, SessionCommand};
use super::cwd::resolve_session_cwd;
use super::transcript::serialize_session_event;
use super::types::FrontendEvent;
use super::Store;

impl Store {
    /// Build the runtime factory closure that creates AgentSessions.
    ///
    /// The factory captures the Store and AppHandle, reads current state at
    /// creation time, and subscribes to session events before returning. The
    /// subscription reads the session id from a shared holder (updated by the
    /// actor on fork/import) so events keep the correct id after the session
    /// manager is swapped.
    fn build_runtime_factory(
        self: &Arc<Self>,
        app: &AppHandle,
    ) -> (
        CreateAgentSessionRuntimeFactory,
        Arc<std::sync::Mutex<String>>,
    ) {
        let store = self.clone();
        let a = app.clone();
        // Current session id, shared with the actor so fork/import swaps keep
        // the event subscription's sid in sync.
        let sid_holder = Arc::new(std::sync::Mutex::new(String::new()));
        let sid_holder_f = sid_holder.clone();
        let factory: CreateAgentSessionRuntimeFactory =
            Arc::new(move |params: CreateAgentSessionRuntimeParams| {
                let store = store.clone();
                let a = a.clone();
                let sid_holder = sid_holder_f.clone();
                Box::pin(async move {
                    pi_ai::providers::register_builtins::register_built_in_api_providers();

                    // Build the registry up front and pass it in so
                    // create_agent_session_services wires the auth.json credential
                    // resolver onto it (pi-rs v1.82.9+).
                    let registry = pi_coding_agent::core::model_registry::ModelRegistry::new(
                        pi_coding_agent::core::model_registry::ModelRegistry::builtin_models_list(),
                    );

                    let services =
                        create_agent_session_services(CreateAgentSessionServicesOptions {
                            cwd: params.cwd.clone(),
                            agent_dir: Some(params.agent_dir.clone()),
                            auth_storage: None,
                            settings_manager: None,
                            model_registry: Some(registry),
                            resource_loader_options: None,
                        })
                        .await;

                    let (provider, model_id, thinking_level) = {
                        let settings = services.settings_manager.get_settings();
                        (
                            settings.default_provider.clone(),
                            settings.default_model.clone(),
                            settings.default_thinking_level.clone(),
                        )
                    };

                    let registry = &services.model_registry;
                    let initial_model = provider
                        .as_ref()
                        .and_then(|p| model_id.as_ref().and_then(|m| registry.find(p, m)));

                    let model = initial_model.unwrap_or_else(|| {
                        let available = registry.get_available();
                        available.into_iter().next().unwrap_or_else(|| {
                            // No provider has auth configured (fresh install, no env
                            // keys, no models.json). Fall back to the first model in
                            // the registry so session creation succeeds; the agent
                            // surfaces a graceful "No API key configured" error on
                            // the first message instead of panicking here.
                            registry
                                .get_models()
                                .into_iter()
                                .next()
                                .expect("registry always has builtin models")
                        })
                    });

                    // Capture cwd/agent_dir before `services` is moved into
                    // `create_agent_session_from_services`, which consumes it
                    // without returning it. The runtime result still needs a
                    // `services` value (used for `cwd()`/`agent_dir()`), so we
                    // rebuild a fresh one for the result.
                    let result_cwd = services.cwd.clone();
                    let result_agent_dir = services.agent_dir.clone();

                    // Scoped models (Ctrl/Cmd+P cycling) come from the UI
                    // state, persisted in ui-state.json — pi-rs has no
                    // settings key for them. Patterns are `provider/modelId`.
                    let scoped_models = {
                        let patterns = {
                            let state = store.state.lock().await;
                            state
                                .global_model_settings
                                .enabled_model_patterns
                                .clone()
                        };
                        let models: Vec<_> = patterns
                            .iter()
                            .filter_map(|pattern| {
                                let (provider, model_id) = pattern.split_once('/')?;
                                services.model_registry.find(provider, model_id)
                            })
                            .map(|model| (model, None))
                            .collect();
                        (!models.is_empty()).then_some(models)
                    };

                    let (session, _services, result) =
                        create_agent_session_from_services(CreateAgentSessionFromServicesOptions {
                            services,
                            session_manager: params.session_manager,
                            model: Some(model),
                            thinking_level: thinking_level,
                            scoped_models,
                            tools: None,
                            no_tools: None,
                            exclude_tools: None,
                            custom_tools: None,
                            tools_options: None,
                            // `None` = let pi-rs build the registry from settings
                            // (`extensionsEnabled` opt-in + `webSearch` backend and
                            // MCP extension), matching every other front end.
                            extension_registry: None,
                            fallback_message: None,
                            session_start_event: params.session_start_event,
                            ui_context: None,
                            trust_override: None,
                            default_project_trust: None,
                        })
                        .await
                        .expect("Failed to create agent session");

                    let result_services =
                        create_agent_session_services(CreateAgentSessionServicesOptions {
                            cwd: result_cwd,
                            agent_dir: Some(result_agent_dir),
                            auth_storage: None,
                            settings_manager: None,
                            model_registry: None,
                            resource_loader_options: None,
                        })
                        .await;

                    // Subscribe to events. The session id comes from the shared
                    // holder so fork/import swaps keep it in sync.
                    let store2 = store.clone();
                    let a2 = a.clone();
                    session.subscribe(Arc::new(move |event: AgentSessionEvent| {
                        let sid = sid_holder
                            .lock()
                            .unwrap_or_else(std::sync::PoisonError::into_inner)
                            .clone();
                        let (et, data) = serialize_session_event(&event);
                        // Status follows the RUN, not individual turns: a
                        // tool-calling run emits TurnEnd per round, so keying off
                        // `turn_end` made the sidebar flicker idle mid-run and
                        // fired "session finished" toasts after every tool round.
                        if et == "agent_start" {
                            let store = store2.clone();
                            let app = a2.clone();
                            let sid = sid.clone();
                            tokio::spawn(async move {
                                store
                                    .mutate(&app, |s| {
                                        super::store::set_sess_status(s, &sid, "running");
                                    })
                                    .await;
                            });
                        } else if et == "agent_end" {
                            // `will_retry` runs continue; only the final end is idle.
                            let will_retry = data
                                .get("will_retry")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            if !will_retry {
                                let store = store2.clone();
                                let app = a2.clone();
                                let sid = sid.clone();
                                tokio::spawn(async move {
                                    store
                                        .mutate(&app, |s| {
                                            super::store::set_sess_status(s, &sid, "idle");
                                        })
                                        .await;
                                });
                            }
                        }
                        if et == "tool_execution_start" {
                            eprintln!(
                                "[TOOL] start sid={} id={} name={}",
                                sid,
                                data.get("tool_call_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(""),
                                data.get("tool_name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("?"),
                            );
                        } else if et == "tool_execution_end" {
                            let is_error = data
                                .get("is_error")
                                .and_then(|v| v.as_bool())
                                .unwrap_or(false);
                            let result_str = data
                                .get("result")
                                .and_then(|v| v.as_str().map(|s| s.to_string()))
                                .unwrap_or_else(|| {
                                    data.get("result")
                                        .map(|v| v.to_string())
                                        .unwrap_or_default()
                                });
                            let snippet: String = result_str.chars().take(160).collect();
                            eprintln!(
                                "[TOOL] end   sid={} id={} name={} is_error={} result={:?}",
                                sid,
                                data.get("tool_call_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(""),
                                data.get("tool_name")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("?"),
                                is_error,
                                snippet,
                            );
                        }
                        let _ = a2.emit(
                            super::events::AGENT_EVENT,
                            FrontendEvent {
                                event_type: et,
                                session_id: sid,
                                data,
                            },
                        );
                    }));

                    CreateAgentSessionRuntimeResult {
                        session,
                        services: result_services,
                        diagnostics: vec![],
                        model_fallback_message: result.model_fallback_message,
                    }
                })
            });
        (factory, sid_holder)
    }

    /// Compute the default session directory for a given cwd.
    pub(super) fn session_dir_for(cwd: &str) -> String {
        let agent_dir = pi_coding_agent::config::get_agent_dir()
            .to_string_lossy()
            .to_string();
        pi_coding_agent::core::session_manager::SessionManager::default_session_dir(cwd, &agent_dir)
    }

    /// Create an AgentSessionRuntime via the factory and spawn its actor.
    /// Registers the actor under the runtime's real session id and returns
    /// `(session_id, session_file)` — the caller owns the UI record, so there
    /// is no placeholder-id rewrite here.
    pub(super) async fn spawn_actor(
        self: &Arc<Self>,
        app: &AppHandle,
        cwd: &str,
        session_manager: pi_coding_agent::core::session_manager::SessionManager,
    ) -> Result<(String, Option<String>), String> {
        let agent_dir = pi_coding_agent::config::get_agent_dir()
            .to_string_lossy()
            .to_string();
        let (factory, sid_holder) = self.build_runtime_factory(app);
        let runtime = create_agent_session_runtime(
            factory,
            CreateAgentSessionRuntimeParams {
                cwd: cwd.to_string(),
                agent_dir,
                session_manager,
                session_start_event: None,
            },
        )
        .await;
        let sid = runtime.session().get_session_id();
        let session_file = runtime
            .session()
            .get_session_file()
            .map(|p| p.to_string_lossy().to_string());
        *sid_holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = sid.clone();

        let handle = SessionActor::spawn(runtime, self.clone(), app.clone(), sid_holder);
        self.actors.insert(sid.clone(), handle).await;
        Ok((sid, session_file))
    }

    /// Ensure an actor exists for `session_id` (spawn one from the record's
    /// file if missing). Used on selection so switching is instant and
    /// background sessions stay alive.
    pub async fn ensure_actor(
        self: &Arc<Self>,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<(), String> {
        if self.actors.contains(session_id).await {
            return Ok(());
        }
        let (cwd, session_file) = {
            let state = self.state.lock().await;
            match state.sessions.iter().find(|s| s.id == session_id) {
                Some(s) => (
                    resolve_session_cwd(s.cwd.as_deref()),
                    s.session_file.clone().filter(|f| !f.is_empty()),
                ),
                None => return Ok(()),
            }
        };
        let session_dir = Self::session_dir_for(&cwd);
        let session_manager = pi_coding_agent::core::session_manager::SessionManager::new(
            &cwd,
            &session_dir,
            session_file.as_deref(),
            true,
            None,
        );
        let (sid, file) = self.spawn_actor(app, &cwd, session_manager).await?;
        // Normally the runtime id equals the requested id. Backfill the file
        // path, and keep the record/selection consistent if they differ.
        if sid != session_id || file.is_some() {
            let requested = session_id.to_string();
            self.mutate(app, move |s| {
                if let Some(rec) = s
                    .sessions
                    .iter_mut()
                    .find(|r| r.id == requested || r.id == sid)
                {
                    rec.id = sid.clone();
                    if file.is_some() {
                        rec.session_file = file.clone();
                    }
                }
                if s.selected_session_id == requested {
                    s.selected_session_id = sid.clone();
                }
            })
            .await;
        }
        Ok(())
    }

    /// Ensure the currently selected session has an actor.
    pub async fn ensure_selected_actor(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Ok(());
        }
        self.ensure_actor(app, &sid).await
    }

    /// Abort and destroy a session's actor (archive/delete).
    pub async fn shutdown_actor(self: &Arc<Self>, session_id: &str) {
        if let Some(handle) = self.actors.remove(session_id).await {
            let _ = handle.tx.send(SessionCommand::Shutdown);
        }
    }
}
