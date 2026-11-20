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
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import {
  Search,
  Settings,
  Code2,
  Plus,
  Trash2,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Loader2,
  Square,
  MessageSquare,
} from "lucide-react";
import { useChatContext } from "@/hooks/ChatProvider";
import { abortSession, searchSessions } from "@/api/commands";
import type { SessionSearchResult } from "@/api/types";
import { matchesBinding, useKeybindings } from "@/lib/keybindings";
import { useI18n } from "@/i18n";
import type { AppView } from "./AppShell";
import { errorText } from "@/lib/errors";

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

function cwdBasename(cwd?: string | null): string {
  if (!cwd) return "";
  return cwd.split("/").filter(Boolean).pop() ?? cwd;
}

// Sort sessions: running ones float to the top (active threads stay
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
  const { bindings } = useKeybindings();
  const { t } = useI18n();
  const {
    sessions,
    activeSessionId,
    selectSession,
    createSession,
    deleteSession,
    loading,
  } = useChatContext();
  const [search, setSearch] = useState("");
  const [contentHits, setContentHits] = useState<SessionSearchResult[]>([]);
  const [searchingContent, setSearchingContent] = useState(false);
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

  // Project/workspace switcher. The currently selected project is
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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setProjectSwitcherOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
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

  // Cmd/Ctrl+N starts a new thread from anywhere (customizable).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesBinding(e, bindings.newThread)) {
        e.preventDefault();
        void createSession(undefined, currentProject ?? undefined)
          .then(() => onModeChange("chat"))
          .catch((e) => {
            toast({
              variant: "error",
              title: t("sidebar.createFailed"),
              description: errorText(e),
            });
          });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    bindings.newThread,
    createSession,
    onModeChange,
    currentProject,
    t,
    toast,
  ]);

  // Filter once: title search + optional project scope. Memoized so the
  // grouping/sorting memos below don't recompute on every render.
  const visibleSessions = useMemo(() => {
    const query = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (currentProject && s.cwd !== currentProject) return false;
      return !query || s.title.toLowerCase().includes(query);
    });
  }, [sessions, search, currentProject]);

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
      const label = s.cwd ? cwdBasename(s.cwd) : t("sidebar.noFolder");
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
      // glanceable after switching away.
      const aRun = a.sessions.some((s) => s.status === "running") ? 0 : 1;
      const bRun = b.sessions.some((s) => s.status === "running") ? 0 : 1;
      if (aRun !== bRun) return aRun - bRun;
      return a.sessions[0].updatedAt < b.sessions[0].updatedAt ? 1 : -1;
    });
    return arr;
  }, [visibleSessions, t]);

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
        label: key ? cwdBasename(key) : t("sidebar.noFolder"),
        path: key,
        count: 0,
        last: s.updatedAt,
      };
      e.count++;
      if (s.updatedAt > e.last) e.last = s.updatedAt;
      map.set(key, e);
    }
    return [...map.values()].sort((a, b) => (a.last < b.last ? 1 : -1));
  }, [sessions, t]);

  const activeProject = currentProject
    ? projects.find((p) => p.path === currentProject) ?? {
        label: cwdBasename(currentProject),
        path: currentProject,
        count: 0,
      }
    : null;

  const handleDelete = useCallback(
    async (session: SessionItem) => {
      try {
        await deleteSession(session.id);
        toast({
          variant: "success",
          title: t("sidebar.deleted"),
          description: session.title,
        });
      } catch (e) {
        toast({
          variant: "error",
          title: t("sidebar.deleteFailed"),
          description: errorText(e),
        });
      }
    },
    [deleteSession, t, toast],
  );

  const handleStop = useCallback(async (sessionId: string) => {
    try {
      await abortSession(sessionId);
    } catch (e) {
      console.error("[abortSession]", e);
      toast({
        variant: "error",
        title: t("sidebar.abortFailed"),
        description: errorText(e),
      });
    }
  }, [t, toast]);

  const renderSessionItem = (s: SessionItem) => (
    <SidebarMenuItem key={s.id} className="group/item">
      <div className="relative flex items-center">
        <SidebarMenuButton
          isActive={activeSessionId === s.id}
          onClick={() => {
            onModeChange("chat");
            // Opening a thread switches the sidebar to that thread's
            // project/workspace.
            setCurrentProject(s.cwd || null);
            selectSession(s.id).catch((e) => {
              console.error("[selectSession]", e);
              toast({
                variant: "error",
                title: t("sidebar.openSessionFailed"),
                description: errorText(e),
              });
            });
          }}
          tooltip={s.title}
          className="text-secondary-foreground hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground h-8 gap-2 rounded-lg px-2 pr-9 text-[13px]"
        >
          <MessageSquare className="text-subtle-foreground hidden group-data-[collapsible=icon]:block" />
          <span className="min-w-0 flex-1 truncate">{s.title}</span>
          {s.status === "running" && (
            <Loader2 className="text-success size-3 shrink-0 animate-spin transition-opacity group-hover/item:opacity-0 group-focus-within/item:opacity-0" />
          )}
        </SidebarMenuButton>
        <div className="group-data-[collapsible=icon]:hidden absolute top-1/2 right-1.5 z-10 flex -translate-y-1/2 items-center gap-0.5">
          {s.status === "running" && (
            <button
              type="button"
              className="text-success hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive rounded-md p-1 opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                handleStop(s.id);
              }}
              title={t("session.stopRunning")} aria-label={t("session.stopRunning")}
            >
              <Square className="size-3 fill-current" />
            </button>
          )}
          <button
            type="button"
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:bg-destructive/10 focus-visible:text-destructive rounded-md p-1 opacity-0 transition-opacity group-hover/item:opacity-100 group-focus-within/item:opacity-100 focus-visible:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              handleDelete(s);
            }}
            title={t("sidebar.deletePermanently")}
            aria-label={t("sidebar.deletePermanently")}
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
    </SidebarMenuItem>
  );

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-1 px-2 pt-2.5 pb-2">
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Brand header */}
            <div className="flex h-8 items-center gap-2 px-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
              <span className="bg-primary font-serif flex size-6 shrink-0 items-center justify-center rounded-lg text-[13px] font-bold text-primary-foreground shadow-xs">
                p
              </span>
              <span className="text-foreground text-[13px] font-semibold tracking-[-0.01em] group-data-[collapsible=icon]:hidden">
                pi
              </span>
            </div>
          </SidebarMenuItem>
          {/* Project/workspace switcher — current project with
              a dropdown to switch between projects / all conversations */}
          <SidebarMenuItem>
            <div
              ref={projectSwitcherRef}
              className="relative group-data-[collapsible=icon]:flex group-data-[collapsible=icon]:justify-center"
            >
              <button
                type="button"
                onClick={() => setProjectSwitcherOpen((o) => !o)}
                className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground flex h-8 w-full items-center gap-2 rounded-lg px-2 text-[13px] transition-colors"
                title={activeProject?.path ?? t("sidebar.allConversations")}
                aria-haspopup="menu"
                aria-expanded={projectSwitcherOpen}
              >
                <FolderOpen className="text-subtle-foreground size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate text-left group-data-[collapsible=icon]:hidden">
                  {activeProject ? activeProject.label : t("sidebar.allConversations")}
                </span>
                <ChevronDown
                  className={`size-3 shrink-0 opacity-60 transition-transform group-data-[collapsible=icon]:hidden ${
                    projectSwitcherOpen ? "rotate-180" : ""
                  }`}
                />
              </button>
              {projectSwitcherOpen && (
                <div
                  role="menu"
                  className="border-hairline bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 max-h-80 w-64 overflow-y-auto rounded-xl border p-1 shadow-md"
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setCurrentProject(null);
                      setProjectSwitcherOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                      !activeProject
                        ? "bg-accent text-accent-foreground font-medium"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    <MessageSquare className="size-3.5 shrink-0" />
                    <span className="flex-1 truncate">{t("sidebar.allConversations")}</span>
                  </button>
                  <div className="bg-border my-1 h-px" />
                  {projects.map((p) => (
                    <button
                      type="button"
                      role="menuitem"
                      key={p.path}
                      onClick={() => {
                        setCurrentProject(p.path || null);
                        setProjectSwitcherOpen(false);
                      }}
                      className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                        activeProject?.path === p.path
                          ? "bg-accent text-accent-foreground font-medium"
                          : "text-muted-foreground hover:bg-muted"
                      }`}
                    >
                      <FolderOpen className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="block truncate">{p.label}</span>
                        <span className="text-subtle-foreground block truncate text-[11px]">
                          {p.path}
                        </span>
                      </span>
                      <span className="text-subtle-foreground shrink-0 text-[11px]">
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
                try {
                  await createSession(undefined, currentProject ?? undefined);
                  onModeChange("chat");
                } catch (e) {
                  toast({
                    variant: "error",
                    title: t("sidebar.createFailed"),
                    description: errorText(e),
                  });
                }
              }}
              tooltip={t("sidebar.newThread")}
              className="text-foreground hover:bg-sidebar-accent h-8 gap-2 rounded-lg px-2 text-[13px] font-medium [&_svg]:size-3.5"
            >
              <span className="bg-primary/10 text-primary flex size-5 shrink-0 items-center justify-center rounded-md">
                <Plus />
              </span>
              <span>{t("sidebar.newThread")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="px-2 py-1">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() =>
                  onModeChange(mode === "skills" ? "chat" : "skills")
                }
                isActive={mode === "skills"}
                tooltip={t("nav.skills")}
                className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground h-8 gap-2 rounded-lg px-2 text-[13px]"
              >
                <Code2 />
                <span>{t("nav.skills")}</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup className="px-2 py-1.5">
          <div className="group-data-[collapsible=icon]:hidden">
            <div className="relative">
              <Search className="text-subtle-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder={t("sidebar.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border-hairline bg-background/70 placeholder:text-subtle-foreground focus-visible:border-ring/50 focus-visible:ring-ring/15 h-8 rounded-lg pl-8 text-[12.5px] focus-visible:ring-2 md:text-[12.5px]"
              />
            </div>
          </div>
        </SidebarGroup>
        {search.trim().length >= 2 && (
          <SidebarGroup className="border-hairline border-t px-2 pt-2 group-data-[collapsible=icon]:hidden">
            <div className="text-subtle-foreground flex items-center gap-1.5 px-2.5 pb-1.5 text-[10px] font-medium tracking-[0.08em] uppercase">
              <MessageSquare className="size-3" />
              {t("sidebar.messages")}
              <span className="ml-auto tabular-nums">
                {searchingContent ? "…" : contentHits.length}
              </span>
            </div>
            {contentHits.length === 0 ? (
              <div className="text-subtle-foreground px-2.5 py-2 text-[11px]">
                {searchingContent ? t("sidebar.searching") : t("sidebar.noMessageMatches")}
              </div>
            ) : (
              <div className="max-h-64 overflow-y-auto">
                {contentHits.map((hit, index) => (
                  <button
                    key={`${hit.sessionId}-${index}`}
                    type="button"
                    onClick={() => {
                      onModeChange("chat");
                      selectSession(hit.sessionId).catch((e) =>
                        toast({
                          variant: "error",
                          title: t("sidebar.openSessionFailed"),
                          description:
                            errorText(e),
                        }),
                      );
                    }}
                    className={`hover:bg-secondary w-full rounded-lg px-2 py-1.5 text-left transition-colors ${
                      hit.sessionId === activeSessionId
                        ? "bg-secondary"
                        : ""
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-[11px]">
                      <span
                        className={
                          hit.role === "user"
                            ? "text-muted-foreground"
                            : "text-primary"
                        }
                      >
                        {hit.role === "user" ? t("sidebar.roleYou") : t("sidebar.roleAI")}
                      </span>
                      <span className="text-subtle-foreground truncate">
                        {hit.title}
                      </span>
                    </div>
                    <div className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                      {hit.snippet}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </SidebarGroup>
        )}
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto px-2">
          {currentProject ? (
            /* Single-project view: flat session list under the project path */
            <div className="flex h-full flex-col">
              <div className="group-data-[collapsible=icon]:hidden px-2.5 pt-1.5 pb-1.5">
                <div
                  className="text-subtle-foreground flex items-center gap-1.5 text-[11px]"
                  title={activeProject?.path}
                >
                  <FolderOpen className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {activeProject?.label}
                  </span>
                  <span className="shrink-0 tabular-nums opacity-70">{projectSessions.length}</span>
                </div>
              </div>
              <SidebarMenu>
                {loading ? (
                  <div className="text-subtle-foreground group-data-[collapsible=icon]:hidden py-10 text-center text-[12px]">
                    {t("common.loading")}
                  </div>
                ) : projectSessions.length === 0 ? (
                  <div className="text-subtle-foreground group-data-[collapsible=icon]:hidden py-10 text-center text-[12px]">
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
                <div className="text-subtle-foreground group-data-[collapsible=icon]:hidden py-10 text-center text-[12px]">
                  {t("common.loading")}
                </div>
              ) : visibleSessions.length === 0 ? (
                <div className="text-subtle-foreground group-data-[collapsible=icon]:hidden py-10 text-center text-[12px]">
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
                      className="mb-1"
                    >
                      <CollapsibleTrigger
                        disabled={!!search.trim()}
                        className="text-subtle-foreground hover:text-foreground group-data-[collapsible=icon]:hidden flex w-full cursor-pointer items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium tracking-[0.02em] select-none disabled:cursor-default"
                        title={g.path}
                      >
                        <ChevronRight
                          className={`size-3 shrink-0 transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
                        />
                        <FolderOpen className="size-3 shrink-0" />
                        <span className="truncate">{g.label}</span>
                        <span className="ml-auto text-[10px] tabular-nums opacity-60">
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
      <SidebarFooter className="px-2 pt-0 pb-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() =>
                onModeChange(mode === "settings" ? "chat" : "settings")
              }
              isActive={mode === "settings"}
              tooltip={t("nav.settings")}
              className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-[active=true]:bg-sidebar-accent data-[active=true]:text-foreground h-8 gap-2 rounded-lg px-2 text-[13px]"
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
