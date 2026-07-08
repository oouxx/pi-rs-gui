mod state;
mod commands;
mod events;
mod error;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(state::Store::new_with_runtime())
        .invoke_handler(tauri::generate_handler![
            // Core
            commands::ping,
            commands::get_state,
            // Agent session
            commands::create_agent_session_cmd,
            commands::send_message_cmd,
            commands::abort_cmd,
            commands::is_streaming_cmd,
            commands::get_messages_cmd,
            // Workspace
            commands::add_workspace_path,
            commands::pick_workspace,
            commands::select_workspace,
            commands::rename_workspace,
            commands::remove_workspace,
            commands::reorder_workspaces,
            commands::reorder_pinned_sessions,
            commands::open_workspace_in_finder,
            commands::create_worktree,
            commands::remove_worktree,
            commands::open_skill_in_finder,
            commands::open_extension_in_finder,
            commands::sync_current_workspace,
            // Session
            commands::select_session,
            commands::archive_session,
            commands::unarchive_session,
            commands::set_session_pinned,
            commands::create_session,
            commands::rename_session,
            commands::start_thread,
            commands::fork_thread,
            commands::send_child_thread_follow_up,
            commands::set_child_supervision_loop,
            commands::cancel_current_run,
            // View
            commands::set_active_view,
            commands::set_sidebar_collapsed,
            commands::refresh_runtime,
            // Model
            commands::get_default_model,
            commands::set_model_settings_scope_mode,
            commands::set_default_model,
            commands::set_default_thinking_level,
            commands::set_session_model,
            commands::set_session_thinking_level,
            commands::login_provider,
            commands::logout_provider,
            commands::set_provider_api_key,
            commands::list_custom_providers,
            commands::get_custom_provider,
            commands::set_custom_provider,
            commands::delete_custom_provider,
            commands::probe_custom_provider_models,
            commands::has_provider_auth,
            commands::set_enable_skill_commands,
            commands::set_scoped_model_patterns,
            commands::set_skill_enabled,
            commands::set_extension_enabled,
            commands::respond_to_host_ui_request,
            // Runtime
            commands::get_runtime_info,
            // Notifications
            commands::set_notification_preferences,
            commands::set_integrated_terminal_shell,
            commands::set_enable_transparency,
            commands::get_notification_permission_status,
            commands::request_notification_permission,
            commands::open_system_notification_settings,
            // Composer
            commands::pick_composer_attachments,
            commands::add_composer_attachments,
            commands::remove_composer_attachment,
            commands::edit_queued_composer_message,
            commands::cancel_queued_composer_edit,
            commands::remove_queued_composer_message,
            commands::steer_queued_composer_message,
            commands::update_composer_draft,
            commands::submit_composer,
            // Session tree
            commands::get_session_tree,
            commands::navigate_session_tree,
            // Workspace files
            commands::list_workspace_files,
            commands::read_workspace_file,
            commands::get_changed_files,
            commands::get_file_diff,
            commands::stage_file,
            // Window
            commands::toggle_window_maximize,
            commands::open_external,
            // Theme
            commands::get_theme_mode,
            commands::get_resolved_theme,
            commands::set_theme_mode,
            commands::set_theme_preset_id,
            // Transcript
            commands::get_selected_transcript,
            // Terminal
            commands::ensure_terminal_panel,
            commands::create_terminal_session,
            commands::set_active_terminal_session,
            commands::write_terminal,
            commands::resize_terminal,
            commands::restart_terminal_session,
            commands::close_terminal_session,
            commands::set_terminal_title,
            commands::set_terminal_focused,
            // Model CRUD
            commands::get_models,
            commands::get_providers,
            commands::get_model_settings,
            // Skill CRUD
            commands::list_skills,
            commands::get_skill,
            commands::delete_skill,
            // Extension CRUD
            commands::list_extensions,
            commands::get_extension,
            commands::delete_extension,
        ])
        .run(tauri::generate_context!())
        .expect("error while running pi-gui-rs");
}
