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
        } => {
            // Split the assistant streaming event into granular deltas instead
            // of shipping the full partial snapshot on every update. The
            // session-level message_start / message_end events still carry the
            // complete message (self-healing anchors); these deltas drive
            // smooth incremental rendering.
            use pi_ai::types::AssistantMessageEvent;
            match assistant_message_event {
                AssistantMessageEvent::TextDelta {
                    content_index,
                    delta,
                    ..
                } => (
                    "text_delta".into(),
                    json!({ "contentIndex": content_index, "delta": delta }),
                ),
                AssistantMessageEvent::ThinkingDelta {
                    content_index,
                    delta,
                    ..
                } => (
                    "thinking_delta".into(),
                    json!({ "contentIndex": content_index, "delta": delta }),
                ),
                AssistantMessageEvent::ToolCallStart {
                    content_index,
                    partial,
                } => (
                    "toolcall_start".into(),
                    json!({ "contentIndex": content_index, "partial": partial }),
                ),
                AssistantMessageEvent::ToolCallDelta {
                    content_index,
                    delta,
                    ..
                } => (
                    "toolcall_delta".into(),
                    json!({ "contentIndex": content_index, "delta": delta }),
                ),
                AssistantMessageEvent::ToolCallEnd {
                    content_index,
                    tool_call,
                    ..
                } => (
                    "toolcall_end".into(),
                    json!({ "contentIndex": content_index, "toolCall": tool_call }),
                ),
                AssistantMessageEvent::Done { message, .. } => {
                    ("message_done".into(), json!({ "message": message }))
                }
                // Start / TextStart / TextEnd / ThinkingStart / ThinkingEnd
                // carry the full partial — message_start/message_end anchor the
                // message and the deltas carry the content, so these are no-ops.
                _ => ("message_update_ignored".into(), json!({})),
            }
        }
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
        AgentSessionEvent::SummarizationRetryScheduled {
            attempt,
            max_attempts,
            delay_ms,
            error_message,
        } => (
            "summarization_retry_scheduled".into(),
            json!({"attempt": attempt, "max_attempts": max_attempts, "delay_ms": delay_ms, "error_message": error_message}),
        ),
        AgentSessionEvent::SummarizationRetryAttemptStart { source, reason } => (
            "summarization_retry_attempt_start".into(),
            json!({"source": source, "reason": reason}),
        ),
        AgentSessionEvent::SummarizationRetryFinished {} => {
            ("summarization_retry_finished".into(), json!({}))
        }
        AgentSessionEvent::BashExecutionUpdate { id, delta } => (
            "bash_execution_update".into(),
            json!({"id": id, "delta": delta}),
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
    // Consecutive assistant messages (each step of a tool-calling run) are
    // merged into a single message so one agent run renders as one bubble
    // (Claude Code style), with text/thinking/toolCall blocks interleaved.
    let mut out: Vec<serde_json::Value> = Vec::new();
    for msg in msgs {
        let (role, content, ts, error_message) = match msg {
            AgentMessage::User { content, timestamp } => ("user", content, *timestamp, None),
            AgentMessage::Assistant {
                content,
                timestamp,
                error_message,
                ..
            } => ("assistant", content, *timestamp, error_message.clone()),
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

        if role == "assistant" {
            if let Some(last) = out.last_mut() {
                if last.get("role").and_then(|r| r.as_str()) == Some("assistant") {
                    // Merge: append this step's blocks to the last assistant
                    // message and recompute the flattened text.
                    if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                        if let Some(blocks) = blocks_val.as_array() {
                            arr.extend(blocks.iter().cloned());
                        }
                    }
                    if let Some(arr) = last.get("content").and_then(|c| c.as_array()) {
                        let merged_text: String = arr
                            .iter()
                            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                            .collect();
                        last["text"] = json!(merged_text);
                    }
                    // Propagate an error marker onto the merged bubble.
                    if let Some(err) = error_message {
                        if !err.is_empty() {
                            last["errorMessage"] = json!(err);
                        }
                    }
                    continue;
                }
            }
        }

        let ts_secs = ts as f64 / 1000.0;
        let created = chrono::DateTime::from_timestamp(ts_secs as i64, 0)
            .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
            .unwrap_or_else(|| {
                chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
            });

        let mut item = json!({
            "id": format!("msg-{}", ts),
            "kind": "message",
            "role": role,
            "text": text,
            "content": blocks_val,
            "createdAt": created,
        });
        if let Some(err) = error_message {
            if !err.is_empty() {
                item["errorMessage"] = json!(err);
            }
        }
        out.push(item);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use pi_agent_core::pi_ai_types::Usage;

    fn user(text: &str, ts: i64) -> AgentMessage {
        AgentMessage::User {
            content: vec![ContentBlock::text(text)],
            timestamp: ts,
        }
    }

    fn assistant(
        content: Vec<ContentBlock>,
        error_message: Option<&str>,
        ts: i64,
    ) -> AgentMessage {
        AgentMessage::Assistant {
            content,
            api: "test".into(),
            provider: "test".into(),
            model: "test".into(),
            usage: Usage::default(),
            stop_reason: None,
            error_message: error_message.map(str::to_string),
            timestamp: ts,
        }
    }

    fn tool_result(id: &str, text: &str, is_error: bool, ts: i64) -> AgentMessage {
        AgentMessage::ToolResult {
            tool_call_id: id.into(),
            tool_name: "bash".into(),
            content: vec![ContentBlock::text(text)],
            details: serde_json::json!({}),
            is_error,
            usage: None,
            timestamp: ts,
        }
    }

    fn tool_call(id: &str, ts: i64) -> AgentMessage {
        assistant(
            vec![ContentBlock::ToolCall {
                id: id.into(),
                name: "bash".into(),
                arguments: serde_json::json!({"command": "ls"}),
                thought_signature: None,
                namespace: None,
            }],
            None,
            ts,
        )
    }

    #[test]
    fn merges_agent_steps_and_injects_tool_results() {
        let transcript = build_display_transcript(&[
            user("run it", 1),
            tool_call("t1", 2),
            tool_result("t1", "ok", false, 3),
            assistant(vec![ContentBlock::text("done")], None, 4),
        ]);

        // user + one merged assistant bubble.
        assert_eq!(transcript.len(), 2);
        let bubble = &transcript[1];
        assert_eq!(bubble["role"], "assistant");
        assert_eq!(bubble["text"], "done");
        let blocks = bubble["content"].as_array().unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0]["type"], "toolCall");
        assert_eq!(blocks[0]["status"], "success");
        assert_eq!(blocks[0]["result"], "ok");
        assert_eq!(blocks[1]["text"], "done");
    }

    #[test]
    fn tool_failure_marks_the_tool_call_block() {
        let transcript = build_display_transcript(&[
            user("run it", 1),
            tool_call("t1", 2),
            tool_result("t1", "boom", true, 3),
        ]);

        let block = &transcript[1]["content"][0];
        assert_eq!(block["status"], "error");
        assert_eq!(block["isError"], true);
    }

    #[test]
    fn keeps_last_error_message_on_the_merged_bubble() {
        let transcript = build_display_transcript(&[
            user("hi", 1),
            assistant(vec![ContentBlock::text("part")], None, 2),
            assistant(vec![ContentBlock::text("retry failed")], Some("boom"), 3),
        ]);

        assert_eq!(transcript.len(), 2);
        assert_eq!(transcript[1]["errorMessage"], "boom");
    }
}
