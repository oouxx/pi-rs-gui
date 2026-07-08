//! Session tree + transcript — mirrors parts of `app-store-timeline.ts`.
//! Builds a SessionTreeSnapshot from the actual messages in a session.

use serde_json::json;
use pi_agent_core::types::AgentMessage;

/// Build a SessionTreeSnapshot from the current session's messages.
pub fn build_session_tree(session_id: &str, messages: &[AgentMessage]) -> serde_json::Value {
    let roots: Vec<serde_json::Value> = messages.iter().enumerate().map(|(i, msg)| {
        let (role, text, ts) = match msg {
            AgentMessage::User { content, timestamp } => {
                let text: String = content.iter()
                    .filter_map(|b| if let pi_agent_core::pi_ai_types::ContentBlock::Text { text, .. } = b { Some(text.clone()) } else { None })
                    .collect();
                ("user", text, *timestamp)
            }
            AgentMessage::Assistant { content, timestamp, .. } => {
                let text: String = content.iter()
                    .filter_map(|b| if let pi_agent_core::pi_ai_types::ContentBlock::Text { text, .. } = b { Some(text.clone()) } else { None })
                    .collect();
                ("assistant", text, *timestamp)
            }
            _ => ("system", String::new(), 0),
        };
        let preview = if text.len() > 80 {
            let truncated: String = text.chars().take(80).collect();
            format!("{}…", truncated)
        } else { text };
        json!({
            "id": format!("msg-{}", i),
            "kind": "message",
            "role": role,
            "title": format!("{} at {}", role, ts),
            "preview": preview,
            "children": [],
        })
    }).collect();

    json!({
        "id": session_id,
        "label": "root",
        "roots": roots,
        "leafId": messages.len().to_string(),
    })
}
