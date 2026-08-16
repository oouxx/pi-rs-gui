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

/** Resolve the active session's working directory (falls back to undefined). */
export async function getActiveSessionCwd(): Promise<string | undefined> {
  try {
    const state = await getState();
    const sess = (state.sessions ?? []).find(
      (s: any) => s.id === state.selectedSessionId,
    );
    return sess?.cwd ?? undefined;
  } catch {
    return undefined;
  }
}
export function submitComposer(text: string) {
  return tauriInvoke<DesktopAppState>("submit_composer", { text });
}
export function listCustomProviders() {
  return tauriInvoke<any[]>("list_custom_providers");
}

// ── Agent-session flow ──

export function cancelCurrentRun() {
  return tauriInvoke<DesktopAppState>("cancel_current_run");
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

export function listSkills(cwd?: string) {
  return tauriInvoke<any[]>("list_skills", cwd ? { cwd } : {});
}
export function getSkill(name: string, cwd?: string) {
  return tauriInvoke<any>("get_skill", cwd ? { name, cwd } : { name });
}

// ── Extensions ──

export function listExtensions() {
  return tauriInvoke<any[]>("list_extensions");
}
export function getExtension(name: string) {
  return tauriInvoke<any>("get_extension", { name });
}

// ── Workspace file completion (composer @ mention / Tab) ──

export interface FileCompletion {
  name: string;
  path: string;
  isDir: boolean;
}

export function fileCompletions(cwd: string | null | undefined, query: string) {
  return tauriInvoke<FileCompletion[]>("file_completions", {
    ...(cwd ? { cwd } : {}),
    query,
  });
}

// ── Slash commands ──

export function listSlashCommands() {
  return tauriInvoke<any[]>("list_slash_commands");
}

// ── Terminal ──

export function terminalStart(cwd?: string) {
  return tauriInvoke<string>("terminal_start", cwd ? { cwd } : {});
}
export function terminalWrite(sessionId: string, data: string) {
  return tauriInvoke<void>("terminal_write", { sessionId, data });
}
export function terminalStop() {
  return tauriInvoke<void>("terminal_stop");
}

// ── Session model ──

export function getSessionModel() {
  return tauriInvoke<{ provider?: string | null; modelId?: string | null }>(
    "get_session_model",
  );
}
export function setSessionModel(provider: string, modelId: string) {
  return tauriInvoke<DesktopAppState>("set_session_model", {
    provider,
    modelId,
  });
}

// ── Session info ──

export interface SessionInfo {
  id: string;
  found?: boolean;
  title?: string;
  cwd?: string | null;
  sessionFile?: string | null;
  messageCount?: number;
  createdAt?: string | null;
  model?: { provider?: string | null; modelId?: string | null } | null;
}

export function getSessionInfo(sessionId: string) {
  return tauriInvoke<SessionInfo>("get_session_info", { sessionId });
}

// ── Session tree (timeline) ──

export interface SessionTreeNode {
  id: string;
  parentId?: string | null;
  kind: string;
  label: string;
  timestamp: string;
  current?: boolean;
  children: SessionTreeNode[];
}

export function getSessionTree(sessionId: string) {
  return tauriInvoke<SessionTreeNode[]>("get_session_tree", { sessionId });
}
export function navigateSessionTree(sessionId: string, entryId: string) {
  return tauriInvoke<SessionTreeNode[]>("navigate_session_tree", {
    sessionId,
    entryId,
  });
}

// ── Session export ──

export function exportSession(
  sessionId: string,
  format: "html" | "jsonl",
  targetPath: string,
) {
  return tauriInvoke<string>("export_session", {
    sessionId,
    format,
    targetPath,
  });
}

// ── General settings ──

export function getGeneralSettings() {
  return tauriInvoke<any>("get_general_settings");
}
export function setGeneralSetting(key: string, value: unknown) {
  return tauriInvoke<any>("set_general_setting", { key, value });
}

// ── Resources dirs ──

export function getAgentDir() {
  return tauriInvoke<string>("get_agent_dir");
}

// ── Shell (open folders in the OS file manager) ──

export function openPath(path: string) {
  return import("@tauri-apps/plugin-shell").then((m) => m.open(path));
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
