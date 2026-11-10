/**
 * Tauri event channel names — keep in sync with
 * `src-tauri/src/state/events.rs`. A typo on either side drops events silently.
 */
export const EVENTS = {
  agentEvent: "agent-event",
  stateChanged: "pi-gui:state-changed",
  transcriptChanged: "pi-gui:selected-transcript-changed",
} as const;
