import { useState } from "react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Search, Plus } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

const extCategories = [
  { id: "all", label: "All Extensions", count: 0 },
  { id: "enabled", label: "Enabled", count: 0 },
  { id: "workspace", label: "Workspace", count: 0 },
  { id: "global", label: "Global", count: 0 },
]

export default function ExtensionsView() {
  const [activeCat, setActiveCat] = useState("all")
  const [search, setSearch] = useState("")

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="flex-shrink-0" />
        <div className="text-foreground text-sm font-medium">Extensions</div>
      </div>

      {/* Two-panel body */}
      <div className="flex min-h-0 flex-1">
        {/* Left — categories */}
        <div className="border-hairline w-48 flex-shrink-0 border-r p-3">
          <nav className="flex flex-col gap-1">
            {extCategories.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCat(cat.id)}
                className={`flex items-center justify-between rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                  activeCat === cat.id
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <span>{cat.label}</span>
                <span className="text-muted-foreground text-xs">{cat.count}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right — content */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="border-hairline flex items-center gap-3 border-b px-4 py-2">
            <div className="relative flex-1 max-w-sm">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder="Search extensions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <Button size="sm" disabled>
              <Plus className="size-3.5" />
              <span>Install Extension</span>
            </Button>
          </div>

          {/* Empty state */}
          <div className="flex flex-1 items-center justify-center">
            <div className="max-w-sm text-center">
              <div className="bg-muted/30 mx-auto mb-4 flex size-16 items-center justify-center rounded-full">
                <svg className="text-muted-foreground size-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <line x1="9" y1="3" x2="9" y2="21" />
                </svg>
              </div>
              <h3 className="mb-1 text-sm font-medium text-foreground">No extensions found</h3>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Extensions add new commands and integrations to pi-gui. Browse the marketplace or add one from a directory.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
