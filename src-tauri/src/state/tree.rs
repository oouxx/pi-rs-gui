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

/// Extract role + text label from a session message JSON value.
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
                    let name = block
                        .get("name")
                        .and_then(|n| n.as_str())
                        .unwrap_or("tool");
                    text.push_str(&format!("[tool: {name}] "));
                }
                _ => {}
            }
        }
    }
    let label = match role.as_deref() {
        Some("user") => format!("User: {}", truncate(&text, 80)),
        Some("assistant") => format!("AI: {}", truncate(&text, 80)),
        _ => truncate(&text, 80),
    };
    (role, label)
}

/// Map a session entry to (kind, display label).
fn entry_info(entry: &SessionEntry) -> (String, String) {
    match entry {
        SessionEntry::Message { message, .. } => {
            let (_role, label) = message_info(message);
            ("message".to_string(), label)
        }
        SessionEntry::ThinkingLevelChange { thinking_level, .. } => (
            "thinking_level_change".to_string(),
            format!("Thinking: {thinking_level}"),
        ),
        SessionEntry::ModelChange {
            provider, model_id, ..
        } => (
            "model_change".to_string(),
            format!("Model: {provider}/{model_id}"),
        ),
        SessionEntry::Compaction { summary, .. } => (
            "compaction".to_string(),
            format!("Compaction: {}", truncate(summary, 80)),
        ),
        SessionEntry::BranchSummary { summary, .. } => (
            "branch_summary".to_string(),
            format!("Branch: {}", truncate(summary, 80)),
        ),
        SessionEntry::Custom { custom_type, .. } => (
            "custom".to_string(),
            format!("Event: {custom_type}"),
        ),
        SessionEntry::CustomMessage {
            custom_type,
            content,
            ..
        } => {
            let label = content
                .as_str()
                .map(|s| truncate(s, 80))
                .unwrap_or_else(|| format!("Event: {custom_type}"));
            ("custom_message".to_string(), label)
        }
        SessionEntry::Label { label, .. } => (
            "label".to_string(),
            label.clone().unwrap_or_else(|| "Label".to_string()),
        ),
        SessionEntry::SessionInfo { name, .. } => (
            "session_info".to_string(),
            format!("Session: {}", name.clone().unwrap_or_default()),
        ),
    }
}

fn node_json(node: &SessionTreeNode, leaf_id: Option<&str>) -> Value {
    let (kind, label) = entry_info(&node.entry);
    json!({
        "id": node.entry.id(),
        "parentId": node.entry.parent_id(),
        "kind": kind,
        "label": label,
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

