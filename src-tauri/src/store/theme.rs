//! Theme operations — mirrors original `theme-manager.ts` (without Electron's nativeTheme).

use serde_json::json;
use crate::store::internal::DesktopState;

pub fn set_theme_mode(state: &mut DesktopState, mode: &str) {
    state["themeMode"] = json!(mode);
}

pub fn set_theme_preset(state: &mut DesktopState, preset_id: &str) {
    state["themePresetId"] = json!(preset_id);
}
