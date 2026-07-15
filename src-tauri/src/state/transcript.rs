//! Agent event serialization and display transcript building.

use pi_agent_core::pi_ai_types::ContentBlock;
use pi_agent_core::types::{AgentEvent, AgentMessage};
use serde_json::json;

/// Serialize an AgentEvent into a (type, data) pair for the frontend.
pub fn serialize_event(event: &AgentEvent) -> (String, serde_json::Value) {
    match event {
        AgentEvent::AgentStart => ("agent_start".into(), json!({})),
        AgentEvent::AgentEnd { messages } => ("agent_end".into(), json!({"messages": messages})),
        AgentEvent::TurnStart => ("turn_start".into(), json!({})),
        AgentEvent::TurnEnd {
            message,
            tool_results,
        } => (
            "turn_end".into(),
            json!({"message": message, "tool_results": tool_results}),
        ),
        AgentEvent::MessageStart { message } => {
            ("message_start".into(), json!({"message": message}))
        }
        AgentEvent::MessageUpdate {
            assistant_message_event,
            ..
        } => (
            "message_update".into(),
            serde_json::to_value(assistant_message_event).unwrap_or_default(),
        ),
        AgentEvent::MessageEnd { message } => ("message_end".into(), json!({"message": message})),
        AgentEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => (
            "tool_execution_start".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args}),
        ),
        AgentEvent::ToolExecutionUpdate {
            tool_call_id,
            tool_name,
            args,
            partial_result,
        } => (
            "tool_execution_update".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args, "partial_result": partial_result}),
        ),
        AgentEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            result,
            is_error,
        } => (
            "tool_execution_end".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "result": result, "is_error": is_error}),
        ),
    }
}

/// Build a display transcript from agent messages, preserving structured
/// content blocks (text/thinking/toolCall) instead of flattening to plain
/// text. Tool results are merged onto their corresponding toolCall blocks so
/// the frontend can render `ToolCallCard` with `status`/`result`/`isError`
/// both after a turn completes and on session reload.
pub fn build_display_transcript(msgs: &[AgentMessage]) -> Vec<serde_json::Value> {
    // First pass: collect tool results keyed by tool_call_id.
    let mut tool_results: std::collections::HashMap<String, (String, bool)> =
        std::collections::HashMap::new();
    for msg in msgs {
        if let AgentMessage::ToolResult {
            tool_call_id,
            content,
            is_error,
            ..
        } = msg
        {
            let text: String = content
                .iter()
                .filter_map(|b| {
                    if let ContentBlock::Text { text, .. } = b {
                        Some(text.clone())
                    } else {
                        None
                    }
                })
                .collect();
            tool_results.insert(tool_call_id.clone(), (text, *is_error));
        }
    }

    // Second pass: emit user/assistant messages with structured content blocks.
    let mut out = Vec::new();
    for msg in msgs {
        let (role, content, ts) = match msg {
            AgentMessage::User { content, timestamp } => ("user", content, *timestamp),
            AgentMessage::Assistant {
                content, timestamp, ..
            } => ("assistant", content, *timestamp),
            _ => continue,
        };

        // Serialize full content blocks, then inject tool execution state
        // onto toolCall blocks from the matching toolResult message.
        let mut blocks_val = serde_json::to_value(content).unwrap_or(json!([]));
        if let Some(arr) = blocks_val.as_array_mut() {
            for b in arr.iter_mut() {
                if b.get("type").and_then(|t| t.as_str()) == Some("toolCall") {
                    if let Some(id) = b.get("id").and_then(|i| i.as_str()) {
                        if let Some((result, is_error)) = tool_results.get(id) {
                            b["status"] = json!(if *is_error { "error" } else { "success" });
                            b["result"] = json!(result);
                            b["isError"] = json!(is_error);
                        }
                    }
                }
            }
        }

        // Flattened text is kept for backward compatibility; the frontend
        // prefers the structured `content` array when present.
        let text: String = content
            .iter()
            .filter_map(|b| {
                if let ContentBlock::Text { text, .. } = b {
                    Some(text.clone())
                } else {
                    None
                }
            })
            .collect();

        let ts_secs = ts as f64 / 1000.0;
        let created = chrono::DateTime::from_timestamp(ts_secs as i64, 0)
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .unwrap_or_else(|| {
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            });

        out.push(json!({
            "id": format!("msg-{}", ts),
            "kind": "message",
            "role": role,
            "text": text,
            "content": blocks_val,
            "createdAt": created,
        }));
    }
    out
}
