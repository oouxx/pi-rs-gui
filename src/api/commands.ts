// ── Low-level Tauri invoke ────────────────────────────────────

export async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const ipc = (window as any).__TAURI_INTERNALS__;
  console.log(`[IPC →] ${cmd}`, args);
  const result = await (ipc.invoke(cmd, args) as Promise<T>);
  console.log(`[IPC ←] ${cmd}`, result);
  return result;
}

// ── Commands (no workspace params) ────────────────────────────

export type DesktopAppState = any;

export function getState() {
  return tauriInvoke<DesktopAppState>("get_state");
}
export function getSelectedTranscript() {
  return tauriInvoke<any>("get_selected_transcript");
}
export function submitComposer(text: string) {
  return tauriInvoke<DesktopAppState>("submit_composer", { text });
}
export function listCustomProviders() {
  return tauriInvoke<any[]>("list_custom_providers");
}

// ── Model ──

export function getDefaultModel() {
  return tauriInvoke<any>("get_default_model");
}
export function getModels() {
  return tauriInvoke<{ models: readonly any[] }>("get_models");
}
export function getProviders() {
  return tauriInvoke<{ providers: readonly any[] }>("get_providers");
}
export function getModelSettings() {
  return tauriInvoke<{ settings: any; globalModelSettings: any }>(
    "get_model_settings",
  );
}
export function setDefaultModel(provider: string, modelId: string) {
  return tauriInvoke<DesktopAppState>("set_default_model", {
    provider,
    modelId,
  });
}
export function setDefaultThinkingLevel(thinkingLevel: string) {
  return tauriInvoke<DesktopAppState>("set_default_thinking_level", {
    thinkingLevel,
  });
}
export function setProviderApiKey(providerId: string, apiKey: string) {
  return tauriInvoke<DesktopAppState>("set_provider_api_key", {
    providerId,
    apiKey,
  });
}
export function loginProvider(providerId: string) {
  return tauriInvoke<DesktopAppState>("login_provider", { providerId });
}
export function logoutProvider(providerId: string) {
  return tauriInvoke<DesktopAppState>("logout_provider", { providerId });
}
export function setCustomProvider(config: any) {
  return tauriInvoke<DesktopAppState>("set_custom_provider", { config });
}
export function deleteCustomProvider(providerId: string) {
  return tauriInvoke<DesktopAppState>("delete_custom_provider", { providerId });
}

// ── Skills ──

export function listSkills() {
  return tauriInvoke<any[]>("list_skills");
}
export function getSkill(name: string) {
  return tauriInvoke<any>("get_skill", { name });
}
export function deleteSkill(name: string) {
  return tauriInvoke<void>("delete_skill", { name });
}

// ── Extensions ──

export function listExtensions() {
  return tauriInvoke<any[]>("list_extensions");
}
export function getExtension(name: string) {
  return tauriInvoke<any>("get_extension", { name });
}
export function deleteExtension(name: string) {
  return tauriInvoke<void>("delete_extension", { name });
}

// ── Session CRUD ──

export function selectSession(sessionId: string) {
  return tauriInvoke<DesktopAppState>("select_session", { sessionId });
}
export function createSession(title?: string) {
  return tauriInvoke<DesktopAppState>("create_session", { title });
}
export function archiveSession(sessionId: string) {
  return tauriInvoke<DesktopAppState>("archive_session", { sessionId });
}
export function renameSession(sessionId: string, title: string) {
  return tauriInvoke<DesktopAppState>("rename_session", { sessionId, title });
}
export function deleteSession(sessionId: string) {
  return tauriInvoke<DesktopAppState>("delete_session", { sessionId });
}
export function setSessionCwd(sessionId: string, path: string) {
  return tauriInvoke<DesktopAppState>("set_session_cwd", { sessionId, path });
}
