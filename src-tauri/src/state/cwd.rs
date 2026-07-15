//! Working directory resolution and cwd-change decision logic.

/// Resolve the working directory for a session: prefer the session's stored
/// cwd (when non-empty), else fall back to the process current directory.
/// Matches pi-rs TS original: `process.cwd()`.
pub fn resolve_session_cwd(session_cwd: Option<&str>) -> String {
    session_cwd
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|_| "/tmp".into())
        })
}

/// Decision for `set_session_cwd`: what to do when the user picks a new folder.
#[derive(Debug, Clone, PartialEq)]
pub enum CwdAction {
    /// Same as current cwd — do nothing.
    NoOp,
    /// Session has no agent session yet — set cwd in place on the record.
    SetInPlace,
    /// Session already has history — fork a new session (new cwd, copied history).
    Fork,
}

/// Decide the cwd action based on whether the session is already initialized
/// (has a session_file) and whether the new path differs from the current cwd.
pub fn decide_cwd_action(
    session_file: Option<&str>,
    new_path: &str,
    current_cwd: Option<&str>,
) -> CwdAction {
    if current_cwd.map(|c| c == new_path).unwrap_or(false) {
        return CwdAction::NoOp;
    }
    match session_file {
        None => CwdAction::SetInPlace,
        Some(_) => CwdAction::Fork,
    }
}
