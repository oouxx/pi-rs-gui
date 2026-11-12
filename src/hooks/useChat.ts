import { useCallback, useEffect, useRef, useState } from "react";
import {
  getState, submitComposer, getSelectedTranscript,
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
  type ContentBlock,
  type DisplayMessage,
  type StreamDelta,
} from "./message-reducer";
import { useToast } from "../components/ui/toast";

// Re-export so components keep importing message shapes from the hook module.
export type { ContentBlock, DisplayMessage } from "./message-reducer";

interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  cwd?: string | null;
  preview?: string;
}

/** Keep in sync with the backend actor's turn timeout (`actor.rs`). */
const TURN_TIMEOUT_MS = 300_000;

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

export function useChat() {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  // Messages accepted while a turn is running (steer / follow-up). They are
  // delivered by pi-rs and appear in the transcript when the run ends, so the
  // UI only shows them as pending chips.
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const activeSessionIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const transcriptGenRef = useRef(0);
  // Streaming delta batching: accumulate deltas and flush once per rAF so
  // multiple tokens within a frame trigger a single React render.
  const deltaQueueRef = useRef<StreamDelta[]>([]);
  const deltaRafRef = useRef<number | null>(null);
  // Block offset of the current assistant step within its merged message
  // (consecutive steps of a tool-calling run render as one bubble).
  const stepOffsetRef = useRef(0);
  // Track per-session status to detect when a *background* session finishes
  // (running → idle/error) so we can surface a light notification without the
  // user having to switch to it (Codex-style).
  const prevStatusRef = useRef<Record<string, string>>({});

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // Notify when a non-active (background) session finishes its run.
  useEffect(() => {
    const prev = prevStatusRef.current;
    for (const s of sessions) {
      const before = prev[s.id];
      const after = s.status;
      if (before === "running" && after !== "running" && after !== undefined) {
        if (s.id !== activeSessionIdRef.current) {
          const title = after === "error" ? "Session failed" : "Session finished";
          toast({
            title,
            description: s.title || "Untitled",
            variant: after === "error" ? "error" : "default",
          });
          void notifyBackground(title, s.title || "Untitled");
        }
      }
      prev[s.id] = after;
    }
  }, [sessions, toast]);

  // Pending steer/follow-up messages are delivered by the time the run ends.
  useEffect(() => {
    if (!streaming && queued.length > 0) setQueued([]);
  }, [streaming, queued.length]);

  /** Apply a `DesktopState` snapshot (from `get_state` or the change event). */
  const applyState = useCallback((state: DesktopAppState) => {
    setSessions(
      (state.sessions ?? [])
        .filter((s) => !s.archivedAt)
        .map((s) => ({
          id: s.id,
          title: s.title || "Untitled",
          updatedAt: s.updatedAt,
          status: s.status,
          cwd: s.cwd ?? null,
          preview: s.preview ?? "",
        })),
    );
    if (state.selectedSessionId && state.selectedSessionId !== activeSessionIdRef.current) {
      setActiveSessionId(state.selectedSessionId);
    }
    setLoading(false);
  }, []);

  const refreshState = useCallback(async () => {
    try {
      applyState(await getState());
    } catch { /* ignore */ }
  }, [applyState]);

  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | undefined;
    (async () => {
      // The event already carries the full state — use the payload instead of
      // round-tripping through `get_state` on every change.
      const u = await tauriListen<DesktopAppState>(EVENTS.stateChanged, (state) =>
        applyState(state),
      );
      if (disposed) {
        u();
        return;
      }
      unsub = u;
    })();
    refreshState();
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [applyState, refreshState]);

  // ── Streaming: listen for agent events ──────────────────────
  useEffect(() => {
    if (!activeSessionId) return;
    let disposed = false;
    let unsub: (() => void) | undefined;

    const flushDeltas = () => {
      deltaRafRef.current = null;
      const q = deltaQueueRef.current;
      if (q.length === 0) return;
      deltaQueueRef.current = [];
      setMessages((prev) => applyDeltaBatch(prev, q));
    };
    const queueDelta = (event_type: string, data: AgentEventPayload["data"]) => {
      deltaQueueRef.current.push({
        event_type,
        data,
        offset: stepOffsetRef.current,
      });
      if (deltaRafRef.current === null) {
        deltaRafRef.current = requestAnimationFrame(flushDeltas);
      }
    };

    (async () => {
      const u = await tauriListen<AgentEventPayload>(EVENTS.agentEvent, (evt) => {
        if (disposed) return;
        if (evt.session_id !== activeSessionIdRef.current) return;
        const et = evt.event_type;

        if (et === "message_start") {
          // New assistant step. NOTE: pi-rs also emits MessageStart for user
          // prompts and tool results (agent_loop.rs), so we must only render
          // assistant ones — otherwise the user's input gets echoed as an
          // assistant bubble. User input is added optimistically on send;
          // tool results are merged onto their toolCall block via
          // tool_execution_* events.
          const msg = evt.data?.message;
          if (!msg || msg.role !== "assistant") return;
          // A turn is starting for the active session — reflect streaming
          // (covers switching to a background session that is still running).
          setStreaming(true);
          streamingRef.current = true;
          const rawBlocks = msg.content;
          const blocks = toBlocks(rawBlocks);
          const text = extractText(rawBlocks);
          const errorMessage =
            typeof msg.error_message === "string" && msg.error_message
              ? msg.error_message
              : undefined;
          setMessages((prev) => {
            // Consecutive steps of a tool-calling run merge into one bubble
            // (Claude Code style). The reducer records the step's block offset
            // so this step's deltas land at the right index.
            const { messages: next, stepOffset } = appendAssistantStep(
              prev,
              blocks,
              text,
              errorMessage,
            );
            stepOffsetRef.current = stepOffset;
            return next;
          });

        } else if (
          et === "text_delta" ||
          et === "thinking_delta" ||
          et === "toolcall_start" ||
          et === "toolcall_delta" ||
          et === "toolcall_end"
        ) {
          // Streaming deltas: batch into one React render per animation frame.
          queueDelta(et, evt.data);

        } else if (et === "message_done") {
          // Full message at stream end — self-heal. With merged steps, only
          // the current step's blocks (from the recorded offset) are replaced.
          const msg = evt.data?.message;
          if (!msg || msg.role !== "assistant") return;
          const rawBlocks = msg.content;
          if (!rawBlocks) return;
          const blocks = toBlocks(rawBlocks);
          const offset = stepOffsetRef.current;
          const errorMessage =
            typeof msg.error_message === "string" && msg.error_message
              ? msg.error_message
              : undefined;
          setMessages((prev) =>
            replaceAssistantStep(prev, offset, blocks, errorMessage),
          );

        } else if (et === "message_end") {
          // Finalize the current assistant step. As with message_start, ignore
          // non-assistant messages (user prompts and tool results) — they
          // would otherwise overwrite real content. With merged steps, only
          // the current step's blocks (from the recorded offset) are replaced.
          const msg = evt.data?.message;
          if (!msg || msg.role !== "assistant") return;
          const rawBlocks = msg.content;
          if (!rawBlocks) return;
          const blocks = toBlocks(rawBlocks);
          const offset = stepOffsetRef.current;
          const errorMessage =
            typeof msg.error_message === "string" && msg.error_message
              ? msg.error_message
              : undefined;
          setMessages((prev) =>
            replaceAssistantStep(prev, offset, blocks, errorMessage),
          );

        } else if (et === "run_error") {
          // Turn-level failure (timeout / agent-loop error) with no message
          // payload — surface it as an error bubble + toast.
          const errMsg = evt.data?.message;
          const text = errMsg ? String(errMsg) : "Unknown error";
          setStreaming(false);
          streamingRef.current = false;
          setMessages((prev) => [
            ...prev,
            {
              id: `msg-err-${Date.now()}`,
              role: "assistant",
              content: "",
              blocks: [],
              createdAt: new Date().toISOString(),
              errorMessage: text,
            },
          ]);
          toast({
            variant: "error",
            title: "Run failed",
            description: text,
          });

        } else if (et === "tool_execution_start") {
          // Mark a tool call block as running
          const { tool_call_id, tool_name } = evt.data;
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const blocks = last.blocks.map((b) => {
              if (b.type === "toolCall" && (b.id === tool_call_id || b.name === tool_name)) {
                return { ...b, status: "running" as const };
              }
              return b;
            });
            return [...prev.slice(0, -1), { ...last, blocks }];
          });

        } else if (et === "tool_execution_update") {
          // Update partial result for a running tool
          const { tool_call_id } = evt.data;
          const partial = evt.data.partial_result;
          const partialStr = typeof partial === "string" ? partial : JSON.stringify(partial, null, 2);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const blocks = last.blocks.map((b) => {
              if (b.type === "toolCall" && b.id === tool_call_id) {
                return { ...b, result: (b.result ?? "") + partialStr };
              }
              return b;
            });
            return [...prev.slice(0, -1), { ...last, blocks }];
          });

        } else if (et === "tool_execution_end") {
          // Finalize a tool call with result or error
          const { tool_call_id, result, is_error } = evt.data;
          const { text: resultStr, details } = toolResultPayload(result);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const blocks = last.blocks.map((b) => {
              if (b.type === "toolCall" && b.id === tool_call_id) {
                return {
                  ...b,
                  status: is_error ? ("error" as const) : ("success" as const),
                  result: resultStr,
                  isError: !!is_error,
                  details,
                };
              }
              return b;
            });
            return [...prev.slice(0, -1), { ...last, blocks }];
          });

        } else if (et === "turn_end") {
          // Turn complete — transcript event will follow
        }
      });
      if (disposed) {
        u();
        return;
      }
      unsub = u;
    })();
    return () => {
      // Cancel any pending delta batch and drop queued deltas (the transcript
      // reload on session switch supersedes them).
      if (deltaRafRef.current !== null) cancelAnimationFrame(deltaRafRef.current);
      deltaRafRef.current = null;
      deltaQueueRef.current = [];
      disposed = true;
      unsub?.();
    };
  }, [activeSessionId]);

  // ── Transcript events (full transcript after turn completes) ──
  useEffect(() => {
    if (!activeSessionId) return;
    const gen = ++transcriptGenRef.current;
    activeSessionIdRef.current = activeSessionId;
    setMessages([]);
    getSelectedTranscript().then((t) => {
      if (gen === transcriptGenRef.current) {
        setMessages(t ? transcriptToDisplay(t.transcript) : []);
      }
    });

    let disposed = false;
    let unsub: (() => void) | undefined;
    (async () => {
      const u = await tauriListen<TranscriptPayload>(EVENTS.transcriptChanged, (t) => {
        if (disposed) return;
        if (gen !== transcriptGenRef.current) return;
        // Ignore transcripts for other sessions (a stale send_message task can
        // emit a transcript for a session that is no longer selected).
        if (t?.sessionId && t.sessionId !== activeSessionIdRef.current) return;
        // Any transcript event means the turn ended — always clear streaming
        // (also covers aborted runs whose transcript may be empty/partial).
        setMessages(t ? transcriptToDisplay(t.transcript) : []);
        setStreaming(false);
        streamingRef.current = false;
      });
      if (disposed) {
        u();
        return;
      }
      unsub = u;
    })();
    return () => {
      disposed = true;
      unsub?.();
    };
  }, [activeSessionId]);

  const selectSession = useCallback(async (sessionId: string) => {
    // Set the ref BEFORE the await: the backend emits pi-gui:state-changed
    // mid-switch, which makes refreshState() set activeSessionId prematurely
    // and trigger a duplicate transcript fetch whose result selectSession's
    // setMessages([]) can then wipe (and no re-fetch happens).
    const prevRef = activeSessionIdRef.current;
    activeSessionIdRef.current = sessionId;
    try {
      await apiSelectSession(sessionId);
    } catch (e) {
      // Restore the ref so agent-event / transcript filtering matches the
      // still-active session after a failed switch.
      activeSessionIdRef.current = prevRef;
      throw e;
    }
    setActiveSessionId(sessionId);
    setMessages([]);
    // Multi-session: the backend no longer aborts the old session. Derive
    // streaming from the selected session's status (a background session that
    // is still running keeps the Stop button visible).
    try {
      const state = await getState();
      const sess = (state.sessions ?? []).find((s) => s.id === sessionId);
      const running = sess?.status === "running";
      setStreaming(running);
      streamingRef.current = running;
    } catch {
      setStreaming(false);
      streamingRef.current = false;
    }
    // The transcript effect on [activeSessionId] bumps the generation counter
    // and fetches the transcript — no need to fetch here (a second fetch would
    // always be discarded by the generation check).
  }, []);

  const createSession = useCallback(async (title?: string, cwd?: string) => {
    const newState = await apiCreateSession(title, cwd);
    const newId = newState.selectedSessionId;
    if (newId) {
      setActiveSessionId(newId);
      activeSessionIdRef.current = newId;
    }
    setMessages([]);
    setStreaming(false);
    streamingRef.current = false;
    refreshState();
    return newId;
  }, [refreshState]);

  const deleteSession = useCallback(async (sessionId: string) => {
    await apiDeleteSession(sessionId);
    refreshState();
  }, [refreshState]);

  const archiveSession = useCallback(async (sessionId: string) => {
    await apiArchiveSession(sessionId);
    refreshState();
  }, [refreshState]);

  const stop = useCallback(async () => {
    try {
      await cancelCurrentRun();
    } catch {
      /* ignore */
    }
    setStreaming(false);
    streamingRef.current = false;
  }, []);

  const sendMessage = useCallback(
    async (
      text: string,
      attachments?: ComposerImage[],
      streamingBehavior?: StreamingBehavior,
      files?: TextAttachment[],
    ) => {
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
      const wasStreaming = streamingRef.current;
      if (wasStreaming && !streamingBehavior) return;

      // Queue into the running turn. No optimistic user bubble: streaming
      // deltas only ever target the last assistant message, so a user message
      // at the tail would swallow them. The pending chip clears when the run
      // ends and the real message arrives via the transcript event.
      if (wasStreaming && streamingBehavior) {
        setQueued((prev) => [
          ...prev,
          {
            text:
              text.trim() ||
              files?.map((file) => file.name).join(", ") ||
              "(attachment)",
            mode: streamingBehavior,
          },
        ]);
        try {
          await submitComposer(payloadText, attachments, streamingBehavior);
        } catch (e) {
          setQueued((prev) => prev.slice(0, -1));
          toast({
            variant: "error",
            title: "Could not queue message",
            description: e instanceof Error ? e.message : String(e),
          });
        }
        return;
      }

      // Auto-title: rename "New thread" sessions based on the first message
      const currentSid = activeSessionIdRef.current;
      const currentSession = currentSid ? sessions.find((s) => s.id === currentSid) : null;
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

      // Optimistically add user message (text + attachment thumbnails).
      // `payloadText` includes the <attached_files> marker so MessageItem can
      // render compact file chips instead of the inlined content.
      const blocks: ContentBlock[] = [{ type: "text", text: payloadText }];
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
      setMessages((prev) => [...prev, userMsg]);
      setStreaming(true);
      streamingRef.current = true;
      try {
        await submitComposer(payloadText, attachments);
        // Safety net matching the backend's turn timeout. The transcript event
        // normally clears streaming when the turn ends.
        setTimeout(() => {
          if (streamingRef.current) {
            setStreaming(false);
            streamingRef.current = false;
          }
        }, TURN_TIMEOUT_MS);
      } catch (e) {
        setStreaming(false);
        streamingRef.current = false;
        toast({
          variant: "error",
          title: "Send failed",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [sessions, toast],
  );

  const activeSession = sessions.find((s) => s.id === activeSessionId);
  const activeSessionCwd = activeSession?.cwd ?? null;

  return {
    sessions,
    activeSessionId,
    activeSessionCwd,
    selectSession,
    createSession,
    deleteSession,
    archiveSession,
    messages,
    sendMessage,
    stop,
    streaming,
    loading,
    queued,
  };
}
