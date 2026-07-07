/**
 * Tauri adapter — thin proxy: each PiDesktopApi method directly forwards to a Tauri invoke.
 *
 * Architecture matches the original Electron preload.ts:
 *   Electron: piApp.xxx → ipcRenderer.invoke(channel) → main process handler
 *   Tauri:    piApp.xxx → invoke("xxx")               → Rust command handler
 *
 * When Tauri IPC is unavailable (browser dev), a lightweight BrowserApi fallback
 * provides mock state for UI testing.
 */

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const ipc = (window as any).__TAURI_INTERNALS__;
  console.log(`[IPC →] ${cmd}`, args);
  const result = await (ipc.invoke(cmd, args) as Promise<T>);
  console.log(`[IPC ←] ${cmd}`, result);
  return result;
}

async function tauriListen<T>(event: string, handler: (event: { payload: T }) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen(event, handler);
}

import type { DesktopAppState, SelectedTranscriptRecord } from "./desktop-state";
import { createEmptyDesktopAppState } from "./desktop-state";
import type { PiDesktopApi, DesktopPlatform } from "./ipc";

// ── Browser mode helpers ────────────────────────────────────

let _rev = 0;
function nextRev() { return ++_rev; }
function nowISO() { return new Date().toISOString(); }

function createBrowserApi(): PiDesktopApi {
  const listeners = new Set<(state: DesktopAppState) => void>();
  function emit(s: DesktopAppState) { listeners.forEach((fn) => fn(s)); }

  // ponytail: browser-mode transcript — in-memory array, no persistence
  const transcriptListeners = new Set<(t: SelectedTranscriptRecord | null) => void>();
  let browserMessages: Array<{id: string; kind: "message"; role: "user" | "assistant"; text: string; createdAt: string}> = [];
  function getBrowserTranscript(): SelectedTranscriptRecord | null {
    if (browserMessages.length === 0) return null;
    return { workspaceId: state.selectedWorkspaceId, sessionId: state.selectedSessionId, transcript: browserMessages };
  }

  let state: DesktopAppState = (() => {
    const base = createEmptyDesktopAppState();
    return {
      ...base,
      revision: nextRev(),
      workspaces: [{
        id: "ws-default", name: "default", path: "/tmp",
        lastOpenedAt: nowISO(), kind: "primary" as const,
        sessions: [{
          id: "sess-init", title: "New thread", updatedAt: nowISO(),
          preview: "", status: "idle" as const, hasUnseenUpdate: false,
        }],
      }],
      selectedWorkspaceId: "ws-default",
      selectedSessionId: "sess-init",
      activeView: "threads",
      runtimeByWorkspace: {
        "ws-default": {
          models: [
            { providerId: "openrouter", modelId: "free", providerName: "OpenRouter", label: "Free", available: true },
            { providerId: "anthropic", modelId: "claude-sonnet-4-6", providerName: "Anthropic", label: "Claude Sonnet 4.6", available: true },
          ],
          providers: [
            { id: "openrouter", name: "OpenRouter", hasAuth: true },
            { id: "anthropic", name: "Anthropic", hasAuth: false },
          ],
          skills: [],
          commands: [],
          settings: { enabledModelPatterns: [], defaultProvider: "openrouter", defaultModelId: "free" },
        },
      },
    } as any;
  })();

  function update(partial: Partial<DesktopAppState>) {
    state = { ...state, revision: nextRev(), ...partial };
    emit(state);
    return state;
  }

  type SetState<T> = (arg: T) => Promise<DesktopAppState>;

  return {
    platform: "darwin" as DesktopPlatform,
    versions: {},
    ping: async () => "pong",
    getState: async () => state,
    onStateChanged: (l) => { listeners.add(l); return () => listeners.delete(l); },
    getSelectedTranscript: async () => getBrowserTranscript(),
    onSelectedTranscriptChanged: (l) => { transcriptListeners.add(l); return () => transcriptListeners.delete(l); },
    onCommand: () => () => {},
    onWorkspacePicked: () => () => {},
    onClipboardImagePasted: () => () => {},
    getPathForFile: () => "",

    // Workspace
    addWorkspacePath: async (p) => update({ workspaces: [...state.workspaces, { id: "ws-"+Date.now(), name: p.split("/").pop()||p, path: p, lastOpenedAt: nowISO(), kind: "primary", sessions: [] } as any] }),
    pickWorkspace: async () => state,
    selectWorkspace: async (id) => update({ selectedWorkspaceId: id }),
    renameWorkspace: async (id, n) => update({ workspaces: state.workspaces.map((w) => w.id === id ? { ...w, name: n } : w) }),
    removeWorkspace: async (id) => update({ workspaces: state.workspaces.filter((w) => w.id !== id) }),
    reorderWorkspaces: async (o) => update({ workspaces: o.map((id) => state.workspaces.find((w) => w.id === id)).filter(Boolean) as any }),
    reorderPinnedSessions: async () => state,
    openWorkspaceInFinder: async () => {},
    createWorktree: async (input) => state,
    removeWorktree: async (input) => state,
    openSkillInFinder: async () => {},
    openExtensionInFinder: async () => {},
    syncCurrentWorkspace: async () => state,

    // Session
    selectSession: async (t) => update({ selectedWorkspaceId: t.workspaceId, selectedSessionId: t.sessionId }),
    archiveSession: async (t) => update({ workspaces: state.workspaces.map((w) => w.id === t.workspaceId ? { ...w, sessions: w.sessions.map((s) => s.id === t.sessionId ? { ...s, archivedAt: nowISO() } : s) } : w) }),
    unarchiveSession: async (t) => update({ workspaces: state.workspaces.map((w) => w.id === t.workspaceId ? { ...w, sessions: w.sessions.map((s) => s.id === t.sessionId ? { ...s, archivedAt: undefined } : s) } : w) }),
    setSessionPinned: async (t, p) => update({ workspaces: state.workspaces.map((w) => w.id === t.workspaceId ? { ...w, sessions: w.sessions.map((s) => s.id === t.sessionId ? { ...s, pinnedAt: p ? nowISO() : undefined } : s) } : w) }),
    createSession: async (input) => { const sid = "sess-"+Date.now(); return update({ workspaces: state.workspaces.map((w) => w.id === input.workspaceId ? { ...w, sessions: [...w.sessions, { id: sid, title: input.title||"New thread", updatedAt: nowISO(), preview: "", status: "idle", hasUnseenUpdate: false } as any] } : w), selectedSessionId: sid }); },
    startThread: async () => state,
    forkThread: async () => state,
    sendChildThreadFollowUp: async () => state,
    setChildSupervisionLoop: async () => state,
    cancelCurrentRun: async () => update({ workspaces: state.workspaces.map((w) => w.id === state.selectedWorkspaceId ? { ...w, sessions: w.sessions.map((s) => s.id === state.selectedSessionId ? { ...s, status: "idle" as const } : s) } : w) }),

    // View
    setActiveView: async (v) => update({ activeView: v as any }),
    setSidebarCollapsed: async (c) => update({ sidebarCollapsed: c }),
    refreshRuntime: async () => state,

    // Model
    setModelSettingsScopeMode: async (m) => update({ modelSettingsScopeMode: m as any }),
    setDefaultModel: async (wid, p, mid) => { const r = (state as any).runtimeByWorkspace[wid]; if (r) { r.settings.defaultProvider = p; r.settings.defaultModelId = mid; } return update({}); },
    setDefaultThinkingLevel: async () => state,
    setSessionModel: async (wid, sid, p, mid) => update({ workspaces: state.workspaces.map((w) => w.id === wid ? { ...w, sessions: w.sessions.map((s) => s.id === sid ? { ...s, config: { provider: p, modelId: mid } } : s) } : w) }),
    setSessionThinkingLevel: async () => state,
    loginProvider: async () => state,
    logoutProvider: async () => state,
    setProviderApiKey: async () => state,
    listCustomProviders: async () => [],
    setCustomProvider: async () => state,
    deleteCustomProvider: async () => state,
    probeCustomProviderModels: async () => ({ ok: false as const, error: "not available" }),
    setEnableSkillCommands: async () => state,
    setScopedModelPatterns: async () => state,
    setSkillEnabled: async () => state,
    setExtensionEnabled: async () => state,
    respondToHostUiRequest: async () => state,

    // Notifications
    setNotificationPreferences: async (p) => update({ notificationPreferences: { ...state.notificationPreferences, ...p } as any }),
    setIntegratedTerminalShell: async (s) => update({ integratedTerminalShell: s }),
    setEnableTransparency: async (e) => update({ enableTransparency: e }),
    setThemePresetId: async (p) => update({ themePresetId: p as any }),

    // Terminal
    ensureTerminalPanel: async () => ({ workspaceId: "", rootKey: "default", activeSessionId: "", sessions: [] }),
    createTerminalSession: async () => ({ workspaceId: "", rootKey: "default", activeSessionId: "", sessions: [] }),
    setActiveTerminalSession: async () => ({ workspaceId: "", rootKey: "default", activeSessionId: "", sessions: [] }),
    writeTerminal: async () => {},
    resizeTerminal: async () => {},
    restartTerminalSession: async () => ({ workspaceId: "", rootKey: "default", activeSessionId: "", sessions: [] }),
    closeTerminalSession: async () => null,
    setTerminalTitle: async () => {},
    setTerminalFocused: async () => {},
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},

    // Notifications permission
    getNotificationPermissionStatus: async () => "default" as any,
    requestNotificationPermission: async () => "default" as any,
    openSystemNotificationSettings: async () => {},
    onNotificationPermissionStatusChanged: () => () => {},

    // Composer
    pickComposerAttachments: async () => state,
    readClipboardImage: () => null,
    addComposerAttachments: async (a) => update({ composerAttachments: a as any }),
    removeComposerAttachment: async (id) => update({ composerAttachments: state.composerAttachments.filter((a: any) => a.id !== id) }),
    editQueuedComposerMessage: async (mid, d) => update({ editingQueuedMessageId: mid, composerDraft: d ?? state.composerDraft }),
    cancelQueuedComposerEdit: async () => update({ editingQueuedMessageId: undefined }),
    removeQueuedComposerMessage: async (id) => update({ queuedComposerMessages: state.queuedComposerMessages.filter((m: any) => m.id !== id) }),
    steerQueuedComposerMessage: async (id) => update({ queuedComposerMessages: state.queuedComposerMessages.map((m: any) => m.id === id ? { ...m, mode: "steer" } : m) }),
    updateComposerDraft: async (d) => update({ composerDraft: d }),
    submitComposer: async (text, _options) => {
      const ts = nowISO();
      browserMessages = [...browserMessages, { id: `msg-${Date.now()}`, kind: "message", role: "user", text, createdAt: ts }];
      // ponytail: mock assistant reply after a short delay
      setTimeout(() => {
        browserMessages = [...browserMessages, { id: `msg-${Date.now()}-a`, kind: "message", role: "assistant", text: `Echo: ${text}`, createdAt: nowISO() }];
        transcriptListeners.forEach((fn) => fn(getBrowserTranscript()));
      }, 300);
      transcriptListeners.forEach((fn) => fn(getBrowserTranscript()));
      return state;
    },

    // Session tree
    getSessionTree: async () => ({ id: state.selectedSessionId, label: "" } as any),
    navigateSessionTree: async () => ({ state, result: { cancelled: false } }),

    // Workspace files
    listWorkspaceFiles: async () => [],
    readWorkspaceFile: async () => ({ path: "", content: "", truncated: false, binary: false, sizeBytes: 0 }),
    getChangedFiles: async () => [],
    getFileDiff: async () => "",
    stageFile: async () => {},

    // Window
    toggleWindowMaximize: async () => {},
    openExternal: async (url) => { window.open(url, "_blank"); },

    // Theme
    getThemeMode: async () => "system" as any,
    getResolvedTheme: async () => "dark" as any,
    setThemeMode: async (m) => update({ themeMode: m as any }),
    onThemeChanged: () => () => {},
  };
}

// ── Tauri mode: thin proxy ──────────────────────────────────

async function waitForTauriIpc(): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if ((window as any).__TAURI_INTERNALS__?.invoke) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export async function createTauriPiApp(): Promise<PiDesktopApi> {
  const tauriReady = await waitForTauriIpc();
  if (!tauriReady) {
    throw new Error("tauri-adapter: Tauri IPC not available after 10s");
  }

  // ── Event listeners ────────────────────────────────────

  const stateListeners = new Set<(s: DesktopAppState) => void>();
  const transcriptListeners = new Set<(t: SelectedTranscriptRecord | null) => void>();

  (async () => {
    try {
      const unsubState = await tauriListen<DesktopAppState>("pi-gui:state-changed", (e) => {
        stateListeners.forEach((fn) => fn(e.payload));
      });
      const unsubTranscript = await tauriListen<SelectedTranscriptRecord | null>("pi-gui:selected-transcript-changed", (e) => {
        transcriptListeners.forEach((fn) => fn(e.payload));
      });
      // Agent events — transcript is pushed directly via pi-gui:selected-transcript-changed
      await tauriListen<any>("agent-event", () => {});
    } catch (e) {
      console.warn("tauri-adapter: event listener setup failed:", e);
    }
  })();

  async function refreshTranscript(listeners: Set<(t: SelectedTranscriptRecord | null) => void>) {
    try {
      const transcript = await tauriInvoke<SelectedTranscriptRecord | null>("get_selected_transcript");
      console.log("[UI] refreshTranscript:", transcript ? `ws=${transcript.workspaceId} sess=${transcript.sessionId} count=${transcript.transcript.length}` : "null");
      listeners.forEach((fn) => fn(transcript));
    } catch { /* ignore */ }
  }

  // ── Thin proxy: every method directly forwards to Tauri invoke ──

  return {
    platform: "darwin" as DesktopPlatform,
    versions: {},

    ping: () => tauriInvoke("ping"),

    getState: () => tauriInvoke("get_state"),
    onStateChanged: (l) => { stateListeners.add(l); return () => stateListeners.delete(l); },

    getSelectedTranscript: () => tauriInvoke("get_selected_transcript"),
    onSelectedTranscriptChanged: (l) => { transcriptListeners.add(l); return () => transcriptListeners.delete(l); },
    onCommand: () => () => {},
    onWorkspacePicked: () => () => {},
    onClipboardImagePasted: () => () => {},
    getPathForFile: () => "",

    // Workspace
    addWorkspacePath: (p) => tauriInvoke("add_workspace_path", { path: p }),
    pickWorkspace: () => tauriInvoke("pick_workspace"),
    selectWorkspace: (id) => tauriInvoke("select_workspace", { workspaceId: id }),
    renameWorkspace: (id, n) => tauriInvoke("rename_workspace", { workspaceId: id, displayName: n }),
    removeWorkspace: (id) => tauriInvoke("remove_workspace", { workspaceId: id }),
    reorderWorkspaces: (o) => tauriInvoke("reorder_workspaces", { workspaceOrder: o }),
    reorderPinnedSessions: (o) => tauriInvoke("reorder_pinned_sessions", { pinnedSessionOrder: o }),
    openWorkspaceInFinder: (id) => tauriInvoke("open_workspace_in_finder", { workspaceId: id }),
    createWorktree: (i) => tauriInvoke("create_worktree", { input: i }),
    removeWorktree: (i) => tauriInvoke("remove_worktree", { input: i }),
    openSkillInFinder: (wid, fp) => tauriInvoke("open_skill_in_finder", { workspaceId: wid, filePath: fp }),
    openExtensionInFinder: (wid, fp) => tauriInvoke("open_extension_in_finder", { workspaceId: wid, filePath: fp }),
    syncCurrentWorkspace: () => tauriInvoke("sync_current_workspace"),

    // Session
    selectSession: (t) => tauriInvoke("select_session", { target: t }),
    archiveSession: (t) => tauriInvoke("archive_session", { target: t }),
    unarchiveSession: (t) => tauriInvoke("unarchive_session", { target: t }),
    setSessionPinned: (t, p) => tauriInvoke("set_session_pinned", { target: t, pinned: p }),
    createSession: (i) => tauriInvoke("create_session", { input: i }),
    startThread: (i) => tauriInvoke("start_thread", { input: i }),
    forkThread: (i) => tauriInvoke("fork_thread", { input: i }),
    sendChildThreadFollowUp: (i) => tauriInvoke("send_child_thread_follow_up", { input: i }),
    setChildSupervisionLoop: (i) => tauriInvoke("set_child_supervision_loop", { input: i }),
    cancelCurrentRun: () => tauriInvoke("cancel_current_run"),

    // View
    setActiveView: (v) => tauriInvoke("set_active_view", { view: v }),
    setSidebarCollapsed: (c) => tauriInvoke("set_sidebar_collapsed", { collapsed: c }),
    refreshRuntime: (wid) => tauriInvoke("refresh_runtime", { workspaceId: wid }),

    // Model
    setModelSettingsScopeMode: (m) => tauriInvoke("set_model_settings_scope_mode", { mode: m }),
    setDefaultModel: (wid, p, mid) => tauriInvoke("set_default_model", { workspaceId: wid, provider: p, modelId: mid }),
    setDefaultThinkingLevel: (wid, tl) => tauriInvoke("set_default_thinking_level", { workspaceId: wid, thinkingLevel: tl }),
    setSessionModel: (wid, sid, p, mid) => tauriInvoke("set_session_model", { workspaceId: wid, sessionId: sid, provider: p, modelId: mid }),
    setSessionThinkingLevel: (wid, sid, tl) => tauriInvoke("set_session_thinking_level", { workspaceId: wid, sessionId: sid, thinkingLevel: tl }),
    loginProvider: (wid, pid) => tauriInvoke("login_provider", { workspaceId: wid, providerId: pid }),
    logoutProvider: (wid, pid) => tauriInvoke("logout_provider", { workspaceId: wid, providerId: pid }),
    setProviderApiKey: (wid, pid, key) => tauriInvoke("set_provider_api_key", { workspaceId: wid, providerId: pid, apiKey: key }),
    listCustomProviders: () => tauriInvoke("list_custom_providers"),
    setCustomProvider: (wid, c) => tauriInvoke("set_custom_provider", { workspaceId: wid, config: c }),
    deleteCustomProvider: (wid, pid) => tauriInvoke("delete_custom_provider", { workspaceId: wid, providerId: pid }),
    probeCustomProviderModels: (i) => tauriInvoke("probe_custom_provider_models", { input: i }),
    setEnableSkillCommands: (wid, e) => tauriInvoke("set_enable_skill_commands", { workspaceId: wid, enabled: e }),
    setScopedModelPatterns: (wid, p) => tauriInvoke("set_scoped_model_patterns", { workspaceId: wid, patterns: p }),
    setSkillEnabled: (wid, fp, e) => tauriInvoke("set_skill_enabled", { workspaceId: wid, filePath: fp, enabled: e }),
    setExtensionEnabled: (wid, fp, e) => tauriInvoke("set_extension_enabled", { workspaceId: wid, filePath: fp, enabled: e }),
    respondToHostUiRequest: (wid, sid, r) => tauriInvoke("respond_to_host_ui_request", { workspaceId: wid, sessionId: sid, response: r }),

    // Notifications
    setNotificationPreferences: (p) => tauriInvoke("set_notification_preferences", { preferences: p }),
    setIntegratedTerminalShell: (s) => tauriInvoke("set_integrated_terminal_shell", { shell: s }),
    setEnableTransparency: (e) => tauriInvoke("set_enable_transparency", { enabled: e }),
    setThemePresetId: (id) => tauriInvoke("set_theme_preset_id", { presetId: id }),

    // Terminal
    ensureTerminalPanel: (wid, tsid, sz) => tauriInvoke("ensure_terminal_panel", { workspaceId: wid, terminalScopeId: tsid, size: sz }),
    createTerminalSession: (wid, tsid, sz) => tauriInvoke("create_terminal_session", { workspaceId: wid, terminalScopeId: tsid, size: sz }),
    setActiveTerminalSession: (wid, tsid, tid) => tauriInvoke("set_active_terminal_session", { workspaceId: wid, terminalScopeId: tsid, terminalId: tid }),
    writeTerminal: (tid, d) => tauriInvoke("write_terminal", { terminalId: tid, data: d }),
    resizeTerminal: (tid, sz) => tauriInvoke("resize_terminal", { terminalId: tid, size: sz }),
    restartTerminalSession: (tid, sz) => tauriInvoke("restart_terminal_session", { terminalId: tid, size: sz }),
    closeTerminalSession: (tid) => tauriInvoke("close_terminal_session", { terminalId: tid }),
    setTerminalTitle: (tid, t) => tauriInvoke("set_terminal_title", { terminalId: tid, title: t }),
    setTerminalFocused: async (f) => { tauriInvoke("set_terminal_focused", { focused: f }).catch(() => {}); },
    onTerminalData: () => () => {},
    onTerminalExit: () => () => {},
    onTerminalError: () => () => {},

    // Notifications permission
    getNotificationPermissionStatus: () => tauriInvoke("get_notification_permission_status"),
    requestNotificationPermission: () => tauriInvoke("request_notification_permission"),
    openSystemNotificationSettings: () => tauriInvoke("open_system_notification_settings"),
    onNotificationPermissionStatusChanged: () => () => {},

    // Composer
    pickComposerAttachments: () => tauriInvoke("pick_composer_attachments"),
    readClipboardImage: () => null,
    addComposerAttachments: (a) => tauriInvoke("add_composer_attachments", { attachments: a }),
    removeComposerAttachment: (id) => tauriInvoke("remove_composer_attachment", { attachmentId: id }),
    editQueuedComposerMessage: (mid, d) => tauriInvoke("edit_queued_composer_message", { messageId: mid, currentDraft: d }),
    cancelQueuedComposerEdit: () => tauriInvoke("cancel_queued_composer_edit"),
    removeQueuedComposerMessage: (id) => tauriInvoke("remove_queued_composer_message", { messageId: id }),
    steerQueuedComposerMessage: (id) => tauriInvoke("steer_queued_composer_message", { messageId: id }),
    updateComposerDraft: (d) => tauriInvoke("update_composer_draft", { composerDraft: d }),
    submitComposer: (t, o) => tauriInvoke("submit_composer", { text: t, options: o }),

    // Session tree
    getSessionTree: (t) => tauriInvoke("get_session_tree", { target: t }),
    navigateSessionTree: (t, tid, o) => tauriInvoke("navigate_session_tree", { target: t, targetId: tid, options: o }),

    // Workspace files
    listWorkspaceFiles: (wid, o) => tauriInvoke("list_workspace_files", { workspaceId: wid, options: o }),
    readWorkspaceFile: (wid, fp) => tauriInvoke("read_workspace_file", { workspaceId: wid, filePath: fp }),
    getChangedFiles: (wid) => tauriInvoke("get_changed_files", { workspaceId: wid }),
    getFileDiff: (wid, fp) => tauriInvoke("get_file_diff", { workspaceId: wid, filePath: fp }),
    stageFile: (wid, fp) => tauriInvoke("stage_file", { workspaceId: wid, filePath: fp }),

    // Window
    toggleWindowMaximize: () => tauriInvoke("toggle_window_maximize"),
    openExternal: (url) => tauriInvoke("open_external", { url }),

    // Theme
    getThemeMode: () => tauriInvoke("get_theme_mode"),
    getResolvedTheme: () => tauriInvoke("get_resolved_theme"),
    setThemeMode: (m) => tauriInvoke("set_theme_mode", { mode: m }),
    onThemeChanged: () => () => {},
  };
}
