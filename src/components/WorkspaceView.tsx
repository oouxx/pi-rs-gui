import { useState } from "react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Search, Plus, Folder, FolderGit2, GitBranch, Clock } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

const placeholderWorkspaces = [
  { id: "ws-1", name: "pi-gui-rs", path: "/Users/xinxing/Desktop/github/pi-gui-rs", kind: "primary", sessions: 0, lastOpened: "2m ago" },
]

export default function WorkspaceView() {
  const [selectedWs, setSelectedWs] = useState(placeholderWorkspaces[0]?.id ?? null)
  const [search, setSearch] = useState("")

  const active = placeholderWorkspaces.find((w) => w.id === selectedWs)

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="flex-shrink-0" />
        <div className="text-foreground text-sm font-medium">Workspace</div>
      </div>

      {/* Two-panel body */}
      <div className="flex min-h-0 flex-1">
        {/* Left — workspace list */}
        <div className="border-hairline w-56 flex-shrink-0 border-r overflow-y-auto">
          <div className="p-3 pb-0">
            <div className="relative mb-2">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input placeholder="Search workspaces..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-8 pl-8 text-xs" />
            </div>
            <Button size="sm" variant="outline" className="w-full" disabled>
              <Plus className="size-3.5" />
              <span>Add Workspace</span>
            </Button>
          </div>
          <nav className="mt-2 flex flex-col gap-0.5 px-2">
            {placeholderWorkspaces.map((ws) => (
              <button
                key={ws.id}
                onClick={() => setSelectedWs(ws.id)}
                className={`flex items-center gap-2 rounded-md px-3 py-2 text-left transition-colors ${
                  selectedWs === ws.id
                    ? "bg-accent/10 text-accent"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <FolderGit2 className="size-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{ws.name}</div>
                  <div className="truncate text-xs opacity-60">{ws.path}</div>
                </div>
              </button>
            ))}
          </nav>
        </div>

        {/* Right — workspace detail */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          {active ? (
            <div className="mx-auto w-full max-w-2xl px-8 py-8">
              {/* Header */}
              <div className="mb-8 flex items-start gap-4">
                <div className="bg-accent/10 flex size-12 shrink-0 items-center justify-center rounded-lg">
                  <FolderGit2 className="text-accent size-6" />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg font-medium text-foreground">{active.name}</h2>
                  <p className="text-muted-foreground mt-0.5 font-mono text-xs">{active.path}</p>
                  <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Folder className="size-3" />
                      {active.kind}
                    </span>
                    <span className="flex items-center gap-1">
                      <Clock className="size-3" />
                      {active.lastOpened}
                    </span>
                  </div>
                </div>
              </div>

              {/* Sessions section */}
              <section className="mb-8">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-medium text-foreground">Sessions</h3>
                  <Button size="xs" variant="outline" className="h-6" disabled>
                    <Plus className="size-3" />
                    <span>New</span>
                  </Button>
                </div>
                <div className="border-hairline flex items-center justify-center rounded-lg border p-12">
                  <p className="text-muted-foreground text-xs">
                    No sessions in this workspace yet
                  </p>
                </div>
              </section>

              {/* Git section */}
              <section>
                <div className="mb-3 flex items-center gap-2">
                  <GitBranch className="text-muted-foreground size-4" />
                  <h3 className="text-sm font-medium text-foreground">Git</h3>
                </div>
                <div className="border-hairline flex items-center justify-center rounded-lg border p-12">
                  <p className="text-muted-foreground text-xs">
                    Git status — coming soon
                  </p>
                </div>
              </section>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-muted-foreground text-xs">Select a workspace</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
