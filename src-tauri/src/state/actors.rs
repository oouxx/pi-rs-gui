//! Actor registry — maps session IDs to their mailbox handles.
//!
//! Extracted from `Store` so state mutation and actor lifecycle have separate
//! owners. The registry is keyed by the session's *real* id; fork/import swaps
//! rename the key in place (the mailbox itself is unchanged).

use std::collections::HashMap;

use tokio::sync::{oneshot, Mutex};

use super::actor::{SessionCommand, SessionHandle};

#[derive(Default)]
pub struct ActorRegistry {
    handles: Mutex<HashMap<String, SessionHandle>>,
}

impl ActorRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn insert(&self, session_id: String, handle: SessionHandle) {
        self.handles.lock().await.insert(session_id, handle);
    }

    pub async fn remove(&self, session_id: &str) -> Option<SessionHandle> {
        self.handles.lock().await.remove(session_id)
    }

    pub async fn contains(&self, session_id: &str) -> bool {
        self.handles.lock().await.contains_key(session_id)
    }

    /// Re-key an existing mailbox after fork/import changed the session id.
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
        let (reply_tx, reply_rx) = oneshot::channel();
        tx.send(make(reply_tx))
            .map_err(|_| "session closed".to_string())?;
        reply_rx.await.map_err(|_| "session closed".to_string())
    }
}
