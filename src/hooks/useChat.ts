import { useCallback, useEffect, useRef, useState } from "react";
import {
  getState, submitComposer, getSelectedTranscript,
  selectSession as apiSelectSession,
  createSession as apiCreateSession,
  archiveSession as apiArchiveSession,
  renameSession as apiRenameSession,
} from "../api/commands";
import { tauriListen } from "../api/events";

interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
}

interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
}

/** Extract text from an assistant message's content blocks. */
function extractText(content: any[]): string {
  return (content ?? [])
    .filter((b: any) => b.type === "text" || b.text)
    .map((b: any) => b.text ?? "")
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
        // Only process events for the current session
        if (evt.session_id !== activeSessionIdRef.current) return;
        const et = evt.event_type;

        if (et === "message_start") {
          // Add a new empty assistant message
          const partial = evt.data?.message;
          const text = partial ? extractText(partial.content) : "";
          const newMsg: DisplayMessage = {
            id: `msg-str-${Date.now()}`,
            role: "assistant",
            content: text,
            createdAt: new Date().toISOString(),
          };
          setMessages((prev) => [...prev, newMsg]);
        } else if (et === "message_update") {
          // Update the last assistant message with partial content
          const data = evt.data;
          const partial = data?.partial;
          if (partial) {
            const text = extractText(partial.content);
            setMessages((prev) => {
              if (prev.length === 0) return prev;
              const last = prev[prev.length - 1];
              if (last.role !== "assistant") return prev;
              return [...prev.slice(0, -1), { ...last, content: text }];
            });
          }
        } else if (et === "message_end") {
          // Finalize the last assistant message
          const partial = evt.data?.message;
          if (partial) {
            const text = extractText(partial.content);
            setMessages((prev) => {
              if (prev.length === 0) return prev;
              const last = prev[prev.length - 1];
              if (last.role !== "assistant") return prev;
              return [...prev.slice(0, -1), { ...last, content: text }];
            });
          }
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
        setMessages(t ? transcriptToDisplay(t.transcript) : []);
        if (t && t.transcript.some((m: any) => m.role === "assistant")) {
          setStreaming(false);
          streamingRef.current = false;
        } else if (t === null) {
          setStreaming(false);
          streamingRef.current = false;
        }
      });
    })();
    return () => { unsub?.(); };
  }, [activeSessionId]);

  const selectSession = useCallback(async (sessionId: string) => {
    await apiSelectSession(sessionId);
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
    setMessages([]);
    const gen = ++transcriptGenRef.current;
    getSelectedTranscript().then((t: any) => {
      if (gen === transcriptGenRef.current) {
        setMessages(t ? transcriptToDisplay(t.transcript) : []);
      }
    });
  }, []);

  const createSession = useCallback(async (title?: string) => {
    const newState = await apiCreateSession(title);
    const newId = newState.selectedSessionId;
    if (newId) {
      setActiveSessionId(newId);
      activeSessionIdRef.current = newId;
    }
    setMessages([]);
    refreshState();
    return newId;
  }, [refreshState]);

  const deleteSession = useCallback(async (sessionId: string) => {
    await apiArchiveSession(sessionId);
    refreshState();
  }, [refreshState]);

  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || streamingRef.current) return;
    // Optimistically add user message
    const userMsg: DisplayMessage = {
      id: `msg-opt-${Date.now()}`,
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    streamingRef.current = true;
    try {
      await submitComposer(text);
      setTimeout(() => {
        if (streamingRef.current) {
          setStreaming(false);
          streamingRef.current = false;
        }
      }, 120_000);
    } catch {
      setStreaming(false);
      streamingRef.current = false;
    }
  }, []);

  return {
    sessions,
    activeSessionId,
    selectSession,
    createSession,
    deleteSession,
    messages,
    sendMessage,
    streaming,
    loading,
  };
}

function transcriptToDisplay(transcript: readonly any[]): DisplayMessage[] {
  return transcript
    .filter((t: any) => t.kind === "message" || (t.role && t.text))
    .map((t: any) => ({
      id: t.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
      role: t.role === "user" ? ("user" as const) : ("assistant" as const),
      content: t.text ?? t.content ?? "",
      createdAt: t.createdAt ?? "",
    }));
}
