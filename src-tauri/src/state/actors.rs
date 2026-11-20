//! Actor registry — maps session IDs to their mailbox handles.
//!
//! Extracted from `Store` so state mutation and actor lifecycle have separate
//! owners. The registry is keyed by the session's *real* id; import swaps
//! rename the key in place (the mailbox itself is unchanged).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;

use tokio::sync::{oneshot, Mutex};

use super::actor::{SessionCommand, SessionHandle};

#[derive(Default)]
pub struct ActorRegistry {
    handles: Mutex<HashMap<String, SessionHandle>>,
    warmups: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    last_used: Mutex<HashMap<String, Instant>>,
}

impl ActorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, session_id: String, handle: SessionHandle) {
        self.handles.lock().await.insert(session_id.clone(), handle);
        self.last_used
            .lock()
            .await
            .insert(session_id, Instant::now());
    }

    pub async fn remove(&self, session_id: &str) -> Option<SessionHandle> {
        let handle = self.handles.lock().await.remove(session_id);
        self.last_used.lock().await.remove(session_id);
        handle
    }

    /// Record actor activity (selection, command, send) for idle eviction.
    pub async fn touch(&self, session_id: &str) {
        self.last_used
            .lock()
            .await
            .insert(session_id.to_string(), Instant::now());
    }

    /// Snapshot of registered actors with their last activity time.
    pub async fn snapshot(&self) -> Vec<(String, Instant)> {
        let handles = self.handles.lock().await;
        let last_used = self.last_used.lock().await;
        let now = Instant::now();
        handles
            .keys()
            .map(|id| (id.clone(), last_used.get(id).copied().unwrap_or(now)))
            .collect()
    }

    pub async fn contains(&self, session_id: &str) -> bool {
        self.handles.lock().await.contains_key(session_id)
    }

    /// Per-session creation lock. Concurrent `ensure_actor` calls for the same
    /// session serialize instead of spawning duplicate runtimes.
    pub async fn warmup_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        self.warmups
            .lock()
            .await
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    /// Re-key an existing mailbox after an import changed the session id.
    pub async fn rename(&self, old_id: &str, new_id: &str) {
        if old_id == new_id {
            return;
        }
        let mut reg = self.handles.lock().await;
        if let Some(handle) = reg.remove(old_id) {
            reg.insert(new_id.to_string(), handle);
        }
    }

    /// Send a command to a session's actor and await its oneshot reply.
    pub async fn send<T>(
        &self,
        session_id: &str,
        make: impl FnOnce(oneshot::Sender<T>) -> SessionCommand,
    ) -> Result<T, String> {
        let tx = {
            let reg = self.handles.lock().await;
            reg.get(session_id)
                .map(|h| h.tx.clone())
                .ok_or_else(|| "no session".to_string())?
        };
        self.touch(session_id).await;
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(make(reply_tx))
            .map_err(|_| "session closed".to_string())?;
        reply_rx.await.map_err(|_| "session closed".to_string())
    }
}
