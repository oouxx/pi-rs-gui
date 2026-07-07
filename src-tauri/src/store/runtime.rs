//! Runtime snapshot builder — mirrors original
//! `runtimeSupervisor.refreshRuntime()` in the electron app.

use serde_json::json;

/// Reads pi-ai model registry + settings + env vars to build the
/// runtime snapshot the frontend needs for model lists.
pub fn build_runtime_snapshot() -> serde_json::Value {
    pi_ai::providers::register_builtins::register_built_in_api_providers();
    use pi_coding_agent::core::model_registry::ModelRegistry;
    use pi_coding_agent::core::settings_manager::SettingsManager;
    use pi_coding_agent::core::provider_display_names::BUILT_IN_PROVIDER_DISPLAY_NAMES;

    let registry = ModelRegistry::new(ModelRegistry::builtin_models_list());
    let s = SettingsManager::create("/tmp", None);
    let settings = s.get_settings();

    let env_keys: std::collections::HashMap<&str, &str> = [
        ("anthropic","ANTHROPIC_API_KEY"),("openai","OPENAI_API_KEY"),
        ("google","GOOGLE_API_KEY"),("deepseek","DEEPSEEK_API_KEY"),
        ("openrouter","OPENROUTER_API_KEY"),("mistral","MISTRAL_API_KEY"),
        ("groq","GROQ_API_KEY"),("xai","XAI_API_KEY"),
    ].iter().cloned().collect();

    let providers = registry.get_providers();
    let mut models = Vec::new();
    let mut provider_list = Vec::new();
    let skills: Vec<serde_json::Value> = Vec::new();

    for pid in &providers {
        let has_auth = env_keys.get(pid.as_str())
            .and_then(|k| std::env::var(k).ok())
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

    json!({
        "models": models,
        "providers": provider_list,
        "skills": skills,
        "commands": [],
        "settings": {
            "enabledModelPatterns": [],
            "defaultProvider": settings.default_provider,
            "defaultModelId": settings.default_model,
            "defaultThinkingLevel": settings.thinking_level,
        }
    })
}
