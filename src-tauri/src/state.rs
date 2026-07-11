pub(crate) mod composer;
pub(crate) mod extensions;
pub(crate) mod git;
pub(crate) mod internal;
pub(crate) mod model;
pub(crate) mod persistence;
pub(crate) mod providers;
pub(crate) mod runtime;
pub(crate) mod session;
pub(crate) mod skills;

pub use internal::*;
pub use runtime::build_runtime_snapshot;

// ── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_initial_state() {
        let store = Store::new();
        let state = store.state.lock().await;
        assert_eq!(state.revision, 1);
        assert_eq!(state.active_view, "threads");
        assert!(state
            .global_model_settings
            .enabled_model_patterns
            .is_empty());
    }

    #[test]
    fn test_resolve_session_cwd_prefers_session_cwd() {
        let cwd = super::internal::resolve_session_cwd(Some("/usr/local"));
        assert_eq!(cwd, "/usr/local");
    }

    #[test]
    fn test_resolve_session_cwd_falls_back_to_current_dir() {
        let cwd = super::internal::resolve_session_cwd(None);
        // None 或空字符串都应回退到 current_dir，不应是空串
        assert!(!cwd.is_empty());
    }

    #[test]
    fn test_resolve_session_cwd_empty_string_falls_back() {
        let cwd = super::internal::resolve_session_cwd(Some(""));
        assert!(!cwd.is_empty());
    }

    // ── CwdAction / decide_cwd_action ─────────────────────────

    use super::internal::{decide_cwd_action, CwdAction};

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
        // 已有 session_file 但从未记录过 cwd（旧会话）：视为需要 fork 以带上历史
        let a = decide_cwd_action(Some("/old/sess.jsonl"), "/new/work", None);
        assert!(matches!(a, CwdAction::Fork));
    }
}
