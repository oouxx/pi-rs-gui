//! Session lifecycle operations (`impl Store`).
//!
//! Extracted from `store.rs`: selection, creation, import, cwd
//! switching, messaging and model switching. Actor construction itself lives
//! in [`super::runtime`]; the actor map lives in [`super::actors`].

use std::sync::Arc;

use pi_agent_core::pi_ai_types::ContentBlock;
use pi_agent_core::types::AgentMessage;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::actor::SessionCommand;
use super::cwd::{decide_cwd_action, resolve_session_cwd, CwdAction};
use super::logging::write_line;
use super::session;
use super::transcript::build_display_transcript;
use super::types::{DesktopState, SessionRecord};
use super::Store;

impl Store {
    /// List slash commands the composer menu offers: the pi-rs builtins plus
    /// extension/prompt/skill commands from the active session.
    pub async fn list_slash_commands(&self) -> Vec<serde_json::Value> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Vec::new();
        }
        self.send_cmd(&sid, |reply| SessionCommand::GetCommands { reply })
            .await
            .unwrap_or_default()
    }

    /// Set the selected session's model (and persist it as the global default).
    pub async fn set_session_model(
        self: &Arc<Self>,
        app: &AppHandle,
        provider: &str,
        model_id: &str,
    ) -> Result<DesktopState, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        self.send_cmd(&sid, |reply| SessionCommand::SetModel {
            provider: provider.to_string(),
            model_id: model_id.to_string(),
            reply,
        })
        .await??;
        Ok(self
            .mutate(app, |s| {
                super::model::set_default_model(s, provider, model_id);
            })
            .await)
    }

    /// The selected session's current model (falls back to the global default).
    pub async fn get_session_model(&self) -> serde_json::Value {
        let sid = self.state.lock().await.selected_session_id.clone();
        if !sid.is_empty() {
            if let Ok(v) = self
                .send_cmd(&sid, |reply| SessionCommand::GetModel { reply })
                .await
            {
                return v;
            }
        }
        let state = self.state.lock().await;
        json!({
            "provider": state.global_model_settings.default_provider,
            "modelId": state.global_model_settings.default_model_id,
        })
    }

    /// Session info for the frontend header popover.
    pub async fn get_session_info(&self, session_id: &str) -> serde_json::Value {
        let (title, cwd, session_file) = {
            let state = self.state.lock().await;
            match state.sessions.iter().find(|s| s.id == session_id) {
                Some(s) => (s.title.clone(), s.cwd.clone(), s.session_file.clone()),
                None => {
                    return serde_json::json!({ "id": session_id, "found": false });
                }
            }
        };

        let mut message_count: usize = 0;
        let mut created_at: Option<String> = None;
        if let Some(file) = session_file.as_ref().filter(|f| !f.is_empty()) {
            let mgr =
                pi_coding_agent::core::session_manager::SessionManager::open(file, None, None);
            if let Some(header) = mgr.get_header() {
                created_at = Some(header.timestamp.clone());
            }
            message_count = mgr
                .get_entries()
                .iter()
                .filter(|e| {
                    matches!(
                        e,
                        pi_coding_agent::core::session_manager::SessionEntry::Message { .. }
                    )
                })
                .count();
        }

        let model = self.get_session_model().await;
        serde_json::json!({
            "id": session_id,
            "found": true,
            "title": title,
            "cwd": cwd,
            "sessionFile": session_file,
            "messageCount": message_count,
            "createdAt": created_at,
            "model": model,
        })
    }

    /// Manually compact the selected session (matches TS `/compact`).
    pub async fn compact_session(
        self: &Arc<Self>,
        _app: &AppHandle,
        custom_instructions: Option<&str>,
    ) -> Result<DesktopState, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        self.send_cmd(&sid, |reply| SessionCommand::Compact {
            custom_instructions: custom_instructions.map(|s| s.to_string()),
            reply,
        })
        .await??;
        Ok(self.state.lock().await.clone())
    }

    /// Refresh the Store after an import swapped the session: re-register
    /// the actor handle under the new id, rescan the session list, select the
    /// new session, and emit the updated transcript.
    async fn refresh_after_session_swap(
        self: &Arc<Self>,
        app: &AppHandle,
        old_id: &str,
        new_id: &str,
    ) -> DesktopState {
        // Re-register the actor under the new id (same mailbox).
        self.actors.rename(old_id, new_id).await;
        // Scan before taking the state lock: `list_all` reads every session
        // file and must not block other tasks or run inside a sync closure.
        let records = super::session::scan_existing_sessions_async().await;
        if !new_id.is_empty() {
            let state = self
                .mutate(app, move |s| {
                    s.sessions = records;
                    s.selected_session_id = new_id.to_string();
                    super::session::select_session_by_id(s, new_id);
                })
                .await;
            let transcript = build_display_transcript(&self.get_messages().await);
            if !transcript.is_empty() {
                let _ = app.emit(
                    super::events::TRANSCRIPT_CHANGED,
                    &json!({ "sessionId": new_id, "transcript": transcript }),
                );
            }
            state
        } else {
            self.mutate(app, move |s| {
                s.sessions = records;
            })
            .await
        }
    }

    /// Import a session from a JSONL file (matches TS `/import`).
    pub async fn import_session(
        self: &Arc<Self>,
        app: &AppHandle,
        input_path: &str,
    ) -> Result<DesktopState, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        let new_id = self
            .send_cmd(&sid, |reply| SessionCommand::Import {
                path: input_path.to_string(),
                reply,
            })
            .await??;
        Ok(self.refresh_after_session_swap(app, &sid, &new_id).await)
    }

    /// Reload settings (matches TS `/reload`).
    pub async fn reload_session(&self) -> Result<(), String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        self.send_cmd(&sid, |reply| SessionCommand::Reload { reply })
            .await?
    }

    /// Create a new session. The runtime (and therefore the real session id)
    /// is created first; the UI record is then inserted with that id, so there
    /// is no placeholder id to rewrite afterwards.
    pub async fn create_session_with_runtime(
        self: &Arc<Self>,
        app: &AppHandle,
        title: Option<&str>,
        cwd: Option<&str>,
    ) -> Result<DesktopState, String> {
        let cwd = resolve_session_cwd(cwd);
        let session_dir = Self::session_dir_for(&cwd);
        let session_manager = pi_coding_agent::core::session_manager::SessionManager::new(
            &cwd,
            &session_dir,
            None,
            true,
            None,
        );
        let (sid, session_file) = self.spawn_actor(app, &cwd, session_manager).await?;
        let title = title
            .filter(|t| !t.is_empty())
            .unwrap_or("New thread")
            .to_string();

        Ok(self
            .mutate(app, move |s| {
                if let Some(rec) = s.sessions.iter_mut().find(|r| r.id == sid) {
                    if rec.session_file.is_none() {
                        rec.session_file = session_file;
                    }
                } else {
                    s.sessions.push(SessionRecord {
                        id: sid.clone(),
                        title,
                        updated_at: super::store::now_iso(),
                        preview: String::new(),
                        status: "idle".to_string(),
                        session_file,
                        archived_at: None,
                        config: None,
                        thinking_level: None,
                        cwd: Some(cwd),
                    });
                }
                s.selected_session_id = sid.clone();
            })
            .await)
    }

    /// Select a session: update the selected id and ensure its actor exists.
    /// The previously selected session's actor is NOT destroyed — background
    /// streaming continues (multi-session).
    pub async fn select_session(
        self: &Arc<Self>,
        app: &AppHandle,
        session_id: &str,
    ) -> Result<DesktopState, String> {
        self.mutate(app, |s| {
            session::select_session_by_id(s, session_id);
        })
        .await;
        self.actors.touch(session_id).await;
        // Warming a cold actor can await MCP connections (up to 10s) and must
        // not block the selection. The transcript command reads the session
        // file while the actor is not ready yet.
        let store = Arc::clone(self);
        let app = app.clone();
        let sid = session_id.to_string();
        tokio::spawn(async move {
            if let Err(error) = store.ensure_actor(&app, &sid).await {
                write_line("SEL", &format!("sid={sid} actor warmup failed: {error}"));
            }
        });
        Ok(self.state.lock().await.clone())
    }

    pub async fn send_message(
        self: &Arc<Self>,
        app: &AppHandle,
        text: &str,
        images: Option<Vec<ContentBlock>>,
        streaming_behavior: Option<String>,
    ) -> Result<(), String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Err("No session".to_string());
        }
        // Lazy-init an actor for the selected session if needed.
        self.ensure_actor(app, &sid).await?;

        // The user message is rendered optimistically by the frontend; no
        // echo event is needed (and none was consumed).
        self.send_cmd(&sid, |reply| SessionCommand::SendMessage {
            text: text.to_string(),
            images: images.unwrap_or_default(),
            streaming_behavior,
            reply,
        })
        .await??;
        Ok(())
    }

    /// Per-session thinking level change (persisted in the session file).
    pub async fn set_session_thinking_level(
        self: &Arc<Self>,
        app: &AppHandle,
        level: &str,
    ) -> Result<serde_json::Value, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Err("No session".to_string());
        }
        self.ensure_actor(app, &sid).await?;
        self.send_cmd(&sid, |reply| SessionCommand::SetThinkingLevel {
            level: level.to_string(),
            reply,
        })
        .await
    }

    /// Context-window usage for the selected session (`None` when no model /
    /// no response yet).
    pub async fn get_session_usage(&self) -> Option<serde_json::Value> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() || !self.actors.contains(&sid).await {
            return None;
        }
        self.send_cmd(&sid, |reply| SessionCommand::GetUsage { reply })
            .await
            .ok()
            .flatten()
    }

    /// Cycle the selected session's model (scoped list first, otherwise all
    /// available models) and return the new selection.
    pub async fn cycle_model(&self, direction: &str) -> Result<Option<serde_json::Value>, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Err("No session selected".to_string());
        }
        if !self.actors.contains(&sid).await {
            return Err("Session is not loaded".to_string());
        }
        self.send_cmd(&sid, |reply| SessionCommand::CycleModel {
            direction: direction.to_string(),
            reply,
        })
        .await
    }

    /// Abort the selected session's in-flight run.
    pub async fn abort(&self) {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return;
        }
        let _ = self
            .send_cmd(&sid, |reply| SessionCommand::Abort { reply })
            .await;
    }

    /// Abort a specific session's in-flight run (used to stop a background
    /// session from the sidebar without switching to it first). No-op if the
    /// session has no actor.
    pub async fn abort_session(&self, session_id: &str) {
        let _ = self
            .send_cmd(session_id, |reply| SessionCommand::Abort { reply })
            .await;
    }

    /// Set the working directory for a session. Only sessions without history
    /// can move: an existing session file has its cwd in the header, so a
    /// session that already persisted messages is refused instead of being
    /// forked into a new one.
    pub async fn set_session_cwd(
        self: &Arc<Self>,
        app: &AppHandle,
        session_id: &str,
        path: &str,
    ) -> Result<DesktopState, String> {
        // Validate the path exists and is a directory.
        let p = std::path::PathBuf::from(path);
        if !p.is_dir() {
            return Err(format!(
                "Working directory does not exist or is not a directory: {}",
                path
            ));
        }
        let new_cwd = p.to_string_lossy().to_string();

        // Read the current session record (without holding the lock across init).
        let (current_file, current_cwd) = {
            let state = self.state.lock().await;
            let sess = state
                .sessions
                .iter()
                .find(|s| s.id == session_id)
                .ok_or_else(|| "Session not found".to_string())?;
            (
                sess.session_file.clone().filter(|f| !f.is_empty()),
                sess.cwd.clone(),
            )
        };

        let action = decide_cwd_action(current_file.as_deref(), &new_cwd, current_cwd.as_deref());
        write_line(
            "CWD",
            &format!(
                "set_session_cwd sid={} new_cwd={:?} current_cwd={:?} session_file={:?} action={:?}",
                session_id, new_cwd, current_cwd, current_file, action
            ),
        );

        match action {
            CwdAction::NoOp => Ok(self.state.lock().await.clone()),
            CwdAction::SetInPlace => {
                // No history: destroy the old actor (its cwd is fixed at
                // creation) and re-init a fresh one with the new cwd.
                self.shutdown_actor(session_id).await;
                let sid = session_id.to_string();
                let cwd = new_cwd.clone();
                self.mutate(app, |s| {
                    if let Some(sess) = s.sessions.iter_mut().find(|s| s.id == sid) {
                        sess.cwd = Some(cwd.clone());
                    }
                })
                .await;
                self.ensure_actor(app, session_id).await?;
                Ok(self.state.lock().await.clone())
            }
            CwdAction::HasHistory => Err(format!(
                "This session already has messages; its working directory is stored in the session file. Start a new session in {} instead.",
                new_cwd
            )),
        }
    }

    pub async fn get_messages(&self) -> Vec<AgentMessage> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return vec![];
        }
        self.send_cmd(&sid, |reply| SessionCommand::GetMessages { reply })
            .await
            .unwrap_or_default()
    }

    // ── MCP ──────────────────────────────────────────────────

    /// Live MCP snapshot for the selected session (empty when no actor).
    pub async fn mcp_snapshot(&self) -> Vec<serde_json::Value> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() || !self.actors.contains(&sid).await {
            return Vec::new();
        }
        self.send_cmd(&sid, |reply| SessionCommand::GetMcpSnapshot { reply })
            .await
            .unwrap_or_default()
    }

    /// Reconnect one MCP server in the selected session.
    pub async fn reconnect_mcp(&self, name: &str) -> Result<(), String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Err("No session selected".to_string());
        }
        self.send_cmd(&sid, |reply| SessionCommand::ReconnectMcp {
            name: name.to_string(),
            reply,
        })
        .await?
    }

    /// List resources + templates exposed by one MCP server.
    pub async fn mcp_resources(&self, name: &str) -> Result<serde_json::Value, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Err("No session selected".to_string());
        }
        self.send_cmd(&sid, |reply| SessionCommand::GetMcpResources {
            name: name.to_string(),
            reply,
        })
        .await?
    }

    /// Read one MCP resource by URI.
    pub async fn read_mcp_resource(
        &self,
        name: &str,
        uri: &str,
    ) -> Result<serde_json::Value, String> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() {
            return Err("No session selected".to_string());
        }
        self.send_cmd(&sid, |reply| SessionCommand::ReadMcpResource {
            name: name.to_string(),
            uri: uri.to_string(),
            reply,
        })
        .await?
    }

    /// File-based prompt templates from the selected session.
    pub async fn list_prompt_templates(&self) -> Vec<serde_json::Value> {
        let sid = self.state.lock().await.selected_session_id.clone();
        if sid.is_empty() || !self.actors.contains(&sid).await {
            return Vec::new();
        }
        self.send_cmd(&sid, |reply| SessionCommand::GetPromptTemplates { reply })
            .await
            .unwrap_or_default()
    }

    /// Restart the selected session's actor so config changes (MCP servers,
    /// extensions, …) are picked up. Refuses while a turn is running — the
    /// actor's shutdown would abort it.
    pub async fn restart_selected_actor(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
        let (sid, running) = {
            let state = self.state.lock().await;
            let sid = state.selected_session_id.clone();
            let running = state
                .sessions
                .iter()
                .find(|session| session.id == sid)
                .map(|session| session.status == "running")
                .unwrap_or(false);
            (sid, running)
        };
        if sid.is_empty() {
            return Ok(());
        }
        if running {
            return Err("Abort the running turn before applying this change".to_string());
        }
        self.shutdown_actor(&sid).await;
        self.ensure_actor(app, &sid).await
    }
}
