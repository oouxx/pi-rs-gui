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
      const ws = state.workspaces?.[0];
      if (ws) {
        setSessions(
          (ws.sessions ?? [])
            .filter((s: any) => !s.archivedAt)
            .map((s: any) => ({
              id: s.id,
              title: s.title || "Untitled",
              updatedAt: s.updatedAt,
              status: s.status,
            })),
        );
      }
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
        if (t && t.transcript.length > 0) {
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

  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(async () => {
      try {
        const state = await getState();
        const ws = state.workspaces?.[0];
        const session = (ws?.sessions ?? []).find((s: any) => s.id === activeSessionId);
        if (session?.status === "idle") {
          setStreaming(false);
          streamingRef.current = false;
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(interval);
  }, [streaming, activeSessionId]);

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
