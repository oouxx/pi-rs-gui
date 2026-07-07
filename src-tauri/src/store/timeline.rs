//! Session tree + transcript — mirrors parts of `app-store-timeline.ts`.
//! Full session tree navigation and transcript caching requires the
//! session-driver's fork/entry APIs. Currently basic stubs.

use serde_json::json;
use crate::store::internal::DesktopState;

pub fn stub_session_tree(session_id: &str) -> serde_json::Value {
    json!({
        "id": session_id,
        "label": "root",
        "roots": [],
        "leafId": session_id,
    })
}

pub fn stub_navigate_result(state: &DesktopState) -> serde_json::Value {
    json!({"state": state.clone(), "result": {"cancelled": false}})
}
