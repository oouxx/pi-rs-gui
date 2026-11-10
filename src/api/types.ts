/**
 * IPC contract types mirrored from the Rust backend.
 *
 * Serde serializes with `rename_all = "camelCase"` for our own structs; pi-rs
 * types keep their own spellings (e.g. `error_message`, `tool_call_id`).
 * Keep this file in sync whenever a command payload changes.
 */

// ── State (src-tauri/src/state/types.rs) ─────────────────────

export interface SessionRecordDto {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
  status: string;
  sessionFile?: string | null;
  archivedAt?: string | null;
  config?: unknown;
  thinkingLevel?: string | null;
  cwd?: string | null;
}

export interface GlobalModelSettingsDto {
  enabledModelPatterns?: string[];
  defaultProvider?: string | null;
  defaultModelId?: string | null;
  defaultThinkingLevel?: string | null;
}

export interface DesktopStateDto {
  revision: number;
  sessions: SessionRecordDto[];
  selectedSessionId: string;
  globalModelSettings: GlobalModelSettingsDto;
}

// ── Content blocks (pi-ai ContentBlock + merge fields) ───────

export interface TextBlockDto {
  type: "text";
  text?: string;
  textSignature?: string | null;
  /** Injected by `build_display_transcript` for toolCall blocks. */
  status?: "running" | "success" | "error";
  result?: string;
  isError?: boolean;
}

export interface ThinkingBlockDto {
  type: "thinking";
  thinking?: string;
  thinkingSignature?: string | null;
  redacted?: boolean | null;
}

export interface ToolCallBlockDto {
  type: "toolCall";
  id?: string;
  name?: string;
  arguments?: unknown;
  thoughtSignature?: string | null;
  namespace?: string | null;
  status?: "running" | "success" | "error";
  result?: string;
  isError?: boolean;
}

export interface ImageBlockDto {
  type: "image";
  data?: string;
  mimeType?: string;
}

export type RawContentBlock =
  | TextBlockDto
  | ThinkingBlockDto
  | ToolCallBlockDto
  | ImageBlockDto;

// ── Agent messages / events ──────────────────────────────────

export interface AgentMessageDto {
  role?: "user" | "assistant" | "system" | "toolResult" | string;
  content?: RawContentBlock[];
  timestamp?: number;
  error_message?: string;
  stop_reason?: string | null;
}

export interface AgentEventPayload {
  event_type: string;
  session_id: string;
  data: {
    message?: AgentMessageDto;
    contentIndex?: number;
    delta?: string;
    partial?: { content?: RawContentBlock[] };
    toolCall?: ToolCallBlockDto;
    tool_call_id?: string;
    tool_name?: string;
    result?: unknown;
    partial_result?: unknown;
    is_error?: boolean;
    will_retry?: boolean;
    /** ToolCallDelta payload (non-streamed form). */
    [key: string]: unknown;
  };
}

// ── Transcript (src-tauri/src/state/transcript.rs) ───────────

export interface TranscriptItem {
  id?: string;
  kind?: string;
  role?: string;
  text?: string;
  content?: RawContentBlock[];
  createdAt?: string;
  errorMessage?: string;
}

export interface TranscriptPayload {
  sessionId?: string;
  transcript: TranscriptItem[];
}

// ── Models / providers ───────────────────────────────────────

export interface ModelOption {
  providerId: string;
  modelId: string;
  label: string;
  available: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  hasAuth: boolean;
}

export interface ModelSettingsDto {
  settings: GlobalModelSettingsDto;
}

export interface DefaultModelDto {
  defaultProvider: string;
  defaultModelId: string;
  defaultThinkingLevel: string;
}

export interface CustomProviderInfo {
  id: string;
  provider: string;
  api: string;
  baseUrl: string;
  name: string;
}

// ── Skills / extensions / commands ───────────────────────────

export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope: string;
  disableModelInvocation: boolean;
}

export interface ExtensionCommandInfo {
  name: string;
  description: string;
}

export interface ExtensionInfo {
  name: string;
  location: "builtin";
  tools: string[];
  commands: ExtensionCommandInfo[];
}

export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string | null;
  source?: "builtin" | "extension" | "prompt" | "skill" | string;
}

// ── Session metadata ─────────────────────────────────────────

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

export interface SessionTreeNode {
  id: string;
  parentId?: string | null;
  kind: string;
  label: string;
  timestamp: string;
  current?: boolean;
  children: SessionTreeNode[];
}

export interface TrustDecision {
  cwd: string;
  decision: boolean | null;
}

// ── General settings (src-tauri/src/state/settings.rs) ───────

export interface GeneralSettings {
  defaultThinkingLevel: string;
  compactionEnabled: boolean;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  retryEnabled: boolean;
  hideThinkingBlock: boolean;
  shellPath: string | null;
  quietStartup: boolean;
  theme: string | null;
  enableSkillCommands: boolean;
  skillPaths: string[];
  paths: {
    agentDir: string;
    settingsPath: string;
    sessionsDir: string;
  };
  version: string;
}
