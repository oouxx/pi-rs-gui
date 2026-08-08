//! Agent event serialization and display transcript building.

use pi_agent_core::pi_ai_types::ContentBlock;
use pi_agent_core::types::AgentMessage;
use pi_coding_agent::core::agent_session::AgentSessionEvent;
use serde_json::json;

/// Serialize an AgentSessionEvent into a (type, data) pair for the frontend.
/// Maps the core passthrough variants to their legacy frontend event types
/// and forwards session-specific events under their own type.
pub fn serialize_session_event(event: &AgentSessionEvent) -> (String, serde_json::Value) {
    match event {
        AgentSessionEvent::AgentStart => ("agent_start".into(), json!({})),
        AgentSessionEvent::AgentEnd { messages, will_retry } => (
            "agent_end".into(),
            json!({"messages": messages, "will_retry": will_retry}),
        ),
        AgentSessionEvent::TurnStart => ("turn_start".into(), json!({})),
        AgentSessionEvent::TurnEnd {
            message,
            tool_results,
        } => (
            "turn_end".into(),
            json!({"message": message, "tool_results": tool_results}),
        ),
        AgentSessionEvent::MessageStart { message } => {
            ("message_start".into(), json!({"message": message}))
        }
        AgentSessionEvent::MessageUpdate {
            assistant_message_event,
            ..
        } => (
            "message_update".into(),
            serde_json::to_value(assistant_message_event).unwrap_or_default(),
        ),
        AgentSessionEvent::MessageEnd { message } => {
            ("message_end".into(), json!({"message": message}))
        }
        AgentSessionEvent::ToolExecutionStart {
            tool_call_id,
            tool_name,
            args,
        } => (
            "tool_execution_start".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args}),
        ),
        AgentSessionEvent::ToolExecutionUpdate {
            tool_call_id,
            tool_name,
            args,
            partial_result,
        } => (
            "tool_execution_update".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "args": args, "partial_result": partial_result}),
        ),
        AgentSessionEvent::ToolExecutionEnd {
            tool_call_id,
            tool_name,
            result,
            is_error,
        } => (
            "tool_execution_end".into(),
            json!({"tool_call_id": tool_call_id, "tool_name": tool_name, "result": result, "is_error": is_error}),
        ),
        // ── Session-specific events ──
        AgentSessionEvent::AgentSettled => ("agent_settled".into(), json!({})),
        AgentSessionEvent::QueueUpdate { steering, follow_up } => (
            "queue_update".into(),
            json!({"steering": steering, "follow_up": follow_up}),
        ),
        AgentSessionEvent::CompactionStart { reason } => {
            ("compaction_start".into(), json!({"reason": reason}))
        }
        AgentSessionEvent::EntryAppended { entry } => {
            ("entry_appended".into(), json!({"entry": entry}))
        }
        AgentSessionEvent::SessionInfoChanged { name } => {
            ("session_info_changed".into(), json!({"name": name}))
        }
        AgentSessionEvent::ModelSelect {
            model,
            previous_model,
            source,
        } => (
            "model_select".into(),
            json!({"model": model, "previous_model": previous_model, "source": source}),
        ),
        AgentSessionEvent::ThinkingLevelChanged { level } => {
            ("thinking_level_changed".into(), json!({"level": level}))
        }
        AgentSessionEvent::CompactionEnd {
            reason,
            result,
            aborted,
            will_retry,
            error_message,
        } => (
            "compaction_end".into(),
            json!({"reason": reason, "result": result, "aborted": aborted, "will_retry": will_retry, "error_message": error_message}),
        ),
        AgentSessionEvent::AutoRetryStart {
            attempt,
            max_attempts,
            delay_ms,
            error_message,
        } => (
            "auto_retry_start".into(),
            json!({"attempt": attempt, "max_attempts": max_attempts, "delay_ms": delay_ms, "error_message": error_message}),
        ),
        AgentSessionEvent::AutoRetryEnd {
            success,
            attempt,
            final_error,
        } => (
            "auto_retry_end".into(),
            json!({"success": success, "attempt": attempt, "final_error": final_error}),
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
