//! Terminal pty stubs — aligns with original `terminal-service.ts`.
//! Original uses node-pty for real PTY sessions. Here we return
//! empty terminal panel snapshots until a PTY integration is wired in.

use serde_json::json;

pub fn stub_terminal_panel(workspace_id: &str, root_key: &str) -> serde_json::Value {
    json!({
        "workspaceId": workspace_id,
        "rootKey": root_key,
        "activeSessionId": "",
        "sessions": [],
    })
}
