pub(crate) mod actor;
pub(crate) mod actors;
pub(crate) mod cwd;
pub(crate) mod events;
pub(crate) mod export;
pub(crate) mod extensions;
pub(crate) mod files;
pub(crate) mod lifecycle;
pub(crate) mod mcp;
pub(crate) mod model;
pub(crate) mod providers;
pub(crate) mod runtime;
pub(crate) mod session;
pub(crate) mod settings;
pub(crate) mod skills;
pub(crate) mod store;
pub(crate) mod terminal;
pub(crate) mod transcript;
pub(crate) mod tree;
pub(crate) mod trust;
pub(crate) mod types;
pub(crate) mod ui;

pub use store::*;
pub use transcript::*;
pub use types::*;

// ── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_initial_state() {
        let store = Store::new();
        let state = store.state.lock().await;
        assert_eq!(state.revision, 1);
        assert!(state
            .global_model_settings
            .enabled_model_patterns
            .is_empty());
    }

    #[test]
    fn test_resolve_session_cwd_prefers_session_cwd() {
        let cwd = super::cwd::resolve_session_cwd(Some("/usr/local"));
        assert_eq!(cwd, "/usr/local");
    }

    #[tokio::test]
    async fn test_create_session_pins_cwd() {
        let store = Store::new();
        let mut state = store.state.lock().await;
        super::session::create_session_simple(&mut state, "New thread", Some("/proj/a"));
        let rec = state.sessions.last().unwrap();
        assert_eq!(rec.cwd.as_deref(), Some("/proj/a"));
        assert_eq!(state.selected_session_id, rec.id);
    }

    #[tokio::test]
    async fn test_create_session_cwd_defaults_to_current_dir() {
        let store = Store::new();
        let mut state = store.state.lock().await;
        super::session::create_session_simple(&mut state, "New", None);
        let rec = state.sessions.last().unwrap();
        let expected = std::env::current_dir()
            .ok()
            .map(|p| p.to_string_lossy().into_owned());
        assert_eq!(rec.cwd, expected);
    }

    #[test]
    fn test_resolve_session_cwd_falls_back_to_current_dir() {
        let cwd = super::cwd::resolve_session_cwd(None);
        assert!(!cwd.is_empty());
    }

    #[test]
    fn test_resolve_session_cwd_empty_string_falls_back() {
        let cwd = super::cwd::resolve_session_cwd(Some(""));
        assert!(!cwd.is_empty());
    }

    // ── CwdAction / decide_cwd_action ─────────────────────────

    use super::cwd::{decide_cwd_action, CwdAction};

    #[test]
    fn test_decide_cwd_noop_when_same_path() {
        let a = decide_cwd_action(Some("/old/sess.jsonl"), "/work", Some("/work"));
        assert!(matches!(a, CwdAction::NoOp));
    }

    #[test]
    fn test_decide_cwd_set_in_place_when_no_session_file() {
        let a = decide_cwd_action(None, "/work", Some("/elsewhere"));
        assert!(matches!(a, CwdAction::SetInPlace));
    }

    #[test]
    fn test_decide_cwd_fork_when_has_session_file_and_diff_cwd() {
        let a = decide_cwd_action(Some("/old/sess.jsonl"), "/new/work", Some("/old/work"));
        assert!(matches!(a, CwdAction::Fork));
    }

    #[test]
    fn test_decide_cwd_fork_when_has_file_but_no_current_cwd() {
        let a = decide_cwd_action(Some("/old/sess.jsonl"), "/new/work", None);
        assert!(matches!(a, CwdAction::Fork));
    }
}
