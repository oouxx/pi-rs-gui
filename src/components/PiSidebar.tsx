import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { useToast } from "@/components/ui/toast";
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
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Search,
  Settings,
  Puzzle,
  Code2,
  Plus,
  Trash2,
  Pencil,
  Copy,
  Check,
  FileDown,
  FileJson,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  Square,
  MessageSquare,
  Moon,
  Sun,
  Archive,
} from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { useChatContext } from "@/hooks/ChatProvider";
import { exportSession, renameSession, abortSession, searchSessions } from "@/api/commands";
import type { SessionSearchResult } from "@/api/types";
import { useTheme } from "@/hooks/useTheme";
import { matchesBinding, useKeybindings } from "@/lib/keybindings";
import { useI18n } from "@/i18n";
import type { AppView } from "./AppShell";

interface PiSidebarProps {
  mode: AppView;
  onModeChange: (mode: AppView) => void;
}

interface SessionItem {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  cwd?: string | null;
  preview?: string;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return "";
  const m = Math.floor(diff / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}

function cwdBasename(cwd?: string | null): string {
  if (!cwd) return "";
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

// Sort sessions: running ones float to the top (Codex keeps active threads
// visible), then most-recent-first.
function byRunningThenRecent(a: SessionItem, b: SessionItem): number {
  const aRun = a.status === "running" ? 0 : 1;
  const bRun = b.status === "running" ? 0 : 1;
  if (aRun !== bRun) return aRun - bRun;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

const COLLAPSED_GROUPS_KEY = "pi-gui:collapsed-groups";
const CURRENT_PROJECT_KEY = "pi-gui:current-project";

function loadCollapsedGroups(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_GROUPS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(
      Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [],
    );
  } catch {
    return new Set();
  }
}

export default function PiSidebar({ mode, onModeChange }: PiSidebarProps) {
  const { toast } = useToast();
  const { resolved, setTheme } = useTheme();
  const { bindings } = useKeybindings();
  const { t } = useI18n();
  const {
    sessions,
    activeSessionId,
    selectSession,
    createSession,
    deleteSession,
    archiveSession,
    loading,
  } = useChatContext();
  const [search, setSearch] = useState("");
  const [contentHits, setContentHits] = useState<SessionSearchResult[]>([]);
  const [searchingContent, setSearchingContent] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsedGroups, setCollapsedGroups] =
    useState<Set<string>>(loadCollapsedGroups);
  const prevActiveIdRef = useRef<string | null>(null);

  // Full-text search across message bodies (debounced; titles are filtered
  // locally below, so this only adds the "Messages" results section).
  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) {
      setContentHits([]);
      setSearchingContent(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearchingContent(true);
      try {
        const hits = await searchSessions(query, 30);
        if (!cancelled) setContentHits(hits ?? []);
      } catch {
        if (!cancelled) setContentHits([]);
      } finally {
        if (!cancelled) setSearchingContent(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [search]);

  // Codex-style project/workspace switcher. The currently selected project is
  // a cwd path (""/"null" = "All conversations"). Persisted across reloads.
  const [currentProject, setCurrentProjectState] = useState<string | null>(
    () => {
      try {
        return localStorage.getItem(CURRENT_PROJECT_KEY) || null;
      } catch {
        return null;
      }
    },
  );
  const [projectSwitcherOpen, setProjectSwitcherOpen] = useState(false);
  const projectSwitcherRef = useRef<HTMLDivElement>(null);

  const setCurrentProject = useCallback((key: string | null) => {
    setCurrentProjectState(key);
    try {
      if (key) localStorage.setItem(CURRENT_PROJECT_KEY, key);
      else localStorage.removeItem(CURRENT_PROJECT_KEY);
    } catch {
      /* ignore */
    }
  }, []);

  // Close the project switcher dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!projectSwitcherOpen) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (
        projectSwitcherRef.current &&
        !projectSwitcherRef.current.contains(e.target as Node)
      ) {
        setProjectSwitcherOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [projectSwitcherOpen]);

  // Persist collapsed group state across reloads.
  useEffect(() => {
    try {
      localStorage.setItem(
        COLLAPSED_GROUPS_KEY,
        JSON.stringify([...collapsedGroups]),
      );
    } catch {
      /* ignore */
    }
  }, [collapsedGroups]);

  const setGroupCollapsed = useCallback((key: string, collapsed: boolean) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (collapsed) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  // Auto-expand the group of the newly selected session.
  useEffect(() => {
    const prevId = prevActiveIdRef.current;
    prevActiveIdRef.current = activeSessionId;
    if (!activeSessionId || activeSessionId === prevId) return;
    const active = sessions.find((s) => s.id === activeSessionId);
    if (!active) return;
    const key = active.cwd || "";
    setCollapsedGroups((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }, [activeSessionId, sessions]);

  // Clear any pending copy-feedback timer on unmount.
  useEffect(
    () => () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    },
    [],
  );

  // Cmd/Ctrl+N starts a new thread from anywhere (customizable).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesBinding(e, bindings.newThread)) {
        e.preventDefault();
        void createSession(undefined, currentProject ?? undefined).then(() =>
          onModeChange("chat"),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings.newThread, createSession, onModeChange, currentProject]);

  const matches = (s: { title: string }) =>
    !search.trim() ||
    s.title.toLowerCase().includes(search.trim().toLowerCase());

  const filteredSessions = sessions.filter(matches);

  // When a specific project is selected, show only its sessions.
  const visibleSessions = currentProject
    ? filteredSessions.filter((s) => s.cwd === currentProject)
    : filteredSessions;

  // Flat, most-recent-first list for the single-project view.
  const projectSessions = useMemo(
    () => [...visibleSessions].sort(byRunningThenRecent),
    [visibleSessions],
  );

  // Group sessions by workspace (cwd); groups sorted by most recent session.
  interface SessionGroup {
    key: string;
    label: string;
    path?: string;
    sessions: SessionItem[];
  }
  const groups = useMemo<SessionGroup[]>(() => {
    const map = new Map<string, SessionGroup>();
    for (const s of visibleSessions) {
      const key = s.cwd || "";
      const label = s.cwd ? cwdBasename(s.cwd) : "未设置目录";
      let g = map.get(key);
      if (!g) {
        g = { key, label, path: s.cwd ?? undefined, sessions: [] };
        map.set(key, g);
      }
      g.sessions.push(s);
    }
    const arr = [...map.values()];
    for (const g of arr) {
      g.sessions.sort(byRunningThenRecent);
    }
    arr.sort((a, b) => {
      // Groups with a running session float to the top so in-flight work stays
      // glanceable after switching away (Codex keeps active threads visible).
      const aRun = a.sessions.some((s) => s.status === "running") ? 0 : 1;
      const bRun = b.sessions.some((s) => s.status === "running") ? 0 : 1;
      if (aRun !== bRun) return aRun - bRun;
      return a.sessions[0].updatedAt < b.sessions[0].updatedAt ? 1 : -1;
    });
    return arr;
  }, [visibleSessions]);

  // Project catalog for the switcher (one entry per distinct cwd), sorted by
  // the most recently active session in that project.
  const projects = useMemo(() => {
    const map = new Map<
      string,
      { label: string; path: string; count: number; last: string }
    >();
    for (const s of sessions) {
      const key = s.cwd || "";
      const e = map.get(key) ?? {
        label: key ? cwdBasename(key) : "未设置目录",
        path: key,
        count: 0,
        last: s.updatedAt,
      };
      e.count++;
      if (s.updatedAt > e.last) e.last = s.updatedAt;
      map.set(key, e);
    }
    return [...map.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  }, [sessions]);

  const activeProject = currentProject
    ? projects.find((p) => p.path === currentProject) ?? {
        label: cwdBasename(currentProject),
        path: currentProject,
        count: 0,
      }
    : null;

  const handleDelete = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId);
    },
    [deleteSession],
  );

  const handleStop = useCallback(async (sessionId: string) => {
    try {
      await abortSession(sessionId);
    } catch (e) {
      console.error("[abortSession]", e);
    }
  }, []);

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
    async (session: SessionItem, format: "html" | "jsonl") => {
      const ext = format === "html" ? "html" : "jsonl";
      const base = (session.title || "session")
        .trim()
        .replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]+/g, "-")
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
        toast({
          variant: "error",
          title: "Export failed",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [toast],
  );

  const renderSessionItem = (s: SessionItem) => (
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
                onBlur={() => commitRename(s.id, renameValue, s.title)}
                onClick={(e) => e.stopPropagation()}
                className="h-7 flex-1 rounded-sm bg-background px-1 text-sm outline-none ring-1 ring-accent"
              />
            ) : (
              <SidebarMenuButton
                isActive={activeSessionId === s.id}
                onClick={() => {
                  onModeChange("chat");
                  // Codex behaviour: opening a thread switches the sidebar to
                  // that thread's project/workspace.
                  setCurrentProject(s.cwd || null);
                  selectSession(s.id).catch((e) => {
                    console.error("[selectSession]", e);
                    toast({
                      variant: "error",
                      title: "Failed to open session",
                      description: e instanceof Error ? e.message : String(e),
                    });
                  });
                }}
                tooltip={s.title}
                className="data-[active=true]:bg-codex-panel-2 data-[active=true]:text-codex-text hover:bg-codex-inset hover:text-codex-text"
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${activeSessionId === s.id ? "bg-codex-green" : "bg-codex-faint"}`}
                />
                <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                  <span className="flex w-full min-w-0 items-center gap-1.5">
                    <span className="truncate leading-tight">{s.title}</span>
                    {s.status === "running" && (
                      <Loader2 className="text-codex-green size-3 shrink-0 animate-spin" />
                    )}
                  </span>
                  <span className="text-codex-faint w-full truncate text-[11px] leading-none">
                    {s.preview ? `${s.preview} · ` : ""}
                    {s.cwd ? `${cwdBasename(s.cwd)} · ` : ""}
                    {s.status === "running" ? "Running…" : relativeTime(s.updatedAt)}
                  </span>
                </span>
              </SidebarMenuButton>
            )}
            <div className="absolute top-1/2 right-1.5 z-10 flex -translate-y-1/2 items-center gap-0.5">
              {s.status === "running" && (
                <button
                  className="text-codex-green hover:text-destructive rounded p-1 transition-colors"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleStop(s.id);
                  }}
                  title={t("session.stopRunning")}
                >
                  <Square className="size-3 fill-current" />
                </button>
              )}
              <button
                className="text-muted-foreground hover:text-destructive rounded p-1 opacity-0 transition-opacity group-hover/item:opacity-100"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(s.id);
                }}
                title="Delete permanently"
                style={{ display: renamingId === s.id ? "none" : undefined }}
              >
                <Trash2 className="size-3" />
              </button>
            </div>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {s.status === "running" && (
            <ContextMenuItem onSelect={() => handleStop(s.id)}>
              <Square className="text-codex-green size-3.5 fill-current" />
              {t("session.stopRunning")}
            </ContextMenuItem>
          )}
          <ContextMenuItem onSelect={() => handleStartRename(s.id, s.title)}>
            <Pencil className="size-3.5" />
            {t("session.rename")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleCopyId(s.id)}>
            {copiedId === s.id ? (
              <Check className="size-3.5 text-emerald-500" />
            ) : (
              <Copy className="size-3.5" />
            )}
            {copiedId === s.id ? t("session.copied") : t("session.copyId")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleExport(s, "html")}>
            <FileDown className="size-3.5" />
            {t("session.exportHtml")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => handleExport(s, "jsonl")}>
            <FileJson className="size-3.5" />
            {t("session.exportJsonl")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => archiveSession(s.id)}>
            <Archive className="size-3.5" />
            {t("session.archive")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </SidebarMenuItem>
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Codex-style brand header */}
            <div className="flex items-center gap-2 px-2 py-1 group-data-[collapsible=icon]:justify-center">
              <span className="bg-codex-green flex size-5 shrink-0 items-center justify-center rounded-md text-[11px] font-bold text-white">
                p
              </span>
              <span className="text-codex-text text-sm font-semibold group-data-[collapsible=icon]:hidden">
                pi
              </span>
            </div>
          </SidebarMenuItem>
          {/* Project/workspace switcher — Codex desktop: current project with
              a dropdown to switch between projects / all conversations */}
          <SidebarMenuItem>
            <div
              ref={projectSwitcherRef}
              className="relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center"
            >
              <button
                type="button"
                onClick={() => setProjectSwitcherOpen((o) => !o)}
                className="text-codex-text hover:bg-codex-inset flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-sm transition-colors"
                title={activeProject?.path ?? t("sidebar.allConversations")}
              >
                <FolderOpen className="text-codex-faint size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left group-data-[collapsible=icon]:hidden">
                  {activeProject ? activeProject.label : t("sidebar.allConversations")}
                </span>
                <ChevronDown
                  className={`size-3 shrink-0 transition-transform group-data-[collapsible=icon]:hidden ${
                    projectSwitcherOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
              {projectSwitcherOpen && (
                <div className="border-hairline bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 max-h-80 w-64 overflow-y-auto rounded-lg border p-1 shadow-lg">
                  <button
                    type="button"
                    onClick={() => {
                      setCurrentProject(null);
                      setProjectSwitcherOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                      !activeProject
                        ? "bg-codex-green/10 text-codex-green"
                        : "text-codex-dim hover:bg-codex-inset"
                    }`}
                  >
                    <MessageSquare className="size-3.5 shrink-0" />
                    <span className="flex-1 truncate">{t("sidebar.allConversations")}</span>
                  </button>
                  <div className="bg-border my-1 h-px" />
                  {projects.map((p) => (
                    <button
                      type="button"
                      key={p.path}
                      onClick={() => {
                        setCurrentProject(p.path || null);
                        setProjectSwitcherOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors ${
                        activeProject?.path === p.path
                          ? "bg-codex-green/10 text-codex-green"
                          : "text-codex-dim hover:bg-codex-inset"
                      }`}
                    >
                      <FolderOpen className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="block truncate">{p.label}</span>
                        <span className="text-codex-faint block truncate text-[11px]">
                          {p.path}
                        </span>
                      </span>
                      <span className="text-codex-faint shrink-0 text-[11px]">
                        {p.count}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={async () => {
                // Bind the new conversation to the currently selected project.
                await createSession(undefined, currentProject ?? undefined);
                onModeChange("chat");
              }}
              tooltip="New conversation"
              className="bg-codex-green text-white hover:bg-codex-green-bright data-[active=true]:bg-codex-green data-[active=true]:text-white"
            >
              <Plus />
              <span>{t("sidebar.newThread")}</span>
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
                  onModeChange(mode === "skills" ? "chat" : "skills")
                }
                isActive={mode === "skills"}
                tooltip={t("nav.skills")}
              >
                <Code2 />
                <span>{t("nav.skills")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() =>
                  onModeChange(mode === "extensions" ? "chat" : "extensions")
                }
                isActive={mode === "extensions"}
                tooltip={t("nav.extensions")}
              >
                <Puzzle />
                <span>{t("nav.extensions")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <div className="px-3 py-2 group-data-[collapsible=icon]:hidden">
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder={t("sidebar.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>
        </SidebarGroup>
        {search.trim().length >= 2 && (
          <SidebarGroup className="border-codex-border border-t pt-2 group-data-[collapsible=icon]:hidden">
            <div className="text-codex-faint flex items-center gap-1.5 px-3 pb-1 text-[10px] font-medium tracking-wide uppercase">
              <MessageSquare className="size-3" />
              {t("sidebar.messages")}
              <span className="ml-auto">
                {searchingContent ? "…" : contentHits.length}
              </span>
            </div>
            {contentHits.length === 0 ? (
              <div className="text-codex-faint px-3 py-2 text-[11px]">
                {searchingContent ? t("sidebar.searching") : t("sidebar.noMessageMatches")}
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto px-1">
                {contentHits.map((hit, index) => (
                  <button
                    key={`${hit.sessionId}-${index}`}
                    type="button"
                    onClick={() => selectSession(hit.sessionId)}
                    className={`hover:bg-codex-panel-2 w-full rounded-md px-2 py-1.5 text-left transition-colors ${
                      hit.sessionId === activeSessionId
                        ? "bg-codex-panel-2"
                        : ""
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={
                          hit.role === "user"
                            ? "text-codex-dim"
                            : "text-codex-green"
                        }
                      >
                        {hit.role === "user" ? t("sidebar.roleYou") : t("sidebar.roleAI")}
                      </span>
                      <span className="text-codex-faint truncate">
                        {hit.title}
                      </span>
                    </div>
                    <div className="text-codex-dim mt-0.5 line-clamp-2 text-[11px]">
                      {hit.snippet}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </SidebarGroup>
        )}
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto">
          {currentProject ? (
            /* Single-project view: flat session list under the project path */
            <div className="flex h-full flex-col">
              <div className="px-3 pt-2 pb-1 group-data-[collapsible=icon]:hidden">
                <div
                  className="flex items-center gap-1.5 text-[11px] text-codex-faint"
                  title={activeProject?.path}
                >
                  <FolderOpen className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {activeProject?.label}
                  </span>
                  <span className="shrink-0">{projectSessions.length}</span>
                </div>
              </div>
              <SidebarMenu>
                {loading ? (
                  <div className="text-muted-foreground py-8 text-center text-xs">
                    Loading...
                  </div>
                ) : projectSessions.length === 0 ? (
                  <div className="text-muted-foreground py-8 text-center text-xs">
                    {search.trim()
                      ? t("sidebar.noMatching")
                      : t("sidebar.noProjectSessions")}
                  </div>
                ) : (
                  projectSessions.map(renderSessionItem)
                )}
              </SidebarMenu>
            </div>
          ) : (
            <SidebarMenu>
              {loading ? (
                <div className="text-muted-foreground py-8 text-center text-xs">
                  Loading...
                </div>
              ) : visibleSessions.length === 0 ? (
                <div className="text-muted-foreground py-8 text-center text-xs">
                  {search.trim() ? t("sidebar.noMatching") : t("sidebar.noSessions")}
                </div>
              ) : (
                groups.map((g) => {
                  const isCollapsed =
                    collapsedGroups.has(g.key) && !search.trim();
                  return (
                    <Collapsible
                      key={g.key}
                      open={!isCollapsed}
                      onOpenChange={(open) => setGroupCollapsed(g.key, !open)}
                      className="mb-2"
                    >
                      <CollapsibleTrigger
                        disabled={!!search.trim()}
                        className="text-muted-foreground group-data-[collapsible=icon]:hidden flex w-full cursor-pointer items-center gap-1.5 px-3 py-1 text-[10px] font-medium uppercase tracking-wide select-none hover:text-foreground disabled:cursor-default"
                        title={g.path}
                      >
                        <ChevronRight
                          className={`size-3 shrink-0 transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
                        />
                        <FolderOpen className="size-3 shrink-0" />
                        <span className="truncate">{g.label}</span>
                        <span className="ml-auto text-[10px] opacity-70">
                          {g.sessions.length}
                        </span>
                      </CollapsibleTrigger>
                      <CollapsibleContent className="group-collapsible-content">
                        <SidebarMenu>
                          {g.sessions.map(renderSessionItem)}
                        </SidebarMenu>
                      </CollapsibleContent>
                    </Collapsible>
                  );
                })
              )}
            </SidebarMenu>
          )}
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() =>
                setTheme(resolved === "dark" ? "light" : "dark")
              }
              tooltip={
                resolved === "dark"
                  ? t("nav.switchLight")
                  : t("nav.switchDark")
              }
            >
              {resolved === "dark" ? <Sun /> : <Moon />}
              <span>
                {resolved === "dark" ? t("nav.lightMode") : t("nav.darkMode")}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() =>
                onModeChange(mode === "settings" ? "chat" : "settings")
              }
              isActive={mode === "settings"}
              tooltip={t("nav.settings")}
            >
              <Settings />
              <span>{t("nav.settings")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
