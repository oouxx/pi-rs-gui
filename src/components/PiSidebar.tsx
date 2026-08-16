import { useCallback, useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Search,
  Settings,
  Puzzle,
  Code2,
  TerminalSquare,
  Plus,
  Trash2,
  Pencil,
  Copy,
  Check,
  FileDown,
  FileJson,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { useChat } from "@/hooks/useChat";
import { exportSession, renameSession } from "@/api/commands";
import type { AppView } from "./AppShell";

interface PiSidebarProps {
  mode: AppView;
  onModeChange: (mode: AppView) => void;
}

export default function PiSidebar({ mode, onModeChange }: PiSidebarProps) {
  const {
    sessions,
    activeSessionId,
    selectSession,
    createSession,
    deleteSession,
    loading,
  } = useChat();
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear any pending copy-feedback timer on unmount.
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  // Cmd/Ctrl+N starts a new thread from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        void createSession().then(() => onModeChange("chat"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [createSession, onModeChange]);

  const matches = (s: { title: string }) =>
    !search.trim() ||
    s.title.toLowerCase().includes(search.trim().toLowerCase());

  const filteredSessions = sessions.filter(matches);

  const handleDelete = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId);
    },
    [deleteSession],
  );

  const commitRename = useCallback(
    (id: string, value: string, original: string) => {
      setRenamingId(null);
      const trimmed = value.trim();
      if (trimmed && trimmed !== original) {
        renameSession(id, trimmed).catch(() => {});
      }
    },
    [],
  );

  const handleStartRename = useCallback((id: string, title: string) => {
    setRenamingId(id);
    setRenameValue(title);
  }, []);

  const handleCopyId = useCallback((id: string) => {
    navigator.clipboard?.writeText(id).catch(() => {});
    setCopiedId(id);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopiedId(null), 1200);
  }, []);

  const handleExport = useCallback(
    async (session: { id: string; title: string }, format: "html" | "jsonl") => {
      const ext = format === "html" ? "html" : "jsonl";
      const base = (session.title || "session")
        .trim()
        .replace(/[^a-zA-Z0-9一-龥._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
      const path = await save({
        title: `Export session (${format.toUpperCase()})`,
        defaultPath: `${base || "session"}.${ext}`,
        filters: [
          {
            name: format === "html" ? "HTML file" : "JSONL file",
            extensions: [ext],
          },
        ],
      });
      if (typeof path !== "string" || !path) return;
      try {
        await exportSession(session.id, format, path);
      } catch (e) {
        console.error(`[export ${format}]`, e);
      }
    },
    [],
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={async () => {
                await createSession();
                onModeChange("chat");
              }}
              tooltip="New thread"
            >
              <Plus />
              <span>New thread</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() =>
                  onModeChange(mode === "terminal" ? "chat" : "terminal")
                }
                isActive={mode === "terminal"}
                tooltip="Terminal"
              >
                <TerminalSquare />
                <span>Terminal</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() =>
                  onModeChange(mode === "skills" ? "chat" : "skills")
                }
                isActive={mode === "skills"}
                tooltip="Skills"
              >
                <Code2 />
                <span>Skills</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() =>
                  onModeChange(mode === "extensions" ? "chat" : "extensions")
                }
                isActive={mode === "extensions"}
                tooltip="Extensions"
              >
                <Puzzle />
                <span>Extensions</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <div className="px-3 py-2 group-data-[collapsible=icon]:hidden">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder="Search sessions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
        </SidebarGroup>
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto">
          <SidebarMenu>
            {loading ? (
              <div className="text-muted-foreground py-8 text-center text-xs">
                Loading...
              </div>
            ) : filteredSessions.length === 0 ? (
              <div className="text-muted-foreground py-8 text-center text-xs">
                {search.trim() ? "No matching sessions" : "No sessions yet"}
              </div>
            ) : (
              filteredSessions.map((s) => (
                <SidebarMenuItem key={s.id} className="group/item">
                  <ContextMenu>
                    <ContextMenuTrigger asChild>
                      <div className="relative flex items-center">
                        {renamingId === s.id ? (
                          <input
                            autoFocus
                            value={renameValue}
                            onFocus={(e) => e.currentTarget.select()}
                            onChange={(e) => setRenameValue(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                commitRename(s.id, renameValue, s.title);
                              }
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setRenamingId(null);
                              }
                            }}
                            onBlur={() =>
                              commitRename(s.id, renameValue, s.title)
                            }
                            onClick={(e) => e.stopPropagation()}
                            className="h-7 flex-1 rounded-sm bg-background px-1 text-sm outline-none ring-1 ring-accent"
                          />
                        ) : (
                          <SidebarMenuButton
                            isActive={activeSessionId === s.id}
                            onClick={() => {
                              onModeChange("chat");
                              selectSession(s.id);
                            }}
                            tooltip={s.title}
                          >
                            <span
                              className={`size-1.5 shrink-0 rounded-full ${activeSessionId === s.id ? "bg-accent" : "bg-muted-foreground"}`}
                            />
                            <span className="flex-1 truncate">{s.title}</span>
                          </SidebarMenuButton>
                        )}
                        <button
                          className="text-muted-foreground hover:text-destructive absolute top-1/2 right-1.5 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover/item:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(s.id);
                          }}
                          title="Delete permanently"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      </div>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem
                        onSelect={() => handleStartRename(s.id, s.title)}
                      >
                        <Pencil className="size-3.5" />
                        Rename
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => handleCopyId(s.id)}>
                        {copiedId === s.id ? (
                          <Check className="size-3.5 text-emerald-500" />
                        ) : (
                          <Copy className="size-3.5" />
                        )}
                        {copiedId === s.id ? "Copied!" : "Copy session ID"}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => handleExport(s, "html")}>
                        <FileDown className="size-3.5" />
                        Export HTML…
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => handleExport(s, "jsonl")}>
                        <FileJson className="size-3.5" />
                        Export JSONL…
                      </ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                </SidebarMenuItem>
              ))
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() =>
                onModeChange(mode === "settings" ? "chat" : "settings")
              }
              isActive={mode === "settings"}
              tooltip="Settings"
            >
              <Settings />
              <span>Settings</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
