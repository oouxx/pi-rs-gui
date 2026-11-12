//! The Store struct — central state manager for the Tauri backend.
//!
//! Concurrency model (ACP-style): each session owns a dedicated
//! `SessionActor` task (see `actor.rs`). The Store keeps the UI-facing
//! `DesktopState` and an [`ActorRegistry`] of session mailboxes. Multiple
//! sessions run in parallel; switching the selected session does NOT destroy
//! the old actor, so background sessions keep streaming.
//!
//! Responsibilities are split across sibling modules:
//! - [`super::runtime`] — runtime factory, actor spawn/ensure/shutdown
//! - [`super::lifecycle`] — session CRUD, fork/import, messaging, model switch
//! - [`super::actors`] — mailbox registry

use std::sync::Arc;

use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

use super::actor::SessionCommand;
use super::actors::ActorRegistry;
use super::types::{DesktopState, GlobalModelSettings};
use super::ui;

// ── Default state ──────────────────────────────────────────

pub fn default_state() -> DesktopState {
    DesktopState {
        revision: 1,
        sessions: vec![],
        selected_session_id: String::new(),
        global_model_settings: GlobalModelSettings {
            enabled_model_patterns: vec![],
            default_provider: None,
            default_model_id: None,
            default_thinking_level: None,
        },
    }
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn set_sess_status(s: &mut DesktopState, sid: &str, status: &str) {
    if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sid) {
        sess.status = status.to_string();
    }
}

// ── Store ───────────────────────────────────────────────────

pub struct Store {
    pub state: Mutex<DesktopState>,
    /// Session actors, keyed by the session's real id. One per session;
    /// switching selection does not destroy them.
    pub actors: ActorRegistry,
    /// Embedded terminal sessions (one per dock tab, Chrome-tab style).
    pub terminals: tokio::sync::Mutex<Vec<crate::state::terminal::TerminalSession>>,
}

impl Store {
    #[cfg(test)]
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(default_state()),
            actors: ActorRegistry::new(),
            terminals: tokio::sync::Mutex::new(vec![]),
        })
    }

    /// Build the store with restored UI state + scanned sessions. Runs before
    /// the async runtime is available, so it constructs the mutexes directly
    /// (no `blocking_lock`, which would panic inside a runtime context).
    pub fn new_with_runtime() -> Arc<Self> {
        let restored = ui::restore_state();
        let mut s = default_state();
        if !restored.selected_session_id.is_empty() {
            s.selected_session_id = restored.selected_session_id;
        }
        s.sessions = super::session::scan_existing_sessions();
        super::model::hydrate_global_settings(&mut s);
        s.revision += 1;
        Arc::new(Self {
            state: Mutex::new(s),
            actors: ActorRegistry::new(),
            terminals: tokio::sync::Mutex::new(vec![]),
        })
    }

    pub async fn mutate<F>(self: &Arc<Self>, app: &AppHandle, f: F) -> DesktopState
    where
        F: FnOnce(&mut DesktopState),
    {
        let mut state = self.state.lock().await;
        let previous_selected = state.selected_session_id.clone();
        let previous_patterns = state.global_model_settings.enabled_model_patterns.clone();
        f(&mut state);
        state.revision += 1;
        let result = state.clone();
        let _ = app.emit(super::events::STATE_CHANGED, &result);
        // `ui-state.json` stores the selected id + scoped-model patterns —
        // don't hit the disk for transient mutations (status flips, rename).
        if result.selected_session_id != previous_selected
            || result.global_model_settings.enabled_model_patterns != previous_patterns
        {
            ui::persist_state(&result);
        }
        drop(state);
        result
    }

    /// Send a command to a session's actor and await its oneshot reply.
    pub async fn send_cmd<T>(
        &self,
        session_id: &str,
        make: impl FnOnce(tokio::sync::oneshot::Sender<T>) -> SessionCommand,
    ) -> Result<T, String> {
        self.actors.send(session_id, make).await
    }
}
