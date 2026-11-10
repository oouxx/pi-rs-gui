import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Search,
  ArrowUp,
  ArrowDown,
  X,
  Info,
  ShieldCheck,
  ShieldX,
  TerminalSquare,
  Loader2,
  Folder,
  GitBranch,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useChatContext } from "@/hooks/ChatProvider";
import { useThreadSearch } from "@/hooks/use-thread-search";
import { useToast } from "@/components/ui/toast";
import PickModel from "@/components/PickModel";
import TerminalDock from "@/components/TerminalDock";
import type { ModelOption, ProviderInfo } from "@/components/PickModel";
import Composer from "@/components/chat/Composer";
import { MessageItem } from "@/components/chat/MessageItem";
import { TimelinePanel } from "@/components/chat/TimelinePanel";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  compactSession,
  exportSession,
  forkSessionAt,
  getProjectTrust,
  importSession,
  reloadSession,
  setProjectTrust,
  getModels,
  getProviders,
  getSessionInfo,
  getSessionModel,
  getSessionTree,
  setSessionModel,
  renameSession,
  setSessionCwd,
  cloneSession,
  shareSession,
  type SessionInfo,
  type SessionTreeNode,
} from "@/api/commands";

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right">{children}</span>
    </div>
  );
}

export default function ChatView({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
}) {
  const {
    messages,
    sessions,
    createSession,
    selectSession,
    sendMessage,
    stop,
    streaming,
    loading,
    activeSessionId,
    activeSessionCwd,
  } = useChatContext();
  const { toast } = useToast();
  const [showTimeline, setShowTimeline] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [timelineTree, setTimelineTree] = useState<SessionTreeNode[]>([]);
  const [modelList, setModelList] = useState<ModelOption[]>([]);
  const [providerList, setProviderList] = useState<ProviderInfo[]>([]);
  const [currentProvider, setCurrentProvider] = useState("");
  const [currentModel, setCurrentModel] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [trustOpen, setTrustOpen] = useState(false);
  const [trustInfo, setTrustInfo] = useState<{
    cwd: string;
    decision: boolean | null;
  } | null>(null);

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const threadSearch = useThreadSearch(timelineRef);

  // ── Header data ────────────────────────────────────────────
  const refreshModelPicker = useCallback(async () => {
    try {
      const [prov, mods, cur] = await Promise.all([
        getProviders(),
        getModels(),
        getSessionModel(),
      ]);
      setProviderList(prov.providers ?? []);
      setModelList(mods.models ?? []);
      setCurrentProvider(cur.provider ?? "");
      setCurrentModel(cur.modelId ?? "");
    } catch (e) {
      console.error("[model picker]", e);
    }
  }, []);

  useEffect(() => {
    refreshModelPicker();
  }, [refreshModelPicker, activeSessionId]);

  const handleModelSelect = useCallback(
    async (provider: string, modelId: string) => {
      setModelOpen(false);
      try {
        await setSessionModel(provider, modelId);
        setCurrentProvider(provider);
        setCurrentModel(modelId);
      } catch (e) {
        console.error("[setSessionModel]", e);
      }
    },
    [],
  );

  const toggleInfo = useCallback(() => {
    setInfoOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (infoOpen && activeSessionId) {
      getSessionInfo(activeSessionId)
        .then((info) => setSessionInfo(info))
        .catch(() => setSessionInfo(null));
    }
  }, [infoOpen, activeSessionId]);

  const toggleTimeline = useCallback(() => {
    setShowTimeline((prev) => !prev);
  }, []);

  useEffect(() => {
    if (showTimeline && activeSessionId) {
      getSessionTree(activeSessionId)
        .then((t) => setTimelineTree(t ?? []))
        .catch(() => setTimelineTree([]));
    }
  }, [showTimeline, activeSessionId]);

  const handleForkAt = useCallback(
    async (entryId: string) => {
      try {
        await forkSessionAt(entryId);
        setShowTimeline(false);
      } catch (e) {
        console.error("[fork]", e);
        toast({
          variant: "error",
          title: "Fork failed",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [toast],
  );

  const exportActiveSession = useCallback(async () => {
    if (!activeSessionId) return false;
    const session = sessions.find((s) => s.id === activeSessionId);
    const title = session?.title || "session";
    const path = await saveDialog({
      title: "Export session",
      defaultPath: `${title}.jsonl`,
      filters: [{ name: "JSONL file", extensions: ["jsonl"] }],
    });
    if (typeof path !== "string" || !path) return false;
    try {
      await exportSession(activeSessionId, "jsonl", path);
    } catch (e) {
      console.error("[export]", e);
      toast({
        variant: "error",
        title: "Export failed",
        description: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }, [activeSessionId, sessions, toast]);

  // Route builtin slash commands to real actions (TS interactive mode does
  // the same; unhandled commands fall through to the LLM as plain text).
  const tryHandleSlash = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text.startsWith("/")) return false;
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ").trim();
      switch (cmd) {
        case "/new":
          await createSession();
          return true;
        case "/name":
          if (arg && activeSessionId) {
            await renameSession(activeSessionId, arg).catch(() => {});
          }
          return true;
        case "/compact":
          await compactSession(arg || undefined).catch((e) => {
            console.error(e);
            toast({
              variant: "error",
              title: "Compact failed",
              description: e instanceof Error ? e.message : String(e),
            });
          });
          return true;
        case "/clone":
          try {
            await cloneSession();
            setShowTimeline(false);
            toast({ variant: "success", title: "Session cloned" });
          } catch (e) {
            toast({
              variant: "error",
              title: "Clone failed",
              description: e instanceof Error ? e.message : String(e),
            });
          }
          return true;
        case "/share":
          try {
            const url = await shareSession();
            navigator.clipboard?.writeText(url).catch(() => {});
            toast({
              variant: "success",
              title: "Session shared",
              description: url,
            });
          } catch (e) {
            toast({
              variant: "error",
              title: "Share failed",
              description: e instanceof Error ? e.message : String(e),
            });
          }
          return true;
        case "/export":
          await exportActiveSession();
          return true;
        case "/copy": {
          const last = [...messages].reverse().find((m) => m.role === "assistant");
          if (last) navigator.clipboard?.writeText(last.content).catch(() => {});
          return true;
        }
        case "/session":
          if (activeSessionId) {
            getSessionInfo(activeSessionId)
              .then((info) => setSessionInfo(info))
              .catch(() => {});
            setInfoOpen(true);
          }
          return true;
        case "/tree":
          setShowTimeline(true);
          if (activeSessionId) {
            getSessionTree(activeSessionId)
              .then((t) => setTimelineTree(t ?? []))
              .catch(() => setTimelineTree([]));
          }
          return true;
        case "/settings":
        case "/hotkeys":
          onOpenSettings?.();
          return true;
        case "/model": {
          if (arg) {
            // /model <provider>/<modelId> — apply the selection directly.
            const [prov, modelId] = arg.split("/");
            if (prov && modelId) {
              try {
                await setSessionModel(prov, modelId);
                setCurrentProvider(prov);
                setCurrentModel(modelId);
              } catch (e) {
                console.error("[setSessionModel]", e);
              }
            } else {
              setModelOpen(true);
            }
          } else {
            setModelOpen(true);
          }
          return true;
        }
        case "/login":
          setModelOpen(true);
          return true;
        case "/fork":
          setShowTimeline(true);
          if (activeSessionId) {
            getSessionTree(activeSessionId)
              .then((t) => setTimelineTree(t ?? []))
              .catch(() => setTimelineTree([]));
          }
          return true;
        case "/import": {
          const selected = await openDialog({
            multiple: false,
            filters: [{ name: "JSONL session", extensions: ["jsonl"] }],
          });
          if (typeof selected === "string" && selected) {
            await importSession(selected).catch((e) => console.error(e));
          }
          return true;
        }
        case "/reload":
          await reloadSession().catch((e) => console.error(e));
          return true;
        case "/logout":
          onOpenSettings?.();
          return true;
        case "/trust": {
          try {
            const info = await getProjectTrust(activeSessionCwd);
            setTrustInfo(info);
            setTrustOpen(true);
          } catch (e) {
            console.error(e);
          }
          return true;
        }
        case "/resume": {
          const q = arg.toLowerCase();
          if (q) {
            const match = sessions.find(
              (s) =>
                s.id.toLowerCase().startsWith(q) ||
                s.title.toLowerCase().includes(q),
            );
            if (match) await selectSession(match.id);
          }
          return true;
        }
        case "/quit":
          try {
            await getCurrentWindow().close();
          } catch {
            /* ignore */
          }
          return true;
        default:
          return false;
      }
    },
    [
      createSession,
      selectSession,
      sessions,
      activeSessionId,
      activeSessionCwd,
      messages,
      onOpenSettings,
      exportActiveSession,
      toast,
    ],
  );

  const handlePickFolder = useCallback(async () => {
    if (!activeSessionId) return;
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string" || !selected) return;
    try {
      await setSessionCwd(activeSessionId, selected);
    } catch (e) {
      console.error("[setSessionCwd]", e);
      toast({
        variant: "error",
        title: "Failed to set working directory",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [activeSessionId, toast]);

  // ── Scrolling ──────────────────────────────────────────────
  // Auto-scroll to the bottom while streaming, unless the user scrolled up.
  // Also resets stick-to-bottom on session switch so the newly loaded
  // transcript lands at the bottom.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stickToBottomRef.current = nearBottom;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeSessionId]);

  // Scroll to the bottom whenever content changes (streaming deltas, or a
  // transcript that finished loading after a session switch) while the user
  // hasn't scrolled up.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = timelineRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const last = el.querySelector('[data-msg-last="true"]');
      if (last instanceof HTMLElement) {
        last.scrollIntoView({ block: "end" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, activeSessionId, streaming]);

  // Belt-and-suspenders: scroll synchronously before paint when a transcript
  // finishes loading (empty → non-empty).
  const prevEmptyRef = useRef(true);
  useLayoutEffect(() => {
    const isEmpty = messages.length === 0;
    if (prevEmptyRef.current && !isEmpty) {
      const el = timelineRef.current;
      if (el) {
        const last = el.querySelector('[data-msg-last="true"]');
        if (last instanceof HTMLElement) {
          last.scrollIntoView({ block: "end" });
        } else {
          el.scrollTop = el.scrollHeight;
        }
      }
    }
    prevEmptyRef.current = isEmpty;
  }, [messages, activeSessionId]);

  // Cmd/Ctrl+F opens in-chat search; Esc closes it (the hook handles cleanup).
  // Cmd/Ctrl+J toggles the terminal dock (Cmd+K is handled by the composer).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        threadSearch.open();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setTerminalOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [threadSearch]);

  const activeTitle =
    sessions.find((s) => s.id === activeSessionId)?.title || "";

  const isEmpty = messages.length === 0;

  return (
    <div className="flex size-full flex-col">
      {/* Header — Codex desktop: minimal, hairline */}
      <div className="border-codex-border bg-codex-bg flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <SidebarTrigger className="shrink-0" />
        <div className="text-codex-faint flex min-w-0 shrink items-center gap-1.5 text-sm whitespace-nowrap">
          <span className="text-codex-text font-medium">
            {activeTitle || "New conversation"}
          </span>
          {streaming && (
            <Loader2 className="text-codex-green size-3.5 shrink-0 animate-spin" />
          )}
          {activeSessionCwd && (
            <span className="text-codex-faint hidden truncate text-xs md:inline">
              · {activeSessionCwd.split("/").filter(Boolean).pop()}
            </span>
          )}
        </div>
        <Popover open={modelOpen} onOpenChange={setModelOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!activeSessionId}
              className="text-codex-faint hover:text-codex-dim inline-flex max-w-[220px] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-colors disabled:opacity-40"
              title="Select model"
            >
              <span className="truncate">
                {currentProvider && currentModel
                  ? `${currentProvider}/${currentModel}`
                  : "select model"}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-2">
            <PickModel
              models={modelList}
              providers={providerList}
              providerId={currentProvider || undefined}
              modelId={currentModel || undefined}
              onSelect={handleModelSelect}
            />
          </PopoverContent>
        </Popover>
        <Popover open={infoOpen} onOpenChange={setInfoOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!activeSessionId}
              onClick={toggleInfo}
              className="text-codex-faint hover:text-codex-dim rounded-md p-1 transition-colors disabled:opacity-40"
              title="Session info"
            >
              <Info className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 p-0">
            {sessionInfo && (
              <div className="flex flex-col gap-2 p-3 text-xs">
                <div className="text-foreground truncate text-sm font-medium">
                  {sessionInfo.title || "Untitled"}
                </div>
                <InfoRow label="Session ID">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground truncate font-mono transition-colors"
                    title="Copy session ID"
                    onClick={() => {
                      navigator.clipboard?.writeText(sessionInfo.id).catch(() => {});
                    }}
                  >
                    {sessionInfo.id}
                  </button>
                </InfoRow>
                {sessionInfo.cwd && (
                  <InfoRow label="Working directory">
                    <span className="text-muted-foreground truncate font-mono">
                      {sessionInfo.cwd}
                    </span>
                  </InfoRow>
                )}
                {sessionInfo.sessionFile && (
                  <InfoRow label="Session file">
                    <span className="text-muted-foreground truncate font-mono">
                      {sessionInfo.sessionFile}
                    </span>
                  </InfoRow>
                )}
                <InfoRow label="Messages">
                  <span className="text-muted-foreground">
                    {sessionInfo.messageCount ?? 0}
                  </span>
                </InfoRow>
                {sessionInfo.model?.provider && sessionInfo.model.modelId && (
                  <InfoRow label="Model">
                    <span className="text-muted-foreground font-mono">
                      {sessionInfo.model.provider}/{sessionInfo.model.modelId}
                    </span>
                  </InfoRow>
                )}
                {sessionInfo.createdAt && (
                  <InfoRow label="Created">
                    <span className="text-muted-foreground">
                      {new Date(sessionInfo.createdAt).toLocaleString()}
                    </span>
                  </InfoRow>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={toggleTimeline}
          disabled={!activeSessionId}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
            showTimeline
              ? "bg-codex-green/10 text-codex-green"
              : "text-codex-faint hover:text-codex-dim"
          }`}
          title="Toggle session timeline"
        >
          <GitBranch className="size-3.5" />
          Timeline
        </button>
      </div>

      {/* Messages or empty state */}
      <div className="bg-codex-bg flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            key={activeSessionId}
            ref={timelineRef}
            className="timeline custom-scroll bg-codex-bg relative flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-6"
          >
            {threadSearch.isOpen && (
              <div className="border-codex-border bg-white absolute top-3 right-3 z-40 flex items-center gap-1.5 rounded-lg border px-2 py-1.5 shadow-lg">
                <Search className="text-codex-faint size-3.5" />
                <input
                  ref={threadSearch.inputRef}
                  value={threadSearch.query}
                  onChange={(e) => threadSearch.search(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      threadSearch.goToMatch(e.shiftKey ? -1 : 1);
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      threadSearch.close();
                    }
                  }}
                  placeholder="Find in chat…"
                  className="text-codex-text h-6 w-40 bg-transparent text-xs outline-none placeholder:text-codex-faint"
                />
                <span className="text-codex-faint min-w-[2.5rem] text-center text-[10px]">
                  {threadSearch.matchCount === 0
                    ? "0/0"
                    : `${threadSearch.activeIndex + 1}/${threadSearch.matchCount}`}
                </span>
                <button
                  type="button"
                  className="text-codex-faint hover:text-codex-dim rounded p-0.5 transition-colors"
                  onClick={() => threadSearch.goToMatch(-1)}
                  title="Previous match (Shift+Enter)"
                >
                  <ArrowUp className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="text-codex-faint hover:text-codex-dim rounded p-0.5 transition-colors"
                  onClick={() => threadSearch.goToMatch(1)}
                  title="Next match (Enter)"
                >
                  <ArrowDown className="size-3.5" />
                </button>
                <button
                  type="button"
                  className="text-codex-faint hover:text-codex-dim rounded p-0.5 transition-colors"
                  onClick={() => threadSearch.close()}
                  title="Close (Esc)"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            )}
            {isEmpty ? (
              <div className="flex flex-1 items-center justify-center">
                <div className="max-w-[560px] px-6 text-center">
                  <div className="mb-5 flex items-center justify-center">
                    <span className="bg-codex-green flex size-10 items-center justify-center rounded-xl text-xl font-bold text-white shadow">
                      p
                    </span>
                  </div>
                  <h1 className="bg-gradient-to-br from-codex-text via-codex-text to-codex-faint bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
                    What can I help you build?
                  </h1>
                  <p className="text-codex-dim mt-3 text-sm leading-relaxed">
                    Ask pi to refactor code, explain a codebase, debug a problem,
                    or carry a task from idea to shipped change — right here in
                    your project.
                  </p>
                </div>
              </div>
            ) : (
              messages.map((msg, idx) => (
                <MessageItem
                  key={msg.id}
                  msg={msg}
                  streaming={streaming}
                  isLast={idx === messages.length - 1}
                />
              ))
            )}
          </div>

          {/* Terminal dock — between the messages and the composer */}
          {terminalOpen && (
            <TerminalDock
              cwd={activeSessionCwd}
              onClose={() => setTerminalOpen(false)}
            />
          )}

          {/* Working directory picker + terminal toggle */}
          <div className="border-codex-border bg-codex-bg flex shrink-0 items-center gap-1 border-t px-4 pt-2">
            <button
              type="button"
              onClick={handlePickFolder}
              disabled={!activeSessionId}
              className="text-codex-faint hover:text-codex-dim inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50"
              title={activeSessionCwd ?? "选择工作目录"}
            >
              <Folder className="size-3.5" />
              <span className="max-w-[260px] truncate">
                {activeSessionCwd
                  ? (activeSessionCwd.split("/").filter(Boolean).pop() ??
                    activeSessionCwd)
                  : "选择工作目录"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setTerminalOpen((o) => !o)}
              className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors ${
                terminalOpen
                  ? "bg-codex-green/10 text-codex-green"
                  : "text-codex-faint hover:text-codex-dim"
              }`}
              title="Toggle terminal panel (⌘J)"
            >
              <TerminalSquare className="size-3.5" />
              Terminal
            </button>
          </div>

          <Composer
            sessionId={activeSessionId}
            cwd={activeSessionCwd}
            loading={loading}
            streaming={streaming}
            onSend={(text, images) => sendMessage(text, images)}
            onStop={stop}
            onSlashCommand={tryHandleSlash}
          />
        </div>

        <Dialog open={trustOpen} onOpenChange={setTrustOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Project trust</DialogTitle>
              <DialogDescription>{trustInfo?.cwd ?? ""}</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground text-xs">
                Current:{" "}
                {trustInfo?.decision === true
                  ? "Trusted"
                  : trustInfo?.decision === false
                    ? "Ignored"
                    : "Not set"}
              </span>
            </div>
            <DialogFooter className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  if (trustInfo) {
                    await setProjectTrust(trustInfo.cwd, true).catch(() => {});
                    setTrustOpen(false);
                  }
                }}
              >
                <ShieldCheck className="size-3.5" />
                Trust
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  if (trustInfo) {
                    await setProjectTrust(trustInfo.cwd, false).catch(() => {});
                    setTrustOpen(false);
                  }
                }}
              >
                <ShieldX className="size-3.5" />
                Ignore
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (trustInfo) {
                    await setProjectTrust(trustInfo.cwd, null).catch(() => {});
                    setTrustOpen(false);
                  }
                }}
              >
                Clear
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {showTimeline && activeSessionId && (
          <TimelinePanel
            tree={timelineTree}
            sessionId={activeSessionId}
            onClose={() => setShowTimeline(false)}
            onTreeChange={setTimelineTree}
            onFork={handleForkAt}
          />
        )}
      </div>
    </div>
  );
}
