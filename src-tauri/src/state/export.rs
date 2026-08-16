//! Session export (HTML / JSONL) — delegates to pi-rs rendering/loading.
//!
//! HTML is rendered by pi-rs `render_session_html` from a `SessionManager`
//! opened on the session file; JSONL is a copy of the session file (which is
//! already header + entries, matching TS `exportToJsonl` for linear sessions).

use std::path::Path;

use pi_coding_agent::core::session_manager::SessionManager;

/// Export the session file to `target_path`. Returns the written path.
pub fn export_session(session_file: &str, format: &str, target_path: &str) -> Result<String, String> {
    let target = Path::new(target_path);

    if let Some(dir) = target.parent() {
        if !dir.as_os_str().is_empty() && !dir.exists() {
            std::fs::create_dir_all(dir).map_err(|e| format!("failed to create directory: {e}"))?;
        }
    }

    match format {
        "html" => {
            let mgr = SessionManager::open(session_file, None, None);
            let html = pi_coding_agent::core::agent_session::render_session_html(&mgr);
            std::fs::write(target, html).map_err(|e| format!("failed to write HTML: {e}"))?;
        }
        "jsonl" => {
            std::fs::copy(session_file, target)
                .map_err(|e| format!("failed to copy session file: {e}"))?;
        }
        other => return Err(format!("unsupported export format '{other}'")),
    }

    Ok(target.to_string_lossy().to_string())
}

