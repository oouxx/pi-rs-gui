mod commands;
mod state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(state::Store::new_with_runtime())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            commands::get_state,
            commands::select_session,
            commands::create_session,
            commands::archive_session,
            commands::rename_session,
            commands::delete_session,
            commands::set_session_cwd,
            commands::submit_composer,
            commands::cancel_current_run,
            commands::get_default_model,
            commands::get_models,
            commands::get_providers,
            commands::get_model_settings,
            commands::set_default_model,
            commands::set_default_thinking_level,
            commands::set_provider_api_key,
            commands::login_provider,
            commands::logout_provider,
            commands::set_custom_provider,
            commands::delete_custom_provider,
            commands::get_selected_transcript,
            commands::list_custom_providers,
            commands::get_custom_provider,
            commands::has_provider_auth,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pi-gui-rs");
}
