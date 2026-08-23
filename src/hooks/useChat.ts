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
} from "../api/commands";
import { tauriListen } from "../api/events";
import { useToast } from "../components/ui/toast";

// ── Content block types (mirrors pi-ai ContentBlock) ──────────

export interface ContentBlock {
  type: "text" | "thinking" | "toolCall" | "image";
  text?: string;
  thinking?: string;
  id?: string;          // toolCall.id
  name?: string;        // toolCall.name
  arguments?: any;      // toolCall.arguments
  // Image blocks: raw base64 data + mime type
  data?: string;
  mimeType?: string;
  // Frontend-only: execution state (set by tool_execution_* events)
  status?: "running" | "success" | "error";
  result?: string;
  isError?: boolean;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;       // flattened text (backward compat)
  blocks: ContentBlock[]; // structured content blocks
  createdAt: string;
  errorMessage?: string; // assistant run failure (LLM error, timeout)
}

interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  cwd?: string | null;
  preview?: string;
}

/** Extract text from an assistant message's content blocks. */
function extractText(content: any[]): string {
  return (content ?? [])
    .filter((b: any) => b.type === "text" || b.text)
    .map((b: any) => b.text ?? "")
    .join("");
}

/** Convert raw ContentBlock[] from the backend to our frontend ContentBlock[]. */
function toBlocks(raw: any[] | undefined | null): ContentBlock[] {
  if (!raw) return [];
  return raw.map((b: any) => {
    const block: ContentBlock = { type: b.type ?? "text" };
    if (b.text !== undefined) block.text = b.text;
    if (b.thinking !== undefined) block.thinking = b.thinking;
    if (b.id !== undefined) block.id = b.id;
    if (b.name !== undefined) block.name = b.name;
    if (b.arguments !== undefined) block.arguments = b.arguments;
    if (b.data !== undefined) block.data = b.data;
    if (b.mimeType !== undefined) block.mimeType = b.mimeType;
    // Frontend-only execution state (present in transcript reloads where the
    // backend merges tool results onto toolCall blocks).
    if (b.status !== undefined) block.status = b.status;
    if (b.result !== undefined) block.result = b.result;
    if (b.isError !== undefined) block.isError = b.isError;
    return block;
  });
}

/** Flatten blocks to a single text string. */
function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("");
}

// ── Streaming delta batch application ──────────────────────────
// text/thinking/toolcall deltas are accumulated and applied once per
// animation frame (instead of one React render per token).
interface StreamDelta {
  event_type: string;
  data: any;
  /** Block offset of the assistant step within its merged message. */
  offset?: number;
}

function ensureIndex(blocks: ContentBlock[], idx: number): void {
  while (blocks.length <= idx) {
    blocks.push({ type: "text", text: "" });
  }
}

function applyDelta(prev: DisplayMessage[], d: StreamDelta): DisplayMessage[] {
  if (prev.length === 0) return prev;
  const last = prev[prev.length - 1];
  if (last.role !== "assistant") return prev;
  const { contentIndex, delta } = d.data ?? {};
  // Steps of a tool-calling run are merged into one message; each step's
  // deltas are offset by the block index where the step started.
  const idx = (d.offset ?? 0) + (contentIndex ?? 0);
  const blocks = [...last.blocks];

  switch (d.event_type) {
    case "text_delta": {
      if (typeof delta !== "string" || !delta) return prev;
      ensureIndex(blocks, idx);
      const b = blocks[idx];
      blocks[idx] = { type: "text", text: (b.text ?? "") + delta };
      return [...prev.slice(0, -1), { ...last, blocks, content: blocksToText(blocks) }];
    }
    case "thinking_delta": {
      if (typeof delta !== "string" || !delta) return prev;
      ensureIndex(blocks, idx);
      const b = blocks[idx];
      blocks[idx] = { type: "thinking", thinking: (b.thinking ?? "") + delta };
      return [...prev.slice(0, -1), { ...last, blocks }];
    }
    case "toolcall_start": {
      const src = d.data?.partial?.content?.[contentIndex] ?? {};
      ensureIndex(blocks, idx);
      blocks[idx] = {
        type: "toolCall",
        id: src.id ?? `tc-${idx}`,
        name: src.name ?? "tool",
        arguments: "",
      };
      return [...prev.slice(0, -1), { ...last, blocks }];
    }
    case "toolcall_delta": {
      if (typeof delta !== "string" || !delta) return prev;
      const b = blocks[idx];
      if (!b || b.type !== "toolCall") return prev;
      const prevArgs =
        typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? "");
      blocks[idx] = { ...b, arguments: prevArgs + delta };
      return [...prev.slice(0, -1), { ...last, blocks }];
    }
    case "toolcall_end": {
      const toolCall = d.data?.toolCall;
      if (!toolCall) return prev;
      ensureIndex(blocks, idx);
      blocks[idx] = {
        type: "toolCall",
        id: toolCall.id ?? `tc-${idx}`,
        name: toolCall.name ?? "tool",
        arguments: toolCall.arguments ?? {},
      };
      return [...prev.slice(0, -1), { ...last, blocks }];
    }
    default:
      return prev;
  }
}

function applyDeltaBatch(prev: DisplayMessage[], deltas: StreamDelta[]): DisplayMessage[] {
  let out = prev;
  for (const d of deltas) out = applyDelta(out, d);
  return out;
}

export function useChat() {
  const { toast } = useToast();
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
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
          toast({
            title: after === "error" ? "Session failed" : "Session finished",
            description: s.title || "Untitled",
            variant: after === "error" ? "error" : "default",
          });
        }
      }
      prev[s.id] = after;
    }
  }, [sessions, toast]);

  const refreshState = useCallback(async () => {
    try {
      const state = await getState();
      setSessions(
        (state.sessions ?? [])
          .filter((s: any) => !s.archivedAt)
          .map((s: any) => ({
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
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | undefined;
    (async () => {
      const u = await tauriListen<any>("pi-gui:state-changed", () => refreshState());
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
  }, [refreshState]);

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
    const queueDelta = (event_type: string, data: any) => {
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
      const u = await tauriListen<any>("agent-event", (evt: any) => {
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
            if (prev.length > 0) {
              const last = prev[prev.length - 1];
              if (last.role === "assistant") {
                // Merge: consecutive steps of a tool-calling run render as one
                // bubble (Claude Code style). Record the block offset so this
                // step's deltas land at the right index.
                stepOffsetRef.current = last.blocks.length;
                return [
                  ...prev.slice(0, -1),
                  {
                    ...last,
                    blocks: [...last.blocks, ...blocks],
                    content: last.content + text,
                    errorMessage: errorMessage ?? last.errorMessage,
                  },
                ];
              }
            }
            stepOffsetRef.current = 0;
            const newMsg: DisplayMessage = {
              id: `msg-${Date.now()}`,
              role: "assistant",
              content: text,
              blocks,
              createdAt: new Date().toISOString(),
              errorMessage,
            };
            return [...prev, newMsg];
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
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const merged = [...last.blocks];
            merged.splice(offset, merged.length - offset, ...blocks);
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                blocks: merged,
                content: blocksToText(merged),
                errorMessage: errorMessage ?? last.errorMessage,
              },
            ];
          });

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
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            const merged = [...last.blocks];
            merged.splice(offset, merged.length - offset, ...blocks);
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                blocks: merged,
                content: blocksToText(merged),
                errorMessage: errorMessage ?? last.errorMessage,
              },
            ];
          });

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
          const resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);
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
    getSelectedTranscript().then((t: any) => {
      if (gen === transcriptGenRef.current) {
        setMessages(t ? transcriptToDisplay(t.transcript) : []);
      }
    });

    let disposed = false;
    let unsub: (() => void) | undefined;
    (async () => {
      const u = await tauriListen<any>("pi-gui:selected-transcript-changed", (t: any) => {
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
      const sess = (state.sessions ?? []).find((s: any) => s.id === sessionId);
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
    async (text: string, attachments?: ComposerImage[]) => {
      if ((!text.trim() && (!attachments || attachments.length === 0)) || streamingRef.current)
        return;

      // Auto-title: rename "New thread" sessions based on the first message
      const currentSid = activeSessionIdRef.current;
      const currentSession = currentSid ? sessions.find((s) => s.id === currentSid) : null;
      if (currentSession && currentSession.title === "New thread" && text.trim()) {
        const autoTitle = text.trim().slice(0, 60);
        apiRenameSession(currentSession.id, autoTitle).catch(() => {});
      }

      // Optimistically add user message (text + attachment thumbnails)
      const blocks: ContentBlock[] = [{ type: "text", text }];
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
        content: text,
        blocks,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);
      setStreaming(true);
      streamingRef.current = true;
      try {
        await submitComposer(text, attachments);
        // Safety net matching the backend's 300s add_user_text timeout. The
        // transcript event normally clears streaming when the turn ends.
        setTimeout(() => {
          if (streamingRef.current) {
            setStreaming(false);
            streamingRef.current = false;
          }
        }, 300_000);
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
  };
}

function transcriptToDisplay(transcript: readonly any[]): DisplayMessage[] {
  return transcript
    .filter((t: any) => t.kind === "message" || t.role)
    .map((t: any) => {
      // Prefer structured content blocks from the backend (text/thinking/toolCall
      // with merged tool execution state); fall back to flattened text.
      const rawBlocks = Array.isArray(t.content) ? t.content : null;
      const blocks: ContentBlock[] = rawBlocks && rawBlocks.length > 0
        ? toBlocks(rawBlocks)
        : [{ type: "text" as const, text: t.text ?? "" }];
      return {
        id: t.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
        role: t.role === "user" ? ("user" as const) : ("assistant" as const),
        content: t.text ?? blocksToText(blocks) ?? "",
        blocks,
        createdAt: t.createdAt ?? "",
        errorMessage:
          typeof t.errorMessage === "string" && t.errorMessage
            ? t.errorMessage
            : undefined,
      };
    });
}
