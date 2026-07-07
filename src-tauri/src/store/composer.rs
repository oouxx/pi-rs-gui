//! Composer operations — mirrors original `app-store-composer.ts`.

use serde_json::json;
use crate::store::internal::DesktopState;

pub fn update_composer_draft(state: &mut DesktopState, draft: &str) {
    state["composerDraft"] = json!(draft);
    state["composerDraftSyncSource"] = json!("state");
    let nonce = state["composerDraftSyncNonce"].as_u64().unwrap_or(0) + 1;
    state["composerDraftSyncNonce"] = json!(nonce);
}

pub fn set_composer_attachments(state: &mut DesktopState, attachments: serde_json::Value) {
    state["composerAttachments"] = attachments;
}

pub fn remove_composer_attachment(state: &mut DesktopState, attachment_id: &str) {
    if let Some(arr) = state["composerAttachments"].as_array_mut() {
        arr.retain(|a| a["id"] != attachment_id);
    }
}

pub fn edit_queued_message(state: &mut DesktopState, message_id: &str, current_draft: Option<&str>) {
    state["editingQueuedMessageId"] = json!(message_id);
    if let Some(d) = current_draft {
        state["composerDraft"] = json!(d);
    }
}

pub fn cancel_queued_edit(state: &mut DesktopState) {
    state["editingQueuedMessageId"] = serde_json::Value::Null;
}

pub fn remove_queued_message(state: &mut DesktopState, message_id: &str) {
    if let Some(arr) = state["queuedComposerMessages"].as_array_mut() {
        arr.retain(|m| m["id"] != message_id);
    }
}

pub fn steer_queued_message(state: &mut DesktopState, message_id: &str) {
    if let Some(arr) = state["queuedComposerMessages"].as_array_mut() {
        if let Some(m) = arr.iter_mut().find(|m| m["id"] == message_id) {
            m["mode"] = json!("steer");
        }
    }
}
