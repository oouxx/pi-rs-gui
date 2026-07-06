/**
 * Tauri adapter — implements PiDesktopApi by calling our Rust backend via invoke().
 */

// Access Tauri IPC via window.__TAURI_INTERNALS__ (set by Tauri before any script runs)
function getTauriWindow() {
  return (window as any).__TAURI_INTERNALS__;
}

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const win = getTauriWindow();
  if (!win) throw new Error("Tauri IPC not available (window.__TAURI_INTERNALS__ missing)");
  return win.invoke(cmd, args) as Promise<T>;
}

async function tauriListen<T>(event: string, handler: (event: { payload: T }) => void) {
  const { listen } = await import("@tauri-apps/api/event");
  return listen(event, handler);
}
import type { DesktopAppState, SelectedTranscriptRecord, TranscriptMessage } from "./desktop-state";
import { createEmptyDesktopAppState } from "./desktop-state";
import type {
  PiDesktopApi,
  PiDesktopStateListener,
  PiDesktopSelectedTranscriptListener,
} from "./ipc";

// ── Helpers ─────────────────────────────────────────────────

let _rev = 0;
function nextRev() { return ++_rev; }
function nowISO() { return new Date().toISOString(); }

// ── Adapter ─────────────────────────────────────────────────

export function createTauriPiApp(): PiDesktopApi {
  const stateListeners = new Set<PiDesktopStateListener>();
  const transcriptListeners = new Set<PiDesktopSelectedTranscriptListener>();
  let unsubEvent: UnlistenFn | null = null;

  // Pre-populate state with a workspace + session so the UI renders immediately
  const WS_ID = "ws-default";
  const SESS_ID = "sess-init";

  let state: DesktopAppState = (() => {
    const base = createEmptyDesktopAppState();
    return {
      ...base,
      revision: nextRev(),
      workspaces: [{
        id: WS_ID,
        name: "default",
        path: "/tmp",
        lastOpenedAt: nowISO(),
        kind: "primary" as const,
        sessions: [{
          id: SESS_ID,
          title: "New thread",
          updatedAt: nowISO(),
          preview: "",
          status: "idle" as const,
          hasUnseenUpdate: false,
        }],
      }],
      selectedWorkspaceId: WS_ID,
      selectedSessionId: SESS_ID,
      activeView: "threads",
    };
  })();

  let transcript: SelectedTranscriptRecord | null = {
    workspaceId: WS_ID,
    sessionId: SESS_ID,
    transcript: [],
  };

  // ── Rust backend connection state ──────────────────────────

  let rustReady = false;
  let rustReadyResolve: (() => void) | null = null;
  const rustReadyPromise = new Promise<void>((r) => { rustReadyResolve = r; });

  // Kick off Rust session creation immediately
  (async () => {
    // Then create the session
    for (let i = 0; i < 10; i++) {
      try {
        await tauriInvoke("create_session", { cwd: "/tmp" });
        rustReady = true;
        rustReadyResolve?.();
        console.log("tauri-adapter: Rust session created");
        break;
      } catch (e) {
        console.error(`tauri-adapter: create_session failed (attempt ${i + 1}):`, e);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!rustReady) {
      console.error("tauri-adapter: Rust backend not available after all retries");
      rustReadyResolve?.();
    }
  })();

  // ── Agent event listener (lazy — needs Tauri IPC) ────────

  (async () => {
    for (let i = 0; i < 30; i++) {
      try { await tauriInvoke("is_streaming"); break; }
      catch { await new Promise((r) => setTimeout(r, 200)); }
    }
    try {
      unsubEvent = await tauriListen<any>("agent-event", (event) => {
        handleAgentEvent(event.payload);
      });
    } catch {
      console.warn("tauri-adapter: failed to set up event listener");
    }
  })();

  // ── Event handler ─────────────────────────────────────────

  function handleAgentEvent(payload: any) {
    const { event_type, data } = payload;
    switch (event_type) {
      case "agent_start":
        state = { ...state, revision: nextRev(),
          workspaces: state.workspaces.map((w) =>
            w.id === WS_ID ? { ...w, sessions: w.sessions.map((s) =>
              s.id === SESS_ID ? { ...s, status: "running" as const, runningSince: nowISO() } : s) } : w) };
        emitState();
        break;

      case "agent_end":
      case "turn_end":
        state = { ...state, revision: nextRev(),
          workspaces: state.workspaces.map((w) =>
            w.id === WS_ID ? { ...w, sessions: w.sessions.map((s) =>
              s.id === SESS_ID ? { ...s, status: "idle" as const } : s) } : w) };
        emitState();
        refreshTranscript();
        break;

      case "user_message": {
        // Add user message to transcript immediately (no IPC roundtrip)
        const text = data?.text || "";
        if (text && transcript) {
          const newMsg: TranscriptMessage = {
            id: "user-" + Date.now(),
            role: "user",
            text,
            createdAt: nowISO(),
          };
          transcript = { ...transcript, transcript: [...transcript.transcript, newMsg] };
          emitTranscript();
        }
        break;
      }
      case "message_start":
        refreshTranscript();
        break;

      case "message_update":
        // Don't poll on every delta — too much IPC; wait for message_end
        break;

      case "message_end":
        refreshTranscript();
        break;

      case "tool_execution_start":
      case "tool_execution_end":
        refreshTranscript();
        break;
    }
  }

  function emitState() {
    stateListeners.forEach((fn) => fn(state));
  }

  function emitTranscript() {
    transcriptListeners.forEach((fn) => fn(transcript));
  }

  async function refreshTranscript() {
    if (!rustReady) return;
    try {
      const messages = await tauriInvoke<any[]>("get_messages");
      const converted: TranscriptMessage[] = messages.map((msg: any) => ({
        id: msg.id || crypto.randomUUID(),
        role: msg.type === "User" ? "user" as const : "assistant" as const,
        text: extractText(msg),
        createdAt: msg.timestamp ? new Date(msg.timestamp).toISOString() : nowISO(),
      }));
      transcript = { ...transcript!, transcript: converted };
    } catch { /* not ready */ }
    emitTranscript();
  }

  // ── PiDesktopApi implementation ──────────────────────────

  return {
    platform: "darwin" as NodeJS.Platform,
    versions: {} as NodeJS.ProcessVersions,

    async ping() { return "pong"; },

    async getState() { return state; },

    onStateChanged(listener: PiDesktopStateListener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },

    async getSelectedTranscript() { return transcript; },

    onSelectedTranscriptChanged(listener: PiDesktopSelectedTranscriptListener) {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },

    onCommand() { return () => {}; },
    onWorkspacePicked() { return () => {}; },
    onClipboardImagePasted() { return () => {}; },
    getPathForFile() { return ""; },

    // ── Workspaces ─────────────────────────────────────────

    async addWorkspacePath(path: string) {
      const wid = "ws-" + Date.now();
      state = { ...state, revision: nextRev(),
        workspaces: [...state.workspaces, {
          id: wid, name: path.split("/").pop() || path, path,
          lastOpenedAt: nowISO(), kind: "primary" as const, sessions: [],
        }],
        selectedWorkspaceId: wid,
      };
      emitState();
      return state;
    },
    async pickWorkspace() { return state; },
    async selectWorkspace(id: string) {
      state = { ...state, revision: nextRev(), selectedWorkspaceId: id };
      emitState();
      return state;
    },
    async renameWorkspace(id: string, name: string) {
      state = { ...state, revision: nextRev(),
        workspaces: state.workspaces.map((w) => w.id === id ? { ...w, name } : w),
      };
      emitState();
      return state;
    },
    async removeWorkspace(id: string) {
      state = { ...state, revision: nextRev(),
        workspaces: state.workspaces.filter((w) => w.id !== id),
        selectedWorkspaceId: state.workspaces[0]?.id || state.selectedWorkspaceId,
      };
      emitState();
      return state;
    },
    async reorderWorkspaces() { return state; },
    async reorderPinnedSessions() { return state; },
    async openWorkspaceInFinder() {},
    async createWorktree() { return state; },
    async removeWorktree() { return state; },
    async openSkillInFinder() {},
    async openExtensionInFinder() {},
    async syncCurrentWorkspace() { return state; },

    // ── Sessions ───────────────────────────────────────────

    async selectSession(target: { workspaceId: string; sessionId: string }) {
      state = { ...state, revision: nextRev(),
        selectedWorkspaceId: target.workspaceId,
        selectedSessionId: target.sessionId,
      };
      emitState();
      return state;
    },
    async archiveSession(target: { workspaceId: string; sessionId: string }) {
      state = { ...state, revision: nextRev(),
        workspaces: state.workspaces.map((w) =>
          w.id === target.workspaceId ? {
            ...w, sessions: w.sessions.map((s) =>
              s.id === target.sessionId ? { ...s, archivedAt: nowISO() } : s),
          } : w),
      };
      emitState();
      return state;
    },
    async unarchiveSession(target: { workspaceId: string; sessionId: string }) {
      state = { ...state, revision: nextRev(),
        workspaces: state.workspaces.map((w) =>
          w.id === target.workspaceId ? {
            ...w, sessions: w.sessions.map((s) =>
              s.id === target.sessionId ? { ...s, archivedAt: undefined } : s),
          } : w),
      };
      emitState();
      return state;
    },
    async setSessionPinned(target: { workspaceId: string; sessionId: string }, pinned: boolean) {
      state = { ...state, revision: nextRev(),
        workspaces: state.workspaces.map((w) =>
          w.id === target.workspaceId ? {
            ...w, sessions: w.sessions.map((s) =>
              s.id === target.sessionId ? { ...s, pinnedAt: pinned ? nowISO() : undefined } : s),
          } : w),
      };
      emitState();
      return state;
    },
    async createSession(input: { workspaceId: string; title?: string }) {
      const sid = "sess-" + Date.now();
      state = { ...state, revision: nextRev(),
        workspaces: state.workspaces.map((w) =>
          w.id === input.workspaceId ? {
            ...w, sessions: [...w.sessions, {
              id: sid, title: input.title || "New thread",
              updatedAt: nowISO(), preview: "", status: "idle" as const,
              hasUnseenUpdate: false,
            }],
          } : w),
        selectedSessionId: sid,
      };
      emitState();
      return state;
    },

    async startThread(input: { rootWorkspaceId: string; environment: string; prompt?: string }) {
      await rustReadyPromise;
      if (input.prompt) {
        try { await tauriInvoke("send_message", { text: input.prompt }); }
        catch (e) { console.error("send_message failed:", e); }
      }
      return state;
    },

    async forkThread() { return state; },
    async sendChildThreadFollowUp() { return state; },
    async setChildSupervisionLoop() { return state; },

    async cancelCurrentRun() {
      try { await tauriInvoke("abort"); } catch {}
      state = { ...state, revision: nextRev(),
        workspaces: state.workspaces.map((w) =>
          w.id === state.selectedWorkspaceId ? {
            ...w, sessions: w.sessions.map((s) =>
              s.id === state.selectedSessionId ? { ...s, status: "idle" as const } : s),
          } : w),
      };
      emitState();
      return state;
    },

    // ── Views ──────────────────────────────────────────────

    async setActiveView(view: string) {
      state = { ...state, revision: nextRev(), activeView: view as any };
      emitState();
      return state;
    },
    async setSidebarCollapsed(collapsed: boolean) {
      state = { ...state, revision: nextRev(), sidebarCollapsed: collapsed };
      emitState();
      return state;
    },
    async refreshRuntime() { return state; },

    // ── Model (stubs) ──────────────────────────────────────

    async setModelSettingsScopeMode() { return state; },
    async setDefaultModel() { return state; },
    async setDefaultThinkingLevel() { return state; },
    async setSessionModel() { return state; },
    async setSessionThinkingLevel() { return state; },
    async loginProvider() { return state; },
    async logoutProvider() { return state; },
    async setProviderApiKey() { return state; },
    async listCustomProviders() { return []; },
    async setCustomProvider() { return state; },
    async deleteCustomProvider() { return state; },
    async probeCustomProviderModels() { return { ok: false as const, error: "not available" }; },
    async setEnableSkillCommands() { return state; },
    async setScopedModelPatterns() { return state; },
    async setSkillEnabled() { return state; },
    async setExtensionEnabled() { return state; },
    async respondToHostUiRequest() { return state; },

    // ── Notifications ──────────────────────────────────────

    async setNotificationPreferences(prefs: any) {
      state = { ...state, revision: nextRev(),
        notificationPreferences: { ...state.notificationPreferences, ...prefs },
      };
      emitState();
      return state;
    },
    async setIntegratedTerminalShell(shell: string) {
      state = { ...state, revision: nextRev(), integratedTerminalShell: shell };
      emitState();
      return state;
    },
    async setEnableTransparency(enabled: boolean) {
      state = { ...state, revision: nextRev(), enableTransparency: enabled };
      emitState();
      return state;
    },

    // ── Theme ──────────────────────────────────────────────

    async setThemePresetId(presetId: string) {
      state = { ...state, revision: nextRev(), themePresetId: presetId as any };
      emitState();
      return state;
    },

    // ── Terminal (stubs) ───────────────────────────────────

    async ensureTerminalPanel() { return { workspaceId: "", rootKey: "default", activeSessionId: "", sessions: [] }; },
    async createTerminalSession() { return { workspaceId: "", rootKey: "default", activeSessionId: "", sessions: [] }; },
    async setActiveTerminalSession() { return { workspaceId: "", rootKey: "default", activeSessionId: "", sessions: [] }; },
    async writeTerminal() {},
    async resizeTerminal() {},
    async restartTerminalSession() { return { workspaceId: "", rootKey: "default", activeSessionId: "", sessions: [] }; },
    async closeTerminalSession() { return null; },
    async setTerminalTitle() {},
    async setTerminalFocused() {},
    onTerminalData() { return () => {}; },
    onTerminalExit() { return () => {}; },
    onTerminalError() { return () => {}; },

    // ── Notifications permission ───────────────────────────

    async getNotificationPermissionStatus() { return "default" as const; },
    async requestNotificationPermission() { return "default" as const; },
    async openSystemNotificationSettings() {},
    onNotificationPermissionStatusChanged() { return () => {}; },

    // ── Composer ───────────────────────────────────────────

    async pickComposerAttachments() { return state; },
    readClipboardImage() { return null; },
    async addComposerAttachments(_attachments: any) {
      state = { ...state, revision: nextRev(), composerAttachments: _attachments as any };
      emitState();
      return state;
    },
    async removeComposerAttachment(id: string) {
      state = { ...state, revision: nextRev(),
        composerAttachments: state.composerAttachments.filter((a) => a.id !== id),
      };
      emitState();
      return state;
    },
    async editQueuedComposerMessage() { return state; },
    async cancelQueuedComposerEdit() { return state; },
    async removeQueuedComposerMessage(id: string) {
      state = { ...state, revision: nextRev(),
        queuedComposerMessages: state.queuedComposerMessages.filter((m) => m.id !== id),
      };
      emitState();
      return state;
    },
    async steerQueuedComposerMessage() { return state; },
    async updateComposerDraft(draft: string) {
      state = { ...state, revision: nextRev(), composerDraft: draft };
      emitState();
      return state;
    },

    async submitComposer(text: string) {
      await rustReadyPromise;
      try {
        await tauriInvoke("send_message", { text });
      } catch (e) {
        console.error("submit failed:", e);
        state = { ...state, revision: nextRev(), lastError: String(e) };
        emitState();
      }
      return state;
    },

    // ── Session tree ───────────────────────────────────────

    async getSessionTree() { return { id: state.selectedSessionId, label: "" }; },
    async navigateSessionTree() { return { state, result: { cancelled: false } }; },

    // ── Workspace files (stubs) ────────────────────────────

    async listWorkspaceFiles() { return []; },
    async readWorkspaceFile() { return { path: "", content: "", truncated: false, binary: false, sizeBytes: 0 }; },
    async getChangedFiles() { return []; },
    async getFileDiff() { return ""; },
    async stageFile() {},

    // ── Window ─────────────────────────────────────────────

    async toggleWindowMaximize() {},
    async openExternal() {},

    // ── Theme mode ─────────────────────────────────────────

    async getThemeMode() { return "system" as const; },
    async getResolvedTheme() { return "dark" as const; },
    async setThemeMode(mode: string) {
      state = { ...state, revision: nextRev(), themeMode: mode as any };
      emitState();
      return state;
    },
    onThemeChanged() { return () => {}; },
  };
}

// ── Text extraction from pi-rs messages ────────────────────

function extractText(msg: any): string {
  if (!msg.content) return "";
  const blocks = msg.content as Array<{ type: string; text?: string }>;
  return blocks.filter((b) => b.type === "text" && b.text).map((b) => b.text!).join("");
}
