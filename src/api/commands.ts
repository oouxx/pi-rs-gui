// ── Low-level Tauri invoke ────────────────────────────────────

export async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const ipc = (window as any).__TAURI_INTERNALS__;
  console.log(`[IPC →] ${cmd}`, args);
  const result = await (ipc.invoke(cmd, args) as Promise<T>);
  console.log(`[IPC ←] ${cmd}`, result);
  return result;
}

// ── Commands (no workspace params) ────────────────────────────

export type DesktopAppState = any;

export function getState() { return tauriInvoke<DesktopAppState>("get_state"); }
export function getSelectedTranscript() { return tauriInvoke<any>("get_selected_transcript"); }
export function submitComposer(text: string) { return tauriInvoke<DesktopAppState>("submit_composer", { text }); }
export function listCustomProviders() { return tauriInvoke<any[]>("list_custom_providers"); }
