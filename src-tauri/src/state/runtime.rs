//! Runtime snapshot builder.

use serde_json::json;
use crate::state::internal::{RuntimeSnapshot, RuntimeSettings};

/// Read settings from the global pi-rs agent directory (~/.pi-rs/agent/).
fn load_default_settings() -> pi_coding_agent::core::settings_manager::Settings {
    let agent_dir = pi_coding_agent::config::get_agent_dir();
    let mgr = pi_coding_agent::core::settings_manager::SettingsManager::create(
        agent_dir.to_string_lossy().as_ref(),
        Some(agent_dir.to_string_lossy().as_ref()),
    );
    mgr.get_global_settings().clone()
}

/// List of (provider_id, env_var_name) pairs used to determine `hasAuth`.
fn provider_env_keys() -> Vec<(&'static str, &'static str)> {
    vec![
        ("anthropic", "ANTHROPIC_API_KEY"),
        ("openai", "OPENAI_API_KEY"),
        ("google", "GOOGLE_API_KEY"),
        ("deepseek", "DEEPSEEK_API_KEY"),
        ("openrouter", "OPENROUTER_API_KEY"),
        ("mistral", "MISTRAL_API_KEY"),
        ("groq", "GROQ_API_KEY"),
        ("xai", "XAI_API_KEY"),
        ("cerebras", "CEREBRAS_API_KEY"),
        ("together", "TOGETHER_API_KEY"),
        ("fireworks", "FIREWORKS_API_KEY"),
        ("github-copilot", "COPILOT_API_KEY"),
        ("huggingface", "HF_API_KEY"),
        ("minimax", "MINIMAX_API_KEY"),
        ("moonshotai", "MOONSHOT_API_KEY"),
        ("kimi-coding", "KIMI_CODING_API_KEY"),
    ]
}

/// Reads pi-ai model registry + settings + env vars to build the
/// runtime snapshot the frontend needs for model lists.
pub fn build_runtime_snapshot() -> RuntimeSnapshot {
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    use pi_coding_agent::core::model_registry::ModelRegistry;
    use pi_coding_agent::core::provider_display_names::BUILT_IN_PROVIDER_DISPLAY_NAMES;

    let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
    let settings = load_default_settings();

    let providers = registry.get_providers();
    let mut models = Vec::new();
    let mut provider_list = Vec::new();

    for pid in &providers {
        let has_auth = provider_env_keys().iter()
            .find(|(p, _)| *p == pid.as_str())
            .and_then(|(_, k)| std::env::var(k).ok())
            .map(|v| !v.is_empty() && v != "placeholder")
            .unwrap_or(false);

        let name = BUILT_IN_PROVIDER_DISPLAY_NAMES
            .get(pid.as_str())
            .map(|n| n.to_string())
            .unwrap_or_else(|| {
                let mut n = pid.clone();
                if let Some(c) = n.as_mut_str().get_mut(0..1) { c.make_ascii_uppercase(); }
                n
            });

        provider_list.push(json!({"id": pid, "name": name, "hasAuth": has_auth}));

        for m in registry.get_models_for_provider(pid) {
            models.push(json!({
                "providerId": pid,
                "modelId": m.id,
                "providerName": name,
                "label": if m.name.is_empty() { m.id } else { m.name },
                "available": has_auth,
            }));
        }
    }

    RuntimeSnapshot {
        models,
        providers: provider_list,
        skills: vec![],
        commands: vec![],
        settings: RuntimeSettings {
            enabled_model_patterns: vec![],
            default_provider: settings.default_provider,
            default_model_id: settings.default_model,
            default_thinking_level: settings.thinking_level,
        },
    }
}
