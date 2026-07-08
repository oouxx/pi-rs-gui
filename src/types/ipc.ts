import type {
  AppView,
  ComposerAttachment,
  ComposerImageAttachment,
  CreateSessionInput,
  CreateWorktreeInput,
  DesktopAppState,
  ForkThreadInput,
  ModelSettingsScopeMode,
  NotificationPreferences,
  RemoveWorktreeInput,
  SendChildThreadFollowUpInput,
  SetChildSupervisionLoopInput,
  SelectedTranscriptRecord,
  StartThreadInput,
  ThemePresetId,
  WorkspaceSessionTarget,
} from "./state";

export type DesktopPlatform = "darwin" | "win32" | "linux";
export type DesktopNotificationPermissionStatus = "granted" | "denied" | "default" | "unsupported" | "unknown";

export interface CustomProviderModelConfig {
  readonly id: string;
  readonly contextWindow?: number;
}

export interface CustomProviderConfig {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly CustomProviderModelConfig[];
}

export interface CustomProviderProbeInput {
  readonly baseUrl: string;
  readonly apiKey?: string;
}

export type CustomProviderProbeResult =
  | { readonly ok: true; readonly models: readonly string[] }
  | { readonly ok: false; readonly error: string };

export type PiDesktopStateListener = (state: DesktopAppState) => void;
export type PiDesktopSelectedTranscriptListener = (payload: SelectedTranscriptRecord | null) => void;

export interface ChangedFileEntry {
  readonly path: string;
  readonly status: "added" | "modified" | "deleted" | "untracked";
  readonly staged: boolean;
}

export interface WorkspaceFilePreview {
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly binary: boolean;
  readonly sizeBytes: number;
}

export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

export type TerminalSessionStatus = "running" | "exited" | "error";

export interface TerminalSessionSnapshot {
  readonly id: string;
  readonly workspaceId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly title: string;
  readonly status: TerminalSessionStatus;
  readonly replay: string;
  readonly truncated: boolean;
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface TerminalPanelSnapshot {
  readonly workspaceId: string;
  readonly rootKey: string;
  readonly activeSessionId: string;
  readonly sessions: readonly TerminalSessionSnapshot[];
}

export interface TerminalDataEvent {
  readonly terminalId: string;
  readonly data: string;
}

export interface TerminalExitEvent {
  readonly terminalId: string;
  readonly exitCode?: number;
  readonly signal?: number;
}

export interface TerminalErrorEvent {
  readonly terminalId: string;
  readonly message: string;
}

export interface DesktopShortcutInput {
  readonly modifier: boolean;
  readonly shift: boolean;
  readonly key: string;
  readonly code?: string;
}

export type PiDesktopCommand =
  | "open-settings"
  | "open-new-thread"
  | "toggle-terminal"
  | "toggle-sidebar";

export interface PiDesktopApi {
  platform: DesktopPlatform;
  versions: Record<string, string>;
  ping(): Promise<string>;
  getState(): Promise<DesktopAppState>;
  onStateChanged(listener: PiDesktopStateListener): () => void;
  getSelectedTranscript(): Promise<SelectedTranscriptRecord | null>;
  onSelectedTranscriptChanged(listener: PiDesktopSelectedTranscriptListener): () => void;
  onCommand(listener: (command: PiDesktopCommand) => void): () => void;
  onWorkspacePicked(listener: (workspaceId: string) => void): () => void;
  onClipboardImagePasted(listener: (attachment: ComposerImageAttachment) => void): () => void;
  getPathForFile(file: File): string;
  addWorkspacePath(path: string): Promise<DesktopAppState>;
  pickWorkspace(): Promise<DesktopAppState>;
  selectWorkspace(workspaceId: string): Promise<DesktopAppState>;
  renameWorkspace(workspaceId: string, displayName: string): Promise<DesktopAppState>;
  removeWorkspace(workspaceId: string): Promise<DesktopAppState>;
  reorderWorkspaces(workspaceOrder: readonly string[]): Promise<DesktopAppState>;
  reorderPinnedSessions(pinnedSessionOrder: readonly string[]): Promise<DesktopAppState>;
  openWorkspaceInFinder(workspaceId: string): Promise<void>;
  createWorktree(input: CreateWorktreeInput): Promise<DesktopAppState>;
  removeWorktree(input: RemoveWorktreeInput): Promise<DesktopAppState>;
  openSkillInFinder(workspaceId: string, filePath: string): Promise<void>;
  openExtensionInFinder(workspaceId: string, filePath: string): Promise<void>;
  syncCurrentWorkspace(): Promise<DesktopAppState>;
  selectSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  archiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  unarchiveSession(target: WorkspaceSessionTarget): Promise<DesktopAppState>;
  setSessionPinned(target: WorkspaceSessionTarget, pinned: boolean): Promise<DesktopAppState>;
  createSession(input: CreateSessionInput): Promise<DesktopAppState>;
  renameSession(target: WorkspaceSessionTarget, title: string): Promise<DesktopAppState>;
  startThread(input: StartThreadInput): Promise<DesktopAppState>;
  forkThread(input: ForkThreadInput): Promise<DesktopAppState>;
  sendChildThreadFollowUp(input: SendChildThreadFollowUpInput): Promise<DesktopAppState>;
  setChildSupervisionLoop(input: SetChildSupervisionLoopInput): Promise<DesktopAppState>;
  cancelCurrentRun(): Promise<DesktopAppState>;
  setActiveView(view: AppView): Promise<DesktopAppState>;
  setSidebarCollapsed(collapsed: boolean): Promise<DesktopAppState>;
  refreshRuntime(workspaceId?: string): Promise<DesktopAppState>;
  setModelSettingsScopeMode(mode: ModelSettingsScopeMode): Promise<DesktopAppState>;
  setDefaultModel(workspaceId: string, provider: string, modelId: string): Promise<DesktopAppState>;
  setDefaultThinkingLevel(
    workspaceId: string,
    thinkingLevel: import("../sdk-types").RuntimeSettingsSnapshot["defaultThinkingLevel"],
  ): Promise<DesktopAppState>;
  setSessionModel(
    workspaceId: string,
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<DesktopAppState>;
  setSessionThinkingLevel(
    workspaceId: string,
    sessionId: string,
    thinkingLevel: NonNullable<import("../sdk-types").RuntimeSettingsSnapshot["defaultThinkingLevel"]>,
  ): Promise<DesktopAppState>;
  loginProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  logoutProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  setProviderApiKey(workspaceId: string, providerId: string, apiKey: string): Promise<DesktopAppState>;
  getDefaultModel(workspaceId: string): Promise<{ defaultProvider: string; defaultModelId: string; defaultThinkingLevel: string }>;
  getModels(workspaceId: string): Promise<{ models: readonly any[] }>;
  getProviders(workspaceId: string): Promise<{ providers: readonly any[] }>;
  getModelSettings(workspaceId: string): Promise<{ settings: any; globalModelSettings: any }>;
  listCustomProviders(): Promise<readonly CustomProviderConfig[]>;
  getCustomProvider(providerId: string): Promise<CustomProviderConfig>;
  setCustomProvider(workspaceId: string, config: CustomProviderConfig): Promise<DesktopAppState>;
  deleteCustomProvider(workspaceId: string, providerId: string): Promise<DesktopAppState>;
  probeCustomProviderModels(baseUrl: string, apiKey?: string): Promise<CustomProviderProbeResult>;
  hasProviderAuth(providerId: string): Promise<boolean>;
  listSkills(workspaceId: string): Promise<readonly any[]>;
  getSkill(workspaceId: string, name: string): Promise<any>;
  deleteSkill(workspaceId: string, name: string): Promise<void>;
  listExtensions(workspaceId: string): Promise<readonly any[]>;
  getExtension(workspaceId: string, name: string): Promise<any>;
  deleteExtension(workspaceId: string, name: string): Promise<void>;
  setEnableSkillCommands(workspaceId: string, enabled: boolean): Promise<DesktopAppState>;
  setScopedModelPatterns(workspaceId: string, patterns: readonly string[]): Promise<DesktopAppState>;
  setSkillEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState>;
  setExtensionEnabled(workspaceId: string, filePath: string, enabled: boolean): Promise<DesktopAppState>;
  respondToHostUiRequest(
    workspaceId: string,
    sessionId: string,
    response:
      | { readonly requestId: string; readonly value: string }
      | { readonly requestId: string; readonly confirmed: boolean }
      | { readonly requestId: string; readonly cancelled: true },
  ): Promise<DesktopAppState>;
  setNotificationPreferences(preferences: Partial<NotificationPreferences>): Promise<DesktopAppState>;
  setIntegratedTerminalShell(shell: string): Promise<DesktopAppState>;
  setEnableTransparency(enabled: boolean): Promise<DesktopAppState>;
  setThemePresetId(presetId: ThemePresetId): Promise<DesktopAppState>;
  ensureTerminalPanel(
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot>;
  createTerminalSession(
    workspaceId: string,
    terminalScopeId: string,
    size?: Partial<TerminalSize>,
  ): Promise<TerminalPanelSnapshot>;
  setActiveTerminalSession(
    workspaceId: string,
    terminalScopeId: string,
    terminalId: string,
  ): Promise<TerminalPanelSnapshot>;
  writeTerminal(terminalId: string, data: string): Promise<void>;
  resizeTerminal(terminalId: string, size: TerminalSize): Promise<void>;
  restartTerminalSession(terminalId: string, size?: Partial<TerminalSize>): Promise<TerminalPanelSnapshot>;
  closeTerminalSession(terminalId: string): Promise<TerminalPanelSnapshot | null>;
  setTerminalTitle(terminalId: string, title: string): Promise<void>;
  setTerminalFocused(focused: boolean): Promise<void>;
  onTerminalData(listener: (event: TerminalDataEvent) => void): () => void;
  onTerminalExit(listener: (event: TerminalExitEvent) => void): () => void;
  onTerminalError(listener: (event: TerminalErrorEvent) => void): () => void;
  getNotificationPermissionStatus(): Promise<DesktopNotificationPermissionStatus>;
  requestNotificationPermission(): Promise<DesktopNotificationPermissionStatus>;
  openSystemNotificationSettings(): Promise<void>;
  onNotificationPermissionStatusChanged(
    callback: (status: DesktopNotificationPermissionStatus) => void,
  ): () => void;
  pickComposerAttachments(): Promise<DesktopAppState>;
  readClipboardImage(): ComposerImageAttachment | null;
  addComposerAttachments(attachments: readonly ComposerAttachment[]): Promise<DesktopAppState>;
  removeComposerAttachment(attachmentId: string): Promise<DesktopAppState>;
  editQueuedComposerMessage(messageId: string, currentDraft?: string): Promise<DesktopAppState>;
  cancelQueuedComposerEdit(): Promise<DesktopAppState>;
  removeQueuedComposerMessage(messageId: string): Promise<DesktopAppState>;
  steerQueuedComposerMessage(messageId: string): Promise<DesktopAppState>;
  updateComposerDraft(composerDraft: string): Promise<DesktopAppState>;
  submitComposer(text: string, options?: { readonly deliverAs?: "steer" | "followUp" }): Promise<DesktopAppState>;
  getSessionTree(target: WorkspaceSessionTarget): Promise<import("../sdk-types").SessionTreeSnapshot>;
  navigateSessionTree(
    target: WorkspaceSessionTarget,
    targetId: string,
    options?: import("../sdk-types").NavigateSessionTreeOptions,
  ): Promise<{ readonly state: DesktopAppState; readonly result: import("../sdk-types").NavigateSessionTreeResult }>;
  listWorkspaceFiles(workspaceId: string, options?: { readonly force?: boolean }): Promise<string[]>;
  readWorkspaceFile(workspaceId: string, filePath: string): Promise<WorkspaceFilePreview>;
  getChangedFiles(workspaceId: string): Promise<ChangedFileEntry[]>;
  getFileDiff(workspaceId: string, filePath: string): Promise<string>;
  stageFile(workspaceId: string, filePath: string): Promise<void>;
  toggleWindowMaximize(): Promise<void>;
  openExternal(url: string): Promise<void>;
  getThemeMode(): Promise<"system" | "light" | "dark">;
  getResolvedTheme(): Promise<"light" | "dark">;
  setThemeMode(mode: "system" | "light" | "dark"): Promise<DesktopAppState>;
  onThemeChanged(callback: (theme: "light" | "dark") => void): () => void;
}
