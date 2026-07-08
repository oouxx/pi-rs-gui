pub(crate) mod git;
pub(crate) mod terminal;
pub(crate) mod internal;
pub(crate) mod runtime;
pub(crate) mod workspace;
pub(crate) mod session;
pub(crate) mod composer;
pub(crate) mod model;
pub(crate) mod theme;
pub(crate) mod notifications;
pub(crate) mod orchestration;
pub(crate) mod worktree;
pub(crate) mod timeline;
pub(crate) mod providers;
pub(crate) mod persistence;
pub(crate) mod skills;
pub(crate) mod extensions;

pub use internal::*;
pub use runtime::build_runtime_snapshot;

// ── Tests ──────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;

    #[tokio::test]
    async fn test_initial_state() {
        let store = Store::new();
        let state = store.state.lock().await;
        assert_eq!(state["revision"], 1);
        assert_eq!(state["selectedWorkspaceId"], "ws-default");
        assert_eq!(state["activeView"], "threads");
        assert_eq!(state["globalModelSettings"]["enabledModelPatterns"].as_array().unwrap().len(), 0);
        assert!(state["runtimeByWorkspace"].as_object().unwrap().is_empty());
    }

    #[tokio::test]
    async fn test_default_model_on_new_workspace() {
        let store = Store::new();
        let ws_id = "ws-new".to_string();
        let mut state = store.state.lock().await;
        if state["runtimeByWorkspace"][&ws_id].is_null() {
            state["runtimeByWorkspace"][&ws_id] = json!({"settings": {}});
        }
        state["runtimeByWorkspace"][&ws_id]["settings"]["defaultProvider"] = json!("openrouter");
        state["runtimeByWorkspace"][&ws_id]["settings"]["defaultModelId"] = json!("free");
        drop(state);
        let state = store.state.lock().await;
        assert_eq!(state["runtimeByWorkspace"]["ws-new"]["settings"]["defaultProvider"], "openrouter");
        assert_eq!(state["runtimeByWorkspace"]["ws-new"]["settings"]["defaultModelId"], "free");
    }

    #[tokio::test]
    #[ignore = "Requires OPENROUTER_API_KEY"]
    async fn test_conversation_with_openrouter_free() {
        let key = std::env::var("OPENROUTER_API_KEY").expect("Set OPENROUTER_API_KEY env var");
        pi_ai::providers::register_builtins::register_built_in_api_providers();
        let model = pi_agent_core::pi_ai_types::Model {
            id: "free".into(), name: "OpenRouter Free".into(), api: "openai-completions".into(),
            provider: "openrouter".into(), base_url: "https://openrouter.ai/api/v1".into(),
            reasoning: false, thinking_level_map: None, input: vec!["text".into()],
            cost: pi_agent_core::pi_ai_types::ModelCost { input: 0.0, output: 0.0, cache_read: 0.0, cache_write: 0.0 },
            context_window: 100_000, max_tokens: 1_000, headers: None,
            compat: Some(pi_agent_core::pi_ai_types::ModelCompat::OpenAICompletions(
                pi_agent_core::pi_ai_types::OpenAICompletionsCompat {
                    supports_store: None, supports_developer_role: None, supports_reasoning_effort: None,
                    supports_usage_in_streaming: None, max_tokens_field: None, requires_tool_result_name: None,
                    requires_assistant_after_tool_result: None, requires_thinking_as_text: None,
                    requires_reasoning_content_on_assistant_messages: None, thinking_format: None,
                    open_router_routing: None, vercel_gateway_routing: None, zai_tool_stream: None,
                    supports_strict_mode: None, cache_control_format: None, send_session_affinity_headers: None,
                    supports_long_cache_retention: None,
                },
            )),
        };
        std::env::set_var("OPENROUTER_API_KEY", &key);
        let cwd = std::env::current_dir().map(|p| p.to_string_lossy().to_string()).unwrap_or_else(|_| std::env::var("HOME").unwrap_or_else(|_| "/tmp".into()));
        let agent_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join(".pi-rs-test-agent-openrouter");
        std::fs::create_dir_all(&agent_dir).ok();
        let options = pi_coding_agent::core::sdk::CreateAgentSessionOptions {
            cwd, agent_dir: Some(agent_dir.to_string_lossy().to_string()),
            model: Some(model), thinking_level: Some("normal".into()),
            scoped_models: None, no_tools: None, tools: None, exclude_tools: None,
            custom_prompt: Some("You are a helpful assistant. Keep responses very brief.".into()),
            append_system_prompt: None, session_name: Some("test-openrouter".into()),
            stream_fn: None, convert_to_llm: None, extension_paths: vec![],
            enable_extensions: false, cli_provider: None, cli_model: None,
            persist_session: false, session_file: None,
        };
        let (mut session, _result) = pi_coding_agent::core::sdk::create_agent_session(options).await.expect("create_agent_session failed");
        let response_text = Arc::new(tokio::sync::Mutex::new(String::new()));
        let rt = response_text.clone();
        use pi_agent_core::pi_ai_types::AssistantMessageEvent;
        use pi_agent_core::types::AgentEvent;
        let listener: Arc<dyn Fn(AgentEvent, Option<tokio::sync::watch::Receiver<bool>>) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>> + Send + Sync> = Arc::new(move |event: AgentEvent, _signal| {
            let rt = rt.clone();
            Box::pin(async move {
                match &event {
                    AgentEvent::MessageUpdate { assistant_message_event, .. } => {
                        if let AssistantMessageEvent::TextDelta { delta, .. } = assistant_message_event { rt.lock().await.push_str(delta); }
                    }
                    AgentEvent::MessageEnd { message: msg } => {
                        if let pi_agent_core::types::AgentMessage::Assistant { content, .. } = msg {
                            let t: String = content.iter().filter_map(|b| if let pi_agent_core::pi_ai_types::ContentBlock::Text { text, .. } = b { Some(text.clone()) } else { None }).collect();
                            if !t.is_empty() { rt.lock().await.push_str(&t); }
                        }
                    }
                    _ => {}
                }
            }) as std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send>>
        });
        session.subscribe(listener).await;
        session.add_user_text("Say 'hello' in one word.").await;
        session.wait_for_idle().await;
        let turn1 = response_text.lock().await.clone();
        eprintln!("[test] Turn1: '{turn1}'"); assert!(!turn1.is_empty(), "Turn 1 empty");
        response_text.lock().await.clear();
        session.add_user_text("Now say 'goodbye' in one word.").await;
        session.wait_for_idle().await;
        let turn2 = response_text.lock().await.clone();
        eprintln!("[test] Turn2: '{turn2}'"); assert!(!turn2.is_empty(), "Turn 2 empty");
        response_text.lock().await.clear();
        session.add_user_text("What was the first word I asked you to say?").await;
        session.wait_for_idle().await;
        let turn3 = response_text.lock().await.clone();
        eprintln!("[test] Turn3: '{turn3}'"); assert!(!turn3.is_empty(), "Turn 3 empty");
        assert!(turn3.to_lowercase().contains("hello"), "Turn 3 should refer to 'hello'");
        let messages = session.get_messages().await;
        eprintln!("[test] Total messages: {}", messages.len());
        assert!(messages.len() >= 6, "Expected ≥6 messages");
    }
}
