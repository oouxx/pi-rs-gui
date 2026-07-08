import { useState } from "react"
import { Input } from "@/components/ui/input"
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup,
  SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Search, Plus, Settings, Puzzle, Code2, FolderGit2 } from "lucide-react"
import { useAppMode } from "@/contexts/AppModeContext"
import { useChat } from "@/hooks/useChat"

export default function PiSidebar() {
  const { mode, setMode } = useAppMode()
  const { sessions, activeSessionId, selectSession, loading } = useChat()
  const [search, setSearch] = useState("")

  const filtered = search.trim()
    ? sessions.filter((s) => s.title.toLowerCase().includes(search.trim().toLowerCase()))
    : sessions

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => setMode("chat")} tooltip="New thread">
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
        <SidebarGroup className="min-h-0 flex-1">
          <SidebarMenu>
            {loading ? (
              <div className="text-muted-foreground py-8 text-center text-xs group-data-[collapsible=icon]:hidden">
                Loading...
              </div>
            ) : filtered.length === 0 ? (
              <div className="text-muted-foreground py-8 text-center text-xs group-data-[collapsible=icon]:hidden">
                {search.trim() ? "No matching sessions" : "No sessions yet"}
              </div>
            ) : (
              filtered.map((s) => (
                <SidebarMenuItem key={s.id}>
                  <SidebarMenuButton
                    isActive={activeSessionId === s.id}
                    onClick={() => {
                      setMode("chat")
                      selectSession(s.id)
                    }}
                    tooltip={s.title}
                  >
                    <span
                      className={`size-1.5 flex-shrink-0 rounded-full ${activeSessionId === s.id ? "bg-accent" : "bg-muted-foreground"}`}
                    />
                    <span className="flex-1 truncate">{s.title}</span>
                  </SidebarMenuButton>
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
