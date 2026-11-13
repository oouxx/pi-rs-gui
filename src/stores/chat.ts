import { useEffect } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import {
  getState,
  submitComposer,
  getSelectedTranscript,
  cancelCurrentRun,
  selectSession as apiSelectSession,
  createSession as apiCreateSession,
  archiveSession as apiArchiveSession,
  deleteSession as apiDeleteSession,
  renameSession as apiRenameSession,
  type ComposerImage,
  type DesktopAppState,
  type QueuedMessage,
  type StreamingBehavior,
} from "../api/commands";
import { tauriListen } from "../api/events";
import { EVENTS } from "../api/eventNames";
import type { TextAttachment } from "../lib/attachments";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { AgentEventPayload, TranscriptPayload } from "../api/types";
import {
  appendAssistantStep,
  applyDeltaBatch,
  extractText,
  replaceAssistantStep,
  toBlocks,
  transcriptToDisplay,
  type DisplayMessage,
  type StreamDelta,
} from "../hooks/message-reducer";
import { showToast } from "../components/ui/toast";

export interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  cwd?: string | null;
  preview?: string;
}

/** Keep in sync with the backend actor's turn timeout (`actor.rs`). */
const TURN_TIMEOUT_MS = 300_000;

// ── Module-scoped mutable state ─────────────────────────────────
// Event listeners and delta batching must not live in React state: the store
// is a singleton, and these counters/queues change far more often than the UI
// should re-render.
let activeSessionIdRef: string | null = null;
let streamingRef = false;
let transcriptGen = 0;
// Block offset of the current assistant step within its merged message
// (consecutive steps of a tool-calling run render as one bubble).
let stepOffset = 0;
// Streaming delta batching: accumulate deltas and flush once per rAF so
// multiple tokens within a frame trigger a single render.
let deltaQueue: StreamDelta[] = [];
let deltaRaf: number | null = null;

function flushDeltas() {
  deltaRaf = null;
  if (deltaQueue.length === 0) return;
  const batch = deltaQueue;
  deltaQueue = [];
  useChatStore.setState((state) => ({
    messages: applyDeltaBatch(state.messages, batch),
  }));
}

function queueDelta(event_type: string, data: AgentEventPayload["data"]) {
  deltaQueue.push({ event_type, data, offset: stepOffset });
  if (deltaRaf === null) deltaRaf = requestAnimationFrame(flushDeltas);
}

function dropQueuedDeltas() {
  if (deltaRaf !== null) cancelAnimationFrame(deltaRaf);
  deltaRaf = null;
  deltaQueue = [];
}

/** Extract display text + tool-specific details from an `AgentToolResult`. */
function toolResultPayload(result: unknown): {
  text: string;
  details?: unknown;
} {
  if (typeof result === "string") return { text: result };
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    const content = record.content;
    let text = "";
    if (Array.isArray(content)) {
      text = content
        .map((block) => {
          if (!block || typeof block !== "object") return "";
          const item = block as Record<string, unknown>;
          return item.type === "text" ? String(item.text ?? "") : "";
        })
        .join("");
    }
    if (!text) text = JSON.stringify(result, null, 2);
    return { text, details: record.details };
  }
  return { text: result == null ? "" : String(result) };
}

/** OS notification for a background run; best effort when permission is
 *  missing, and suppressed while the window is focused. */
async function notifyBackground(title: string, body: string) {
  try {
    if (document.hasFocus()) return;
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (granted) sendNotification({ title, body });
  } catch {
    /* notifications are optional */
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface ChatState {
  sessions: SessionItem[];
  activeSessionId: string | null;
  messages: DisplayMessage[];
  streaming: boolean;
  queued: QueuedMessage[];
  loading: boolean;

  applyState(state: DesktopAppState): void;
  refreshState(): Promise<void>;
  selectSession(sessionId: string): Promise<void>;
  createSession(title?: string, cwd?: string): Promise<string | null>;
  deleteSession(sessionId: string): Promise<void>;
  archiveSession(sessionId: string): Promise<void>;
  stop(): Promise<void>;
  sendMessage(
    text: string,
    attachments?: ComposerImage[],
    streamingBehavior?: StreamingBehavior,
    files?: TextAttachment[],
  ): Promise<void>;

  /** Handle one `agent-event` payload for the selected session. */
  handleAgentEvent(evt: AgentEventPayload): void;
  /** Replace messages from a full transcript payload. */
  applyTranscript(payload: TranscriptPayload | null): void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  messages: [],
  streaming: false,
  queued: [],
  loading: true,

  applyState(state) {
    set({
      sessions: (state.sessions ?? [])
        .filter((s) => !s.archivedAt)
        .map((s) => ({
          id: s.id,
          title: s.title || "Untitled",
          updatedAt: s.updatedAt,
          status: s.status,
          cwd: s.cwd ?? null,
          preview: s.preview ?? "",
        })),
      // Only adopt the backend's selection when it changed; otherwise a stale
      // snapshot can pull the user back after an in-flight local switch.
      ...(state.selectedSessionId &&
      state.selectedSessionId !== activeSessionIdRef
        ? { activeSessionId: state.selectedSessionId }
        : {}),
      loading: false,
    });
  },

  async refreshState() {
    try {
      get().applyState(await getState());
    } catch {
      // A failed refresh leaves the last known state in place; the next
      // state-changed event retries.
    }
  },

  async selectSession(sessionId) {
    // Set the ref BEFORE the await: the backend emits state-changed mid-switch,
    // which would otherwise adopt a stale selection and trigger a duplicate
    // transcript fetch that selectSession's reset can wipe.
    const prevRef = activeSessionIdRef;
    activeSessionIdRef = sessionId;
    try {
      await apiSelectSession(sessionId);
    } catch (error) {
      activeSessionIdRef = prevRef;
      throw error;
    }
    set({ activeSessionId: sessionId, messages: [] });
    // Multi-session: the backend no longer aborts the old session. Derive
    // streaming from the selected session's status.
    try {
      const state = await getState();
      const sess = (state.sessions ?? []).find((s) => s.id === sessionId);
      const running = sess?.status === "running";
      streamingRef = running;
      set({ streaming: running });
    } catch {
      streamingRef = false;
      set({ streaming: false });
    }
  },

  async createSession(title, cwd) {
    const newState = await apiCreateSession(title, cwd);
    const newId = newState.selectedSessionId;
    if (newId) {
      activeSessionIdRef = newId;
      set({ activeSessionId: newId });
    }
    streamingRef = false;
    set({ messages: [], streaming: false });
    void get().refreshState();
    return newId;
  },

  async deleteSession(sessionId) {
    await apiDeleteSession(sessionId);
    await get().refreshState();
  },

  async archiveSession(sessionId) {
    await apiArchiveSession(sessionId);
    await get().refreshState();
  },

  async stop() {
    try {
      await cancelCurrentRun();
    } catch {
      // Stopping is best-effort; the transcript event clears streaming anyway.
    }
    streamingRef = false;
    set({ streaming: false });
  },

  async sendMessage(text, attachments, streamingBehavior, files) {
    const attachedBlock =
      files && files.length > 0
        ? `<attached_files>\n${files
            .map(
              (file) =>
                `<file name="${file.name.replace(/"/g, "'")}">\n${file.content}\n</file>`,
            )
            .join("\n")}\n</attached_files>`
        : "";
    const payloadText = [text, attachedBlock].filter(Boolean).join("\n\n");
    const hasContent =
      !!text.trim() ||
      (attachments != null && attachments.length > 0) ||
      (files != null && files.length > 0);
    if (!hasContent) return;
    const wasStreaming = streamingRef;
    if (wasStreaming && !streamingBehavior) return;

    // Queue into the running turn. No optimistic user bubble: streaming deltas
    // only ever target the last assistant message, so a user message at the
    // tail would swallow them.
    if (wasStreaming && streamingBehavior) {
      set((state) => ({
        queued: [
          ...state.queued,
          {
            text:
              text.trim() ||
              files?.map((file) => file.name).join(", ") ||
              "(attachment)",
            mode: streamingBehavior,
          },
        ],
      }));
      try {
        await submitComposer(payloadText, attachments, streamingBehavior);
      } catch (error) {
        set((state) => ({ queued: state.queued.slice(0, -1) }));
        showToast({
          variant: "error",
          title: "Could not queue message",
          description: errorText(error),
        });
      }
      return;
    }

    // Auto-title: rename "New thread" sessions based on the first message.
    const currentSid = activeSessionIdRef;
    const currentSession = currentSid
      ? get().sessions.find((s) => s.id === currentSid)
      : null;
    if (
      currentSession &&
      currentSession.title === "New thread" &&
      (text.trim() || files?.length)
    ) {
      const autoTitle = (text.trim() || files?.[0]?.name || "Attachment").slice(
        0,
        60,
      );
      apiRenameSession(currentSession.id, autoTitle).catch(() => {});
    }

    // Optimistically add the user message (text + attachment thumbnails).
    // `payloadText` includes the <attached_files> marker so MessageItem can
    // render compact file chips instead of the inlined content.
    const blocks: DisplayMessage["blocks"] = [{ type: "text", text: payloadText }];
    if (attachments && attachments.length > 0) {
      for (const a of attachments) {
        blocks.push({
          type: "image",
          data: a.data,
          mimeType: a.mimeType,
          text: `data:${a.mimeType};base64,${a.data}`,
        });
      }
    }
    const userMsg: DisplayMessage = {
      id: `msg-opt-${Date.now()}`,
      role: "user",
      content: payloadText,
      blocks,
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, userMsg] }));
    streamingRef = true;
    set({ streaming: true });
    try {
      await submitComposer(payloadText, attachments);
      // Safety net matching the backend's turn timeout. The transcript event
      // normally clears streaming when the turn ends.
      setTimeout(() => {
        if (streamingRef) {
          streamingRef = false;
          set({ streaming: false });
        }
      }, TURN_TIMEOUT_MS);
    } catch (error) {
      streamingRef = false;
      set({ streaming: false });
      showToast({
        variant: "error",
        title: "Send failed",
        description: errorText(error),
      });
    }
  },

  handleAgentEvent(evt) {
    if (evt.session_id !== activeSessionIdRef) return;
    const et = evt.event_type;

    if (et === "message_start") {
      // pi-rs also emits MessageStart for user prompts and tool results; only
      // assistant messages become bubbles.
      const msg = evt.data?.message;
      if (!msg || msg.role !== "assistant") return;
      streamingRef = true;
      set({ streaming: true });
      const rawBlocks = msg.content;
      const blocks = toBlocks(rawBlocks);
      const text = extractText(rawBlocks);
      const errorMessage =
        typeof msg.error_message === "string" && msg.error_message
          ? msg.error_message
          : undefined;
      set((state) => {
        // Consecutive steps of a tool-calling run merge into one bubble. The
        // reducer records the step's block offset for this step's deltas.
        const { messages, stepOffset: offset } = appendAssistantStep(
          state.messages,
          blocks,
          text,
          errorMessage,
        );
        stepOffset = offset;
        return { messages };
      });
      return;
    }

    if (
      et === "text_delta" ||
      et === "thinking_delta" ||
      et === "toolcall_start" ||
      et === "toolcall_delta" ||
      et === "toolcall_end"
    ) {
      queueDelta(et, evt.data);
      return;
    }

    if (et === "message_done" || et === "message_end") {
      // Full message at stream end — self-heal. With merged steps, only the
      // current step's blocks (from the recorded offset) are replaced.
      const msg = evt.data?.message;
      if (!msg || msg.role !== "assistant") return;
      const rawBlocks = msg.content;
      if (!rawBlocks) return;
      const blocks = toBlocks(rawBlocks);
      const errorMessage =
        typeof msg.error_message === "string" && msg.error_message
          ? msg.error_message
          : undefined;
      set((state) => ({
        messages: replaceAssistantStep(
          state.messages,
          stepOffset,
          blocks,
          errorMessage,
        ),
      }));
      return;
    }

    if (et === "run_error") {
      // Turn-level failure with no message payload — surface it as an error
      // bubble + toast.
      const message = evt.data?.message;
      const text = message ? String(message) : "Unknown error";
      streamingRef = false;
      set((state) => ({
        streaming: false,
        messages: [
          ...state.messages,
          {
            id: `msg-err-${Date.now()}`,
            role: "assistant",
            content: "",
            blocks: [],
            createdAt: new Date().toISOString(),
            errorMessage: text,
          },
        ],
      }));
      showToast({ variant: "error", title: "Run failed", description: text });
      return;
    }

    if (et === "tool_execution_start") {
      const { tool_call_id, tool_name } = evt.data;
      set((state) => {
        if (state.messages.length === 0) return state;
        const last = state.messages[state.messages.length - 1];
        if (last.role !== "assistant") return state;
        const blocks = last.blocks.map((b) =>
          b.type === "toolCall" && (b.id === tool_call_id || b.name === tool_name)
            ? { ...b, status: "running" as const }
            : b,
        );
        return {
          messages: [...state.messages.slice(0, -1), { ...last, blocks }],
        };
      });
      return;
    }

    if (et === "tool_execution_update") {
      const { tool_call_id } = evt.data;
      const partial = evt.data.partial_result;
      const partialStr =
        typeof partial === "string" ? partial : JSON.stringify(partial, null, 2);
      set((state) => {
        if (state.messages.length === 0) return state;
        const last = state.messages[state.messages.length - 1];
        if (last.role !== "assistant") return state;
        const blocks = last.blocks.map((b) =>
          b.type === "toolCall" && b.id === tool_call_id
            ? { ...b, result: (b.result ?? "") + partialStr }
            : b,
        );
        return {
          messages: [...state.messages.slice(0, -1), { ...last, blocks }],
        };
      });
      return;
    }

    if (et === "tool_execution_end") {
      const { tool_call_id, result, is_error } = evt.data;
      const { text: resultStr, details } = toolResultPayload(result);
      set((state) => {
        if (state.messages.length === 0) return state;
        const last = state.messages[state.messages.length - 1];
        if (last.role !== "assistant") return state;
        const blocks = last.blocks.map((b) =>
          b.type === "toolCall" && b.id === tool_call_id
            ? {
                ...b,
                status: is_error ? ("error" as const) : ("success" as const),
                result: resultStr,
                isError: !!is_error,
                details,
              }
            : b,
        );
        return {
          messages: [...state.messages.slice(0, -1), { ...last, blocks }],
        };
      });
    }
  },

  applyTranscript(payload) {
    streamingRef = false;
    set({
      messages: payload ? transcriptToDisplay(payload.transcript) : [],
      streaming: false,
    });
  },
}));

// ── Event subscriptions (mounted once by <ChatProvider>) ───────

/** Wire the store to Tauri events. Mounted exactly once, at the app root. */
export function useChatSync() {
  // Full state snapshots.
  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | undefined;
    void (async () => {
      const u = await tauriListen<DesktopAppState>(EVENTS.stateChanged, (state) =>
        useChatStore.getState().applyState(state),
      );
      if (disposed) {
        u();
        return;
      }
      unsub = u;
    })();
    void useChatStore.getState().refreshState();
    return () => {
      disposed = true;
      unsub?.();
    };
  }, []);

  // Mirror frequently-read values into module scope and react to lifecycle
  // transitions without re-rendering React components.
  useEffect(() => {
    return useChatStore.subscribe((state, prev) => {
      if (state.streaming !== prev.streaming) streamingRef = state.streaming;
      if (state.activeSessionId !== prev.activeSessionId) {
        activeSessionIdRef = state.activeSessionId;
      }
      // Pending steer/follow-up chips clear when the run ends.
      if (prev.streaming && !state.streaming && state.queued.length > 0) {
        useChatStore.setState({ queued: [] });
      }
      // Notify when a non-active (background) session finishes its run.
      if (state.sessions !== prev.sessions) {
        for (const session of state.sessions) {
          const before = prev.sessions.find((s) => s.id === session.id);
          if (
            before?.status === "running" &&
            session.status !== "running" &&
            session.id !== activeSessionIdRef
          ) {
            const title =
              session.status === "error" ? "Session failed" : "Session finished";
            showToast({
              title,
              description: session.title || "Untitled",
              variant: session.status === "error" ? "error" : "default",
            });
            void notifyBackground(title, session.title || "Untitled");
          }
        }
      }
    });
  }, []);

  // Agent + transcript listeners follow the selected session.
  useEffect(() => {
    let disposed = false;
    let currentSession: string | null = null;
    let unsubAgent: (() => void) | undefined;
    let unsubTranscript: (() => void) | undefined;

    const teardown = () => {
      dropQueuedDeltas();
      unsubAgent?.();
      unsubTranscript?.();
      unsubAgent = undefined;
      unsubTranscript = undefined;
    };

    const setup = (sessionId: string | null) => {
      teardown();
      currentSession = sessionId;
      activeSessionIdRef = sessionId;
      if (!sessionId) return;
      const gen = ++transcriptGen;
      useChatStore.setState({ messages: [] });

      void getSelectedTranscript().then((transcript) => {
        if (disposed || gen !== transcriptGen) return;
        useChatStore.setState({
          messages: transcript ? transcriptToDisplay(transcript.transcript) : [],
        });
      });

      void (async () => {
        const u = await tauriListen<AgentEventPayload>(EVENTS.agentEvent, (evt) => {
          if (disposed) return;
          useChatStore.getState().handleAgentEvent(evt);
        });
        if (disposed || currentSession !== sessionId) {
          u();
          return;
        }
        unsubAgent = u;
      })();

      void (async () => {
        const u = await tauriListen<TranscriptPayload>(
          EVENTS.transcriptChanged,
          (payload) => {
            if (disposed || gen !== transcriptGen) return;
            // Ignore transcripts for other sessions (a stale send_message task
            // can emit a transcript for a session that is no longer selected).
            if (
              payload?.sessionId &&
              payload.sessionId !== activeSessionIdRef
            ) {
              return;
            }
            useChatStore.getState().applyTranscript(payload);
          },
        );
        if (disposed || currentSession !== sessionId) {
          u();
          return;
        }
        unsubTranscript = u;
      })();
    };

    setup(useChatStore.getState().activeSessionId);
    const unsubStore = useChatStore.subscribe((state, prev) => {
      if (state.activeSessionId !== prev.activeSessionId) {
        setup(state.activeSessionId);
      }
    });

    return () => {
      disposed = true;
      unsubStore();
      teardown();
    };
  }, []);
}

/** Selector hook shared by every view. Actions are stable store references. */
export function useChat() {
  return useChatStore(
    useShallow((state) => ({
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
      activeSessionCwd: state.activeSessionId
        ? (state.sessions.find((s) => s.id === state.activeSessionId)?.cwd ?? null)
        : null,
      selectSession: state.selectSession,
      createSession: state.createSession,
      deleteSession: state.deleteSession,
      archiveSession: state.archiveSession,
      messages: state.messages,
      sendMessage: state.sendMessage,
      stop: state.stop,
      streaming: state.streaming,
      loading: state.loading,
      queued: state.queued,
    })),
  );
}
