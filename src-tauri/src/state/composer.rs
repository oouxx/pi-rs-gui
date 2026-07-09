//! Composer operations.

use serde_json::Value;
use crate::state::internal::DesktopState;

pub fn update_composer_draft(state: &mut DesktopState, draft: &str) {
    state.composer_draft = draft.to_string();
    state.composer_draft_sync_source = Some("state".to_string());
    state.composer_draft_sync_nonce += 1;
}

pub fn set_composer_attachments(state: &mut DesktopState, attachments: Value) {
    if let Value::Array(arr) = attachments {
        state.composer_attachments = arr;
    }
}

pub fn remove_composer_attachment(state: &mut DesktopState, attachment_id: &str) {
    state.composer_attachments.retain(|a| a["id"] != attachment_id);
}

pub fn edit_queued_message(state: &mut DesktopState, message_id: &str, current_draft: Option<&str>) {
    state.editing_queued_message_id = Some(message_id.to_string());
    if let Some(d) = current_draft {
        state.composer_draft = d.to_string();
    }
}

pub fn cancel_queued_edit(state: &mut DesktopState) {
    state.editing_queued_message_id = None;
}

pub fn remove_queued_message(state: &mut DesktopState, message_id: &str) {
    state.queued_composer_messages.retain(|m| m["id"] != message_id);
}

pub fn steer_queued_message(state: &mut DesktopState, message_id: &str) {
    if let Some(m) = state.queued_composer_messages.iter_mut().find(|m| m["id"] == message_id) {
        m["mode"] = Value::String("steer".to_string());
    }
}
