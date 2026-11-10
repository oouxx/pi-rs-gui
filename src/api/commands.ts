import type {
  CustomProviderInfo,
  DefaultModelDto,
  DesktopStateDto,
  ExtensionInfo,
  GeneralSettings,
  GlobalModelSettingsDto,
  ModelOption,
  ModelSettingsDto,
  ProviderInfo,
  SessionInfo,
  SessionRecordDto,
  SessionTreeNode,
  SkillInfo,
  SlashCommandInfo,
  TranscriptPayload,
  TrustDecision,
} from "./types";

// ── Low-level Tauri invoke ────────────────────────────────────

/** Argument/result keys whose values must never reach the console. */
const SENSITIVE_KEY = /(api[_-]?key|token|secret|password|credential)/i;

/** Deep-copy a value for logging, masking credential-looking fields. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? "***" : redact(v, depth + 1);
  }
  return out;
}

interface TauriInternals {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown>;
}

export async function tauriInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const ipc = (window as unknown as { __TAURI_INTERNALS__: TauriInternals })
    .__TAURI_INTERNALS__;
  if (import.meta.env.DEV) {
    console.log(`[IPC →] ${cmd}`, redact(args));
  }
  const result = (await ipc.invoke(cmd, args)) as T;
  if (import.meta.env.DEV) {
    console.log(`[IPC ←] ${cmd}`, redact(result));
  }
  return result;
}

// ── Types ─────────────────────────────────────────────────────
// Shared IPC types live in `./types`; re-export the ones consumers import
// from this module.

export type {
  CustomProviderInfo,
  DefaultModelDto,
  DesktopStateDto,
  ExtensionInfo,
  GeneralSettings,
  GlobalModelSettingsDto,
  ModelOption,
  ModelSettingsDto,
  ProviderInfo,
  SessionInfo,
  SessionRecordDto,
  SessionTreeNode,
  SkillInfo,
  SlashCommandInfo,
  TranscriptItem,
  TranscriptPayload,
  TrustDecision,
} from "./types";

export type DesktopAppState = DesktopStateDto;

// ── Commands (no workspace params) ────────────────────────────

export function getState() {
  return tauriInvoke<DesktopAppState>("get_state");
}
export function getSelectedTranscript() {
  return tauriInvoke<TranscriptPayload | null>("get_selected_transcript");
}

/** Resolve the active session's working directory (falls back to undefined). */
export async function getActiveSessionCwd(): Promise<string | undefined> {
  try {
    const state = await getState();
    const sess = (state.sessions ?? []).find(
      (s) => s.id === state.selectedSessionId,
    );
    return sess?.cwd ?? undefined;
  } catch {
    return undefined;
  }
}
export interface ComposerImage {
  /** Raw base64 (no `data:` prefix). */
  data: string;
  mimeType: string;
}

export function submitComposer(text: string, images?: ComposerImage[]) {
  return tauriInvoke<DesktopAppState>("submit_composer", {
    text,
    options: images && images.length > 0 ? { images } : undefined,
  });
}

export function cloneSession() {
  return tauriInvoke<DesktopAppState>("clone_session");
}

export function shareSession() {
  return tauriInvoke<string>("share_session");
}
export function listCustomProviders() {
  return tauriInvoke<CustomProviderInfo[]>("list_custom_providers");
}

// ── Agent-session flow ──

export function cancelCurrentRun() {
  return tauriInvoke<DesktopAppState>("cancel_current_run");
}

/** Abort a specific session's run (sidebar Stop for a background session). */
export function abortSession(sessionId: string) {
  return tauriInvoke<DesktopAppState>("abort_session", { sessionId });
}

// ── Model ──

export function getDefaultModel() {
  return tauriInvoke<DefaultModelDto>("get_default_model");
}
export function getModels() {
  return tauriInvoke<{ models: ModelOption[] }>("get_models");
}
export function getProviders() {
  return tauriInvoke<{ providers: ProviderInfo[] }>("get_providers");
}
export function getModelSettings() {
  return tauriInvoke<ModelSettingsDto>("get_model_settings");
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
export function logoutProvider(providerId: string) {
  return tauriInvoke<DesktopAppState>("logout_provider", { providerId });
}
export function setCustomProvider(config: CustomProviderInfo) {
  return tauriInvoke<DesktopAppState>("set_custom_provider", { config });
}
export function deleteCustomProvider(providerId: string) {
  return tauriInvoke<DesktopAppState>("delete_custom_provider", { providerId });
}

// ── Skills ──

export function listSkills(cwd?: string) {
  return tauriInvoke<SkillInfo[]>("list_skills", cwd ? { cwd } : {});
}
export function getSkill(name: string, cwd?: string) {
  return tauriInvoke<SkillInfo>("get_skill", cwd ? { name, cwd } : { name });
}

// ── Extensions ──

export function listExtensions() {
  return tauriInvoke<ExtensionInfo[]>("list_extensions");
}
export function getExtension(name: string) {
  return tauriInvoke<ExtensionInfo>("get_extension", { name });
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
  return tauriInvoke<SlashCommandInfo[]>("list_slash_commands");
}

// ── Terminal ──

export function terminalStart(cwd?: string) {
  return tauriInvoke<string>("terminal_start", cwd ? { cwd } : {});
}
export function terminalWrite(sessionId: string, data: string) {
  return tauriInvoke<void>("terminal_write", { sessionId, data });
}
export function terminalResize(sessionId: string, cols: number, rows: number) {
  return tauriInvoke<void>("terminal_resize", { sessionId, cols, rows });
}
export function terminalStop(sessionId: string) {
  return tauriInvoke<void>("terminal_stop", { sessionId });
}
export function terminalStopAll() {
  return tauriInvoke<void>("terminal_stop_all");
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

export function getSessionInfo(sessionId: string) {
  return tauriInvoke<SessionInfo>("get_session_info", { sessionId });
}

// ── Session tree (timeline) ──

export function getSessionTree(sessionId: string) {
  return tauriInvoke<SessionTreeNode[]>("get_session_tree", { sessionId });
}
export function navigateSessionTree(sessionId: string, entryId: string) {
  return tauriInvoke<SessionTreeNode[]>("navigate_session_tree", {
    sessionId,
    entryId,
  });
}

// ── Session maintenance ──

export function compactSession(customInstructions?: string) {
  return tauriInvoke<DesktopAppState>("compact_session", {
    ...(customInstructions ? { customInstructions } : {}),
  });
}

// ── Project trust ──

export function getProjectTrust(cwd?: string | null) {
  return tauriInvoke<TrustDecision>("get_project_trust", cwd ? { cwd } : {});
}
export function setProjectTrust(cwd: string, decision: boolean | null) {
  return tauriInvoke<TrustDecision>("set_project_trust", { cwd, decision });
}

// ── Fork / import / reload ──

export function forkSessionAt(entryId: string) {
  return tauriInvoke<DesktopAppState>("fork_session_at", { entryId });
}
export function importSession(inputPath: string) {
  return tauriInvoke<DesktopAppState>("import_session", { inputPath });
}
export function reloadSession() {
  return tauriInvoke<void>("reload_session");
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
  return tauriInvoke<GeneralSettings>("get_general_settings");
}
export function setGeneralSetting(key: string, value: unknown) {
  return tauriInvoke<GeneralSettings>("set_general_setting", { key, value });
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
export function createSession(title?: string, cwd?: string) {
  return tauriInvoke<DesktopAppState>("create_session", { title, cwd });
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
