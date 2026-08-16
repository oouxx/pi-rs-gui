import { useCallback, useEffect, useRef, useState } from "react";
import {
  getState, submitComposer, getSelectedTranscript,
  cancelCurrentRun,
  selectSession as apiSelectSession,
  createSession as apiCreateSession,
  archiveSession as apiArchiveSession,
  deleteSession as apiDeleteSession,
  renameSession as apiRenameSession,
} from "../api/commands";
import { tauriListen } from "../api/events";

// ── Content block types (mirrors pi-ai ContentBlock) ──────────

export interface ContentBlock {
  type: "text" | "thinking" | "toolCall" | "image";
  text?: string;
  thinking?: string;
  id?: string;          // toolCall.id
  name?: string;        // toolCall.name
  arguments?: any;      // toolCall.arguments
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

export function useChat() {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const activeSessionIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);
  const transcriptGenRef = useRef(0);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

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
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await tauriListen<any>("pi-gui:state-changed", () => refreshState());
    })();
    refreshState();
    return () => { unsub?.(); };
  }, [refreshState]);

  // ── Streaming: listen for agent events ──────────────────────
  useEffect(() => {
    if (!activeSessionId) return;
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await tauriListen<any>("agent-event", (evt: any) => {
        if (evt.session_id !== activeSessionIdRef.current) return;
        const et = evt.event_type;

        if (et === "message_start") {
          // New assistant message with initial content blocks.
          // NOTE: pi-rs also emits MessageStart for user prompts and tool
          // results (agent_loop.rs), so we must only render assistant ones —
          // otherwise the user's input gets echoed as an assistant bubble.
          // User input is added optimistically on send; tool results are
          // merged onto their toolCall block via tool_execution_* events.
          const msg = evt.data?.message;
          if (!msg || msg.role !== "assistant") return;
          const rawBlocks = msg.content;
          const blocks = toBlocks(rawBlocks);
          const text = extractText(rawBlocks);
          const newMsg: DisplayMessage = {
            id: `msg-${Date.now()}`,
            role: "assistant",
            content: text,
            blocks,
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, newMsg]);

        } else if (et === "message_update") {
          // Raw AssistantMessageEvent — partial.content has the complete blocks
          const rawBlocks = evt.data?.partial?.content;
          if (!rawBlocks) return;
          const blocks = toBlocks(rawBlocks);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            // Preserve tool execution state (status/result/isError) from the
            // previous render so partial tool output isn't wiped by deltas.
            const prevToolState = new Map(
              last.blocks
                .filter((b) => b.type === "toolCall" && b.id)
                .map((b) => [
                  b.id,
                  { status: b.status, result: b.result, isError: b.isError },
                ]),
            );
            const merged = blocks.map((b) => {
              if (b.type === "toolCall" && b.id) {
                const st = prevToolState.get(b.id);
                if (st) return { ...b, ...st };
              }
              return b;
            });
            return [
              ...prev.slice(0, -1),
              { ...last, blocks: merged, content: blocksToText(merged) },
            ];
          });

        } else if (et === "message_end") {
          // Finalize the last assistant message.
          // As with message_start, ignore non-assistant messages (user prompts
          // and tool results) — they would otherwise overwrite real content.
          const msg = evt.data?.message;
          if (!msg || msg.role !== "assistant") return;
          const rawBlocks = msg.content;
          if (!rawBlocks) return;
          const blocks = toBlocks(rawBlocks);
          setMessages((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            if (last.role !== "assistant") return prev;
            return [
              ...prev.slice(0, -1),
              { ...last, blocks, content: blocksToText(blocks) },
            ];
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
    })();
    return () => { unsub?.(); };
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

    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await tauriListen<any>("pi-gui:selected-transcript-changed", (t: any) => {
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
    })();
    return () => { unsub?.(); };
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
    // Clear streaming: the old session's transcript event is filtered out by
    // the sessionId check, so nothing else would reset the Stop button.
    setStreaming(false);
    streamingRef.current = false;
    // The transcript effect on [activeSessionId] bumps the generation counter
    // and fetches the transcript — no need to fetch here (a second fetch would
    // always be discarded by the generation check).
  }, []);

  const createSession = useCallback(async (title?: string) => {
    const newState = await apiCreateSession(title);
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

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streamingRef.current) return;

    // Auto-title: rename "New thread" sessions based on the first message
    const currentSid = activeSessionIdRef.current;
    const currentSession = currentSid ? sessions.find((s) => s.id === currentSid) : null;
    if (currentSession && currentSession.title === "New thread" && text.trim()) {
      const autoTitle = text.trim().slice(0, 60);
      apiRenameSession(currentSession.id, autoTitle).catch(() => {});
    }

    // Optimistically add user message
    const userMsg: DisplayMessage = {
      id: `msg-opt-${Date.now()}`,
      role: "user",
      content: text,
      blocks: [{ type: "text", text }],
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    streamingRef.current = true;
    try {
      await submitComposer(text);
      // Safety net matching the backend's 300s add_user_text timeout. The
      // transcript event normally clears streaming when the turn ends.
      setTimeout(() => {
        if (streamingRef.current) {
          setStreaming(false);
          streamingRef.current = false;
        }
      }, 300_000);
    } catch {
      setStreaming(false);
      streamingRef.current = false;
    }
  }, [sessions]);

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
      };
    });
}
