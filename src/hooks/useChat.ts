import { useCallback, useEffect, useRef, useState } from "react";

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

interface WorkspaceGroup {
  id: string
  name: string
  path: string
  sessions: SessionItem[]
}

export function useChat() {
  const [workspaces, setWorkspaces] = useState<WorkspaceGroup[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const activeWsIdRef = useRef<string>("");
  const activeSessionIdRef = useRef<string | null>(null);
  const streamingRef = useRef(false);

  // Sync refs (avoid stale closures)
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  const refreshState = useCallback(async () => {
    const api = window.piApp;
    if (!api) return;
    try {
      const state = await api.getState();
      const ws = state.workspaces.find(
        (w) => w.id === state.selectedWorkspaceId,
      );
      if (ws) activeWsIdRef.current = ws.id;
      setWorkspaces(
        state.workspaces
          .map((w: any) => ({
            id: w.id,
            name: w.name || w.path?.split("/").pop() || w.id,
            path: w.path || "",
            sessions: (w.sessions ?? [])
              .filter((s: any) => !s.archivedAt)
              .map((s: any) => ({
                id: s.id,
                title: s.title || "Untitled",
                updatedAt: s.updatedAt,
                status: s.status,
              })),
          }))
          .filter((w: any) => w.sessions.length > 0),
      );
      if (
        state.selectedSessionId &&
        state.selectedSessionId !== activeSessionIdRef.current
      ) {
        setActiveSessionId(state.selectedSessionId);
      }
      setLoading(false);
    } catch {
      /* ignore */
    }
  }, []); // ponytail: stable callback via refs, no deps needed

  // Subscribe to state changes
  useEffect(() => {
    const api = window.piApp;
    if (!api) return;
    const unsub = api.onStateChanged(() => {
      refreshState();
    });
    refreshState();
    return unsub;
  }, [refreshState]);

  // Subscribe to transcript changes when active session changes
  useEffect(() => {
    const api = window.piApp;
    if (!api || !activeSessionId) return;

    // Clear stale messages immediately, then fetch fresh
    setMessages([]);
    api.getSelectedTranscript().then((t) => {
      setMessages(t ? transcriptToDisplay(t.transcript) : []);
    });

    const unsub = api.onSelectedTranscriptChanged((t) => {
      setMessages(t ? transcriptToDisplay(t.transcript) : []);
      // Streaming ends when we get a non-null transcript update with content
      if (t && t.transcript.length > 0) {
        setStreaming(false);
        streamingRef.current = false;
      } else if (t === null) {
        setStreaming(false);
        streamingRef.current = false;
      }
    });
    return unsub;
  }, [activeSessionId]);

  // Poll backend streaming flag while we think we're streaming
  useEffect(() => {
    if (!streaming) return;
    const interval = setInterval(async () => {
      try {
        const api = window.piApp;
        if (!api) return;
        // Try to call the backend streaming check via ping/state
        const state = await api.getState();
        const ws = state.workspaces.find(
          (w) => w.id === state.selectedWorkspaceId,
        );
        const session = (ws?.sessions ?? []).find(
          (s: any) => s.id === activeSessionId,
        );
        if (session?.status === "idle") {
          setStreaming(false);
          streamingRef.current = false;
        }
      } catch {
        /* ignore */
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [streaming, activeSessionId]);

  const sendMessage = useCallback(async (text: string) => {
    const api = window.piApp;
    if (!api || !text.trim() || streamingRef.current) return;

    let wsId = activeWsIdRef.current;
    if (!wsId) {
      const state = await api.getState();
      const ws = state.workspaces.find(
        (w) => w.id === state.selectedWorkspaceId,
      );
      if (!ws) {
        await api.addWorkspacePath("/tmp");
        const newState = await api.getState();
        wsId = newState.workspaces[0]?.id ?? "";
      } else {
        wsId = ws.id;
      }
    }
    if (!wsId) return;

    // Don't pre-create session — submitComposer handles it.
    // Just call submitComposer directly; if no session exists the
    // backend creates one and sets selectedSessionId.
    setStreaming(true);
    streamingRef.current = true;
    try {
      await api.submitComposer(text);
      // After submitComposer returns, wait for the transcript event
      // to set streaming=false.  We set a safety timeout.
      setTimeout(() => {
        if (streamingRef.current) {
          setStreaming(false);
          streamingRef.current = false;
        }
      }, 120_000); // 2 min safety valve
    } catch {
      setStreaming(false);
      streamingRef.current = false;
    }
  }, []);

  const selectSession = useCallback(async (sessionId: string) => {
    const api = window.piApp;
    if (!api || !activeWsIdRef.current) return;
    await api.selectSession({ workspaceId: activeWsIdRef.current, sessionId });
    setActiveSessionId(sessionId);
  }, []);

  const createSession = useCallback(async (title?: string) => {
    const api = window.piApp;
    if (!api) return null as string | null;
    let wsId = activeWsIdRef.current;
    if (!wsId) {
      const state = await api.getState();
      const ws = state.workspaces.find(
        (w) => w.id === state.selectedWorkspaceId,
      );
      if (!ws) {
        await api.addWorkspacePath("/tmp");
        const newState = await api.getState();
        wsId = newState.workspaces[0]?.id ?? "";
      } else {
        wsId = ws.id;
      }
    }
    if (!wsId) return null;
    const newState = await api.createSession({
      workspaceId: wsId,
      title: title || "New thread",
    });
    const newSessionId = newState.selectedSessionId;
    if (newSessionId) setActiveSessionId(newSessionId);
    return newSessionId;
  }, []);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const api = window.piApp;
      if (!api || !activeWsIdRef.current) return;
      const newState = await api.archiveSession({
        workspaceId: activeWsIdRef.current,
        sessionId,
      });
      // Backend may have auto-selected the next session — sync it
      if (newState.selectedSessionId) {
        setActiveSessionId(newState.selectedSessionId);
      }
      refreshState();
    },
    [refreshState],
  );

  const sessions = workspaces.flatMap((w) => w.sessions)

  return {
    workspaces,
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
