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
  deleteSession as apiDeleteSession,
  renameSession as apiRenameSession,
  type ComposerFile,
  type ComposerImage,
  type DesktopAppState,
  type QueuedMessage,
  type StreamingBehavior,
} from "../api/commands";
import { tauriListen } from "../api/events";
import { EVENTS } from "../api/eventNames";
import { baseName } from "../lib/attachments";
import { queuedFromQueueUpdate, removeQueuedChip } from "../lib/queue";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import type { AgentEventPayload, TranscriptPayload } from "../api/types";
import {
  appendAssistantStep,
  applyDeltaBatch,
  applyToolExecution,
  deliverQueuedUserMessage,
  extractText,
  replaceAssistantStep,
  toBlocks,
  transcriptToDisplay,
  type DisplayMessage,
  type StreamDelta,
} from "../hooks/message-reducer";
import { showToast } from "../components/ui/toast";
import { t } from "../i18n";
import { parseError } from "../lib/errors";
import { toolResultPayload } from "../lib/tool-result";

export interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  cwd?: string | null;
  preview?: string;
}

// ── Module-scoped mutable state ─────────────────────────────────
// Event listeners and delta batching must not live in React state: the store
// is a singleton, and these counters/queues change far more often than the UI
// should re-render.
let activeSessionIdRef: string | null = null;
let streamingRef = false;
let transcriptGen = 0;
// True between selecting a session and its transcript arriving. The previous
// transcript stays on screen meanwhile, so new-session events are held back
// until the snapshot replaces it.
let switchingRef = false;
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
  return parseError(error).message;
}

/** Terminal state of a streamed assistant message: a user stop is not a
 *  failure, so it never becomes an error bubble. */
function terminalFlags(msg: { errorMessage?: unknown; stopReason?: unknown } | undefined): {
  errorMessage?: string;
  interrupted?: boolean;
} {
  const interrupted = msg?.stopReason === "aborted";
  const errorMessage =
    !interrupted && typeof msg?.errorMessage === "string" && msg.errorMessage
      ? msg.errorMessage
      : undefined;
  return { errorMessage, interrupted };
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
  stop(): Promise<void>;
  sendMessage(
    text: string,
    attachments?: ComposerImage[],
    streamingBehavior?: StreamingBehavior,
    files?: ComposerFile[],
  ): Promise<boolean>;

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
    switchingRef = true;
    try {
      await apiSelectSession(sessionId);
    } catch (error) {
      activeSessionIdRef = prevRef;
      switchingRef = false;
      throw error;
    }
    // Keep the previous transcript until the new one arrives (applyTranscript
    // or the initial fetch clears the flag).
    set({ activeSessionId: sessionId });
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
    switchingRef = false;
    streamingRef = false;
    set({ messages: [], streaming: false });
    void get().refreshState();
    return newId;
  },

  async deleteSession(sessionId) {
    await apiDeleteSession(sessionId);
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
    // Attachment references are assembled in the backend (it owns path
    // resolution, spooling and the prompt wrapper), so the prompt text here is
    // exactly what the user typed.
    const payloadText = text;
    const hasContent =
      !!text.trim() ||
      (attachments != null && attachments.length > 0) ||
      (files != null && files.length > 0);
    if (!hasContent) return false;
    const wasStreaming = streamingRef;
    if (wasStreaming && !streamingBehavior) return false;

    // Queue into the running turn. No optimistic user bubble: streaming deltas
    // only ever target the last assistant message, so a user message at the
    // tail would swallow them. The chip is optimistic only for latency: pi-rs
    // echoes its real queue back as `queue_update`, which replaces this list.
    if (wasStreaming && streamingBehavior) {
      const chip: QueuedMessage = {
        text:
          text.trim() ||
          files?.map((file) => file.name).join(", ") ||
          "(attachment)",
        mode: streamingBehavior,
      };
      set((state) => ({ queued: [...state.queued, chip] }));
      try {
        await submitComposer(payloadText, attachments, streamingBehavior, files);
      } catch (error) {
        // Drop only this chip: a `queue_update` may already have replaced the
        // list, in which case the reference is gone and this is a no-op.
        set((state) => ({ queued: state.queued.filter((q) => q !== chip) }));
        showToast({
          variant: "error",
          title: "Could not queue message",
          description: errorText(error),
        });
        return false;
      }
      return true;
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

    // Optimistically add the user message: typed text, image thumbnails and a
    // chip per referenced file. Path-based images have no bytes in the webview,
    // so they show up as file chips until the transcript reloads.
    const blocks: DisplayMessage["blocks"] = [{ type: "text", text: payloadText }];
    for (const image of attachments ?? []) {
      if (!image.data) continue;
      blocks.push({
        type: "image",
        data: image.data,
        mimeType: image.mimeType,
      });
    }
    const userMsg: DisplayMessage = {
      id: `msg-opt-${Date.now()}`,
      role: "user",
      content: payloadText,
      blocks,
      attachments: [
        // Images handed over by path have no bytes here, so they can only be
        // shown as a chip until the transcript reloads with the real block.
        ...(attachments ?? [])
          .filter((image) => !image.data)
          .map((image) => ({
            name: image.name ?? baseName(image.path ?? ""),
            inlined: false,
          })),
        ...(files ?? []).map((file) => ({
          name: file.path ? baseName(file.path) : file.name,
          inlined: false,
        })),
      ],
      createdAt: new Date().toISOString(),
    };
    set((state) => ({ messages: [...state.messages, userMsg] }));
    streamingRef = true;
    set({ streaming: true });
    try {
      await submitComposer(payloadText, attachments, undefined, files);
      return true;
    } catch (error) {
      streamingRef = false;
      set({ streaming: false });
      // The prompt never reached the agent (e.g. an image the provider cannot
      // accept): drop the optimistic bubble and hand the failure back to the
      // composer so the draft and its attachments are restored.
      set((state) => ({
        messages: state.messages.filter((m) => m.id !== userMsg.id),
      }));
      showToast({
        variant: "error",
        title: "Send failed",
        description: errorText(error),
      });
      return false;
    }
  },

  handleAgentEvent(evt) {
    if (evt.session_id !== activeSessionIdRef) return;
    if (switchingRef) return;
    const et = evt.event_type;

    if (et === "queue_update") {
      // pi-rs owns the queue: mirror it rather than tracking what we sent.
      // Chips now clear exactly when the agent drains a message (a turn
      // boundary for steer, settle for follow-up) instead of whenever the
      // frontend briefly thinks the run ended.
      set({ queued: queuedFromQueueUpdate(evt.data) });
      return;
    }

    if (et === "queue_error") {
      // The running turn refused the message (e.g. a manual compaction is in
      // flight): it never entered pi-rs's queue, so drop its chip and tell the
      // user. The run itself keeps going — the backend does not abort it.
      const text = typeof evt.data?.text === "string" ? evt.data.text : undefined;
      const message = evt.data?.message ? String(evt.data.message) : "Unknown error";
      set((state) => ({ queued: removeQueuedChip(state.queued, text) }));
      showToast({
        variant: "error",
        title: t("composer.queueFailed"),
        description: t("composer.queueFailedHint", { message }),
      });
      return;
    }

    if (et === "message_start") {
      const msg = evt.data?.message;
      if (!msg) return;
      // pi-rs also emits MessageStart for user prompts and tool results. A user
      // message here is a queued steer/follow-up coming out of pi-rs's queue at
      // the boundary where it is actually inserted — render it there (the
      // caller's own prompt is skipped: it has an optimistic bubble and no
      // chip).
      if (msg.role !== "assistant") {
        if (msg.role !== "user") return;
        const rawBlocks = msg.content;
        const text = extractText(rawBlocks);
        set((state) => {
          const delivered = deliverQueuedUserMessage(
            state.messages,
            state.queued,
            text,
            toBlocks(rawBlocks),
          );
          return delivered ?? {};
        });
        return;
      }
      streamingRef = true;
      set({ streaming: true });
      const rawBlocks = msg.content;
      const blocks = toBlocks(rawBlocks);
      const text = extractText(rawBlocks);
      const { errorMessage, interrupted } = terminalFlags(msg);
      set((state) => {
        // Consecutive steps of a tool-calling run merge into one bubble. The
        // reducer records the step's block offset for this step's deltas.
        const { messages, stepOffset: offset } = appendAssistantStep(
          state.messages,
          blocks,
          text,
          errorMessage,
          interrupted,
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
      const { errorMessage, interrupted } = terminalFlags(msg);
      set((state) => ({
        messages: replaceAssistantStep(
          state.messages,
          stepOffset,
          blocks,
          errorMessage,
          interrupted,
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
      set((state) => ({
        messages: applyToolExecution(state.messages, {
          phase: "start",
          id: tool_call_id,
          name: tool_name,
        }),
      }));
      return;
    }

    if (et === "tool_execution_update") {
      const { tool_call_id, tool_name } = evt.data;
      const partial = evt.data.partial_result;
      set((state) => ({
        messages: applyToolExecution(state.messages, {
          phase: "update",
          id: tool_call_id,
          name: tool_name,
          appendResult:
            typeof partial === "string"
              ? partial
              : JSON.stringify(partial, null, 2),
        }),
      }));
      return;
    }

    if (et === "tool_execution_end") {
      const { tool_call_id, tool_name, result, is_error } = evt.data;
      const { text: resultStr, details, images } = toolResultPayload(result);
      set((state) => ({
        messages: applyToolExecution(state.messages, {
          phase: "end",
          id: tool_call_id,
          name: tool_name,
          result: resultStr,
          isError: !!is_error,
          details,
          images,
        }),
      }));
    }
  },

  applyTranscript(payload) {
    switchingRef = false;
    streamingRef = false;
    // The replaced list has no relation to the streamed one: drop batched
    // deltas (they carry pre-replace offsets and would write into the wrong
    // blocks) and restart step accounting.
    dropQueuedDeltas();
    stepOffset = 0;
    const messages = payload ? transcriptToDisplay(payload.transcript) : [];
    // A failed turn's error bubble is not part of the agent transcript: the
    // `run_error` event adds it, and this transcript replace used to wipe it,
    // leaving only endless "等待" tool cards. The backend now ships the error
    // on the payload so it survives the replace.
    const runError = payload?.runError;
    if (runError) {
      messages.push({
        id: `msg-err-${payload?.sessionId ?? "run"}`,
        role: "assistant",
        content: "",
        blocks: [],
        createdAt: new Date().toISOString(),
        errorMessage: runError,
      });
    }
    set({ messages, streaming: false });
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
      // `queue_update` is the source of truth while a run is alive; this is
      // only the fallback for a queue pi-rs never reported (e.g. it was
      // dropped with the run before the final drain event arrived).
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
      if (!sessionId) {
        switchingRef = false;
        useChatStore.setState({ messages: [] });
        return;
      }
      const gen = ++transcriptGen;

      void getSelectedTranscript()
        .then((transcript) => {
          if (disposed || gen !== transcriptGen) return;
          useChatStore.setState({
            messages: transcript ? transcriptToDisplay(transcript.transcript) : [],
          });
          switchingRef = false;
        })
        .catch(() => {
          if (disposed || gen !== transcriptGen) return;
          switchingRef = false;
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
      messages: state.messages,
      sendMessage: state.sendMessage,
      stop: state.stop,
      streaming: state.streaming,
      loading: state.loading,
      queued: state.queued,
    })),
  );
}
