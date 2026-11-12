use std::sync::Arc;
use tauri::Manager;

mod commands;
mod state;

/// GUI apps launched from Finder inherit launchd's minimal PATH, so tools
/// installed by Homebrew/nvm (`npx`, `node`, …) are invisible to MCP servers
/// and child processes. Hydrate PATH from the user's login shell once.
#[cfg(unix)]
fn hydrate_path_from_login_shell() {
    use std::process::{Command, Stdio};

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let Ok(output) = Command::new(&shell)
        .args(["-ilc", "printf '__PI_PATH__%s\\n' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
    else {
        return;
    };
    if !output.status.success() {
        return;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    if let Some(line) = text
        .lines()
        .rev()
        .find(|line| line.starts_with("__PI_PATH__"))
    {
        let path = line.trim_start_matches("__PI_PATH__").trim();
        if !path.is_empty() {
            std::env::set_var("PATH", path);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(unix)]
    hydrate_path_from_login_shell();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(state::Store::new_with_runtime())
        .setup(|app| {
            // Spawn the restored selected session's actor at startup so
            // actor-backed queries (e.g. slash commands, session info) work
            // before the user sends a first message.
            let store = app.state::<Arc<state::Store>>().inner().clone();
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let _ = store.ensure_selected_actor(&handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_state,
            commands::select_session,
            commands::create_session,
            commands::archive_session,
            commands::rename_session,
            commands::delete_session,
            commands::set_session_cwd,
            commands::submit_composer,
            commands::cancel_current_run,
            commands::abort_session,
            commands::get_default_model,
            commands::get_models,
            commands::get_providers,
            commands::get_model_settings,
            commands::set_default_model,
            commands::set_default_thinking_level,
            commands::set_provider_api_key,
            commands::logout_provider,
            commands::set_custom_provider,
            commands::delete_custom_provider,
            commands::get_selected_transcript,
            commands::get_session_info,
            commands::fork_session_at,
            commands::clone_session,
            commands::import_session,
            commands::reload_session,
            commands::compact_session,
            commands::export_session,
            commands::share_session,
            commands::get_session_tree,
            commands::get_project_trust,
            commands::set_project_trust,
            commands::navigate_session_tree,
            commands::list_slash_commands,
            commands::terminal_start,
            commands::terminal_write,
            commands::terminal_resize,
            commands::terminal_stop,
            commands::terminal_stop_all,
            commands::file_completions,
            commands::open_file,
            commands::read_text_file,
            commands::get_general_settings,
            commands::set_session_model,
            commands::get_session_model,
            commands::set_session_thinking_level,
            commands::get_session_usage,
            commands::get_scoped_models,
            commands::set_scoped_models,
            commands::cycle_scoped_model,
            commands::search_sessions,
            commands::set_general_setting,
            commands::get_agent_dir,
            commands::list_skills,
            commands::get_skill,
            commands::list_prompt_templates,
            commands::list_extensions,
            commands::get_extension,
            commands::set_extension_enabled,
            commands::list_custom_providers,
            commands::get_custom_provider,
            commands::has_provider_auth,
            commands::list_mcp_servers,
            commands::save_mcp_server,
            commands::delete_mcp_server,
            commands::update_mcp_server,
            commands::reconnect_mcp_server,
            commands::sign_in_mcp_server,
            commands::get_mcp_log,
            commands::get_mcp_resources,
            commands::read_mcp_resource,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pi-gui-rs");
}
