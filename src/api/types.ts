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
  /** Tool-specific payload from the ToolResult (e.g. edit diff/patch). */
  details?: unknown;
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
  /** Built-ins are opt-in; false means the agent won't load it. */
  enabled: boolean;
}

export interface WebSearchSettings {
  /** "auto" picks DeepSeek when a key is configured, otherwise Ollama. */
  provider: "auto" | "deepseek" | "ollama" | string;
  deepseekBaseUrl: string;
  /** The key itself never crosses IPC; only whether one is stored. */
  hasDeepSeekKey: boolean;
  ollamaHost: string;
}

export interface ExtensionSettings {
  webSearch: WebSearchSettings;
  applied?: boolean;
  warning?: string;
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
  /** Message role for `kind: "message"` nodes. */
  role?: string | null;
  /** Raw preview text (localized labels are built in the UI). */
  detail: string;
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
  promptPaths: string[];
  steeringMode: string;
  followUpMode: string;
  transport: string;
  cacheWarming: string;
  showCacheMissNotices: boolean;
  externalEditor: string | null;
  defaultProjectTrust: string;
  shellCommandPrefix: string | null;
  npmCommand: string[] | null;
  collapseChangelog: boolean;
  paths: {
    agentDir: string;
    settingsPath: string;
    sessionsDir: string;
  };
  version: string;
}

// ── MCP servers (src-tauri/src/state/mcp.rs) ─────────────────

export type McpScope = "global" | "project" | "extension";
export type McpExposure = "codemode" | "deferred" | "direct" | "hidden";
export type McpTransport = "stdio" | "http";
export type McpStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "needs-auth"
  | "failed"
  | "closed"
  | "disabled"
  | "not-loaded";

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
}

export interface McpServerInfo {
  name: string;
  scope: McpScope;
  source?: string;
  overridePath?: string | null;
  enabled: boolean;
  exposure: McpExposure;
  transport: McpTransport;
  description?: string | null;
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  timeout?: number | null;
  /** Raw pi-rs config entry; round-trip it so unmodeled fields survive edits. */
  config: Record<string, unknown>;
  status: McpStatus;
  error?: string | null;
  tools: McpTool[];
  hasResources: boolean;
  instructions?: string | null;
}

export interface McpConfigView {
  servers: McpServerInfo[];
  errors: string[];
  globalConfigPath: string;
  projectConfigPath: string;
  agentDir: string;
  cwd: string;
  /** False when a running turn blocked the actor restart. */
  applied?: boolean;
  warning?: string;
}

// ── Session model / thinking / context usage ─────────────────

export interface SessionModelState {
  provider?: string | null;
  modelId?: string | null;
  thinkingLevel?: string | null;
  supportedThinkingLevels?: string[];
}

export interface SessionUsage {
  totalTokens: number;
  contextWindow: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  messagesCount: number;
  percentage: number;
  remainingTokens: number;
  formatted: string;
}

/** A message queued while a turn is running. */
export interface QueuedMessage {
  text: string;
  mode: "steer" | "followUp";
}

// ── Scoped models (Ctrl/Cmd+P cycling) ───────────────────────

export interface ScopedModelsState {
  patterns: string[];
  /** False when a running turn blocked applying the new list. */
  applied?: boolean;
  warning?: string;
}

export interface CycledModel {
  provider: string;
  modelId: string;
  thinkingLevel?: string | null;
  scoped: boolean;
}

// ── Full-text session search ─────────────────────────────────

export interface SessionSearchResult {
  sessionId: string;
  title: string;
  role: string;
  snippet: string;
  timestamp?: number | null;
}

// ── MCP resources ────────────────────────────────────────────

export interface McpResource {
  uri: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}

export interface McpResourceTemplate {
  uriTemplate: string;
  name?: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpResourcesResult {
  resources: McpResource[];
  templates: McpResourceTemplate[];
}

// ── Prompt templates ─────────────────────────────────────────

export interface PromptTemplateInfo {
  name: string;
  description: string;
  argumentHint?: string | null;
  filePath: string;
  source: "user" | "project" | "path" | string;
  append: boolean;
}
