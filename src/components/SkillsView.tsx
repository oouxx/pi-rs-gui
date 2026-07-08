import { useState } from "react"
import { SidebarTrigger } from "@/components/ui/sidebar"
import { Search, Plus } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

const skillCategories = [
  { id: "all", label: "All Skills", count: 0 },
  { id: "enabled", label: "Enabled", count: 0 },
  { id: "workspace", label: "Workspace", count: 0 },
  { id: "global", label: "Global", count: 0 },
]

export default function SkillsView() {
  const [activeCat, setActiveCat] = useState("all")
  const [search, setSearch] = useState("")

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="flex-shrink-0" />
        <div className="text-foreground text-sm font-medium">Skills</div>
      </div>

      {/* Two-panel body */}
      <div className="flex min-h-0 flex-1">
        {/* Left — categories */}
        <div className="border-hairline w-48 flex-shrink-0 border-r p-3">
          <nav className="flex flex-col gap-1">
            {skillCategories.map((cat) => (
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
                placeholder="Search skills..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <Button size="sm" disabled>
              <Plus className="size-3.5" />
              <span>Add Skill</span>
            </Button>
          </div>

          {/* Empty state */}
          <div className="flex flex-1 items-center justify-center">
            <div className="max-w-sm text-center">
              <div className="bg-muted/30 mx-auto mb-4 flex size-16 items-center justify-center rounded-full">
                <svg className="text-muted-foreground size-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a7 7 0 0 1 7 7c0 1.5-.5 2.9-1.3 4 .8.6 1.3 1.5 1.3 2.5a3 3 0 0 1-3 3c-.6 0-1.2-.2-1.7-.5A7 7 0 0 1 12 22a7 7 0 0 1-7-7c0-1.5.5-2.9 1.3-4-.8-.6-1.3-1.5-1.3-2.5a3 3 0 0 1 3-3c.6 0 1.2.2 1.7.5A7 7 0 0 1 12 2z" />
                </svg>
              </div>
              <h3 className="mb-1 text-sm font-medium text-foreground">No skills found</h3>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Skills extend pi-gui's capabilities with custom prompts and tools. Create or install a skill to get started.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
