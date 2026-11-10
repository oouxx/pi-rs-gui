//! Tauri event channel names shared by every backend emitter.
//!
//! Keep the spelling in sync with `src/api/eventNames.ts` — a typo on either
//! side silently drops events.

/// Streaming agent events (one payload per `AgentSessionEvent`).
pub const AGENT_EVENT: &str = "agent-event";
/// Full `DesktopState` snapshot after every `Store::mutate`.
pub const STATE_CHANGED: &str = "pi-gui:state-changed";
/// Full display transcript after a turn / navigation / fork.
pub const TRANSCRIPT_CHANGED: &str = "pi-gui:selected-transcript-changed";
