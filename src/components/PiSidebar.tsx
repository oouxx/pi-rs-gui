import { useState } from "react"
import { Input } from "@/components/ui/input"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible"
import { Search, Plus, Settings, Puzzle, Code2, FolderGit2, Trash2, ChevronDown } from "lucide-react"
import { useAppMode } from "@/contexts/AppModeContext"
import { useChat } from "@/hooks/useChat"

export default function PiSidebar() {
  const { mode, setMode } = useAppMode()
  const { workspaces, activeSessionId, selectSession, createSession, deleteSession, loading } = useChat()
  const [search, setSearch] = useState("")
  const [collapsedWs, setCollapsedWs] = useState<Set<string>>(new Set())
  const [collapsedEmptyWs, setCollapsedEmptyWs] = useState<Set<string>>(new Set())

  const toggleWs = (id: string) => {
    setCollapsedWs((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  const toggleEmptyWs = (id: string) => {
    setCollapsedEmptyWs((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }

  const matches = (s: { title: string }) =>
    !search.trim() || s.title.toLowerCase().includes(search.trim().toLowerCase())

  const hasFulltext = (ws: typeof workspaces[number]) =>
    !search.trim() || ws.sessions.some(matches)

  const visibleWs = workspaces.filter(hasFulltext)

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={async () => { await createSession(); setMode("chat"); }} tooltip="New thread">
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
                onClick={() => setMode(mode === "workspace" ? "chat" : "workspace")}
                isActive={mode === "workspace"}
                tooltip="Workspace"
              >
                <FolderGit2 />
                <span>Workspace</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => setMode(mode === "skills" ? "chat" : "skills")}
                isActive={mode === "skills"}
                tooltip="Skills"
              >
                <Code2 />
                <span>Skills</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                onClick={() => setMode(mode === "extensions" ? "chat" : "extensions")}
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
              <Input placeholder="Search sessions..." value={search} onChange={e => setSearch(e.target.value)} className="h-8 pl-8 text-xs" />
            </div>
          </div>
        </SidebarGroup>
        <SidebarGroup className="min-h-0 flex-1 overflow-y-auto">
          <SidebarMenu>
            {loading ? (
              <div className="text-muted-foreground py-8 text-center text-xs">Loading...</div>
            ) : visibleWs.length === 0 ? (
              <div className="text-muted-foreground py-8 text-center text-xs">
                {search.trim() ? "No matching sessions" : "No sessions yet"}
              </div>
            ) : (
              visibleWs.map((ws) => {
                const isCollapsed = collapsedWs.has(ws.id)
                const hasEmptyChildren = ws.sessions.length === 0
                if (hasEmptyChildren && collapsedEmptyWs.has(ws.id)) return null
                return (
                  <Collapsible key={ws.id} defaultOpen asChild>
                    <div className="group-data-[collapsible=icon]:hidden">
                      <CollapsibleTrigger
                        onClick={() => hasEmptyChildren ? toggleEmptyWs(ws.id) : toggleWs(ws.id)}
                        className="text-muted-foreground hover:text-foreground flex w-full items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors"
                      >
                        <ChevronDown className={`size-3 transition-transform ${isCollapsed ? "-rotate-90" : ""}`} />
                        <FolderGit2 className="size-3.5 flex-shrink-0" />
                        <span className="flex-1 truncate text-left">{ws.name}</span>
                        <span className="text-muted-foreground tabular-nums">{ws.sessions.length}</span>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenu>
                          {ws.sessions.filter(matches).map((s) => (
                            <SidebarMenuItem key={s.id} className="group/item pl-3">
                              <SidebarMenuButton
                                isActive={activeSessionId === s.id}
                                onClick={() => { setMode("chat"); selectSession(s.id) }}
                                tooltip={s.title}
                              >
                                <span className={`size-1.5 flex-shrink-0 rounded-full ${activeSessionId === s.id ? "bg-accent" : "bg-muted-foreground"}`} />
                                <span className="flex-1 truncate">{s.title}</span>
                              </SidebarMenuButton>
                              <button
                                className="text-muted-foreground hover:text-destructive absolute top-1/2 right-1.5 z-10 -translate-y-1/2 opacity-0 transition-opacity group-hover/item:opacity-100"
                                onClick={(e) => { e.stopPropagation(); deleteSession(s.id) }}
                                title="Delete"
                              >
                                <Trash2 className="size-3" />
                              </button>
                            </SidebarMenuItem>
                          ))}
                        </SidebarMenu>
                      </CollapsibleContent>
                    </div>
                  </Collapsible>
                )
              })
            )}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={() => setMode(mode === "settings" ? "chat" : "settings")}
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
  )
}
