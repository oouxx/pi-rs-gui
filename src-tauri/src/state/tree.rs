//! Session tree (timeline) — fork navigation support for the GUI.
//!
//! Delegates tree building to pi-rs `SessionManager::get_tree()` /
//! `AgentSession::get_tree()`; this module only maps entries to display labels.

use pi_coding_agent::core::session_manager::{SessionEntry, SessionManager, SessionTreeNode};
use serde_json::{json, Value};

/// Truncate a label to a display length.
fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        t.to_string()
    } else {
        let cut: String = t.chars().take(max).collect();
        format!("{cut}…")
    }
}

/// Extract role + preview text from a session message JSON value.
fn message_info(message: &Value) -> (Option<String>, String) {
    let role = message
        .get("role")
        .and_then(|r| r.as_str())
        .map(|r| r.to_string());
    let mut text = String::new();
    if let Some(content) = message.get("content").and_then(|c| c.as_array()) {
        for block in content {
            match block.get("type").and_then(|t| t.as_str()) {
                Some("text") => {
                    if let Some(t) = block.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
                Some("toolCall") => {
                    let name = block.get("name").and_then(|n| n.as_str()).unwrap_or("tool");
                    text.push_str(&format!("[tool: {name}] "));
                }
                _ => {}
            }
        }
    }
    (role, truncate(&text, 200))
}

/// Map a session entry to (kind, detail, role). The frontend localizes the
/// kind; `detail` stays raw so labels follow the UI language.
fn entry_info(entry: &SessionEntry) -> (String, String, Option<String>) {
    match entry {
        SessionEntry::Message { message, .. } => {
            let (role, detail) = message_info(message);
            ("message".to_string(), detail, role)
        }
        SessionEntry::Usage { kind, .. } => ("usage".to_string(), kind.clone(), None),
        SessionEntry::ContextEdit { target_id, .. } => {
            ("context_edit".to_string(), truncate(target_id, 120), None)
        }
        SessionEntry::ThinkingLevelChange { thinking_level, .. } => (
            "thinking_level_change".to_string(),
            thinking_level.clone(),
            None,
        ),
        SessionEntry::ModelChange {
            provider, model_id, ..
        } => (
            "model_change".to_string(),
            format!("{provider}/{model_id}"),
            None,
        ),
        SessionEntry::Compaction { summary, .. } => {
            ("compaction".to_string(), truncate(summary, 200), None)
        }
        SessionEntry::BranchSummary { summary, .. } => {
            ("branch_summary".to_string(), truncate(summary, 200), None)
        }
        SessionEntry::Custom { custom_type, .. } => {
            ("custom".to_string(), custom_type.clone(), None)
        }
        SessionEntry::CustomMessage {
            custom_type,
            content,
            ..
        } => {
            let detail = content
                .as_str()
                .map(|s| truncate(s, 200))
                .unwrap_or_else(|| custom_type.clone());
            ("custom_message".to_string(), detail, None)
        }
        SessionEntry::Label { label, .. } => {
            ("label".to_string(), label.clone().unwrap_or_default(), None)
        }
        SessionEntry::SessionInfo { name, .. } => (
            "session_info".to_string(),
            name.clone().unwrap_or_default(),
            None,
        ),
    }
}

fn node_json(node: &SessionTreeNode, leaf_id: Option<&str>) -> Value {
    let (kind, detail, role) = entry_info(&node.entry);
    json!({
        "id": node.entry.id(),
        "parentId": node.entry.parent_id(),
        "kind": kind,
        "role": role,
        "detail": detail,
        "timestamp": node.entry.timestamp(),
        "current": leaf_id.is_some_and(|l| l == node.entry.id()),
        "children": node
            .children
            .iter()
            .map(|c| node_json(c, leaf_id))
            .collect::<Vec<_>>(),
    })
}

/// Serialize a forest of tree nodes (from pi-rs) for the frontend.
pub fn tree_json(nodes: &[SessionTreeNode], leaf_id: Option<&str>) -> Vec<Value> {
    nodes.iter().map(|n| node_json(n, leaf_id)).collect()
}

/// Build the tree for a non-active session by opening its session file.
pub fn tree_from_session_file(session_file: &str) -> Vec<Value> {
    let mgr = SessionManager::open(session_file, None, None);
    tree_json(&mgr.get_tree(), mgr.get_leaf_id())
}
