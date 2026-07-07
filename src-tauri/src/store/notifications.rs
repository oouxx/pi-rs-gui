//! Notification preferences — mirrors original `notification-manager.ts` + `notification-permission.ts`.

use serde_json::json;
use crate::store::internal::DesktopState;

pub fn set_notification_preferences(state: &mut DesktopState, prefs: serde_json::Value) {
    state["notificationPreferences"] = prefs;
}

pub fn set_integrated_terminal_shell(state: &mut DesktopState, shell: &str) {
    state["integratedTerminalShell"] = json!(shell);
}

pub fn set_enable_transparency(state: &mut DesktopState, enabled: bool) {
    state["enableTransparency"] = json!(enabled);
}
