// ── Low-level Tauri listen ────────────────────────────────────

export async function tauriListen<T>(event: string, handler: (payload: T) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen(event, (e) => handler(e.payload as T));
}
