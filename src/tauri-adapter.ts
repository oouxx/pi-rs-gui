/**
 * Tauri adapter — provides PiDesktopApi backed by Tauri invoke/events.
 *
 * Thin proxy over api/commands and api/events that wraps Tauri IPC into
 * the window.piApp API expected by App.tsx.
 */
import type { DesktopAppState, SelectedTranscriptRecord } from "./types";
import type { DesktopPlatform, PiDesktopApi } from "./types";
import { tauriInvoke, desktopIpc } from "./api/commands";
import { tauriListen } from "./api/events";

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
      const unsubState = await tauriListen<DesktopAppState>(desktopIpc.stateChanged, (e) => {
        stateListeners.forEach((fn) => fn(e));
      });
      const unsubTranscript = await tauriListen<SelectedTranscriptRecord | null>(desktopIpc.selectedTranscriptChanged, (e) => {
        transcriptListeners.forEach((fn) => fn(e));
      });
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
    renameSession: (t, title) => tauriInvoke("rename_session", { target: t, title }),
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
    getDefaultModel: (wid) => tauriInvoke("get_default_model", { workspaceId: wid }),
    getModels: (wid) => tauriInvoke("get_models", { workspaceId: wid }),
    getProviders: (wid) => tauriInvoke("get_providers", { workspaceId: wid }),
    getModelSettings: (wid) => tauriInvoke("get_model_settings", { workspaceId: wid }),
    listCustomProviders: () => tauriInvoke("list_custom_providers"),
    getCustomProvider: (pid) => tauriInvoke("get_custom_provider", { providerId: pid }),
    setCustomProvider: (wid, c) => tauriInvoke("set_custom_provider", { workspaceId: wid, config: c }),
    deleteCustomProvider: (wid, pid) => tauriInvoke("delete_custom_provider", { workspaceId: wid, providerId: pid }),
    probeCustomProviderModels: (baseUrl, apiKey) => tauriInvoke("probe_custom_provider_models", { baseUrl, apiKey }),
    hasProviderAuth: (pid) => tauriInvoke("has_provider_auth", { providerId: pid }),
    listSkills: (wid) => tauriInvoke("list_skills", { workspaceId: wid }),
    getSkill: (wid, name) => tauriInvoke("get_skill", { workspaceId: wid, name }),
    deleteSkill: (wid, name) => tauriInvoke("delete_skill", { workspaceId: wid, name }),
    listExtensions: (wid) => tauriInvoke("list_extensions", { workspaceId: wid }),
    getExtension: (wid, name) => tauriInvoke("get_extension", { workspaceId: wid, name }),
    deleteExtension: (wid, name) => tauriInvoke("delete_extension", { workspaceId: wid, name }),
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
