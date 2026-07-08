pub(crate) mod git;
pub(crate) mod internal;
pub(crate) mod runtime;
pub(crate) mod workspace;
pub(crate) mod session;
pub(crate) mod composer;
pub(crate) mod model;
pub(crate) mod theme;
pub(crate) mod providers;
pub(crate) mod persistence;
pub(crate) mod skills;
pub(crate) mod extensions;

pub use internal::*;
pub use runtime::build_runtime_snapshot;

// ── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_initial_state() {
        let store = Store::new();
        let state = store.state.lock().await;
        assert_eq!(state["revision"], 1);
        assert_eq!(state["selectedWorkspaceId"], "ws-default");
        assert_eq!(state["activeView"], "threads");
        assert_eq!(state["globalModelSettings"]["enabledModelPatterns"].as_array().unwrap().len(), 0);
        assert!(state["runtimeByWorkspace"].as_object().unwrap().is_empty());
    }
}
