import { useState } from "react"
import { SidebarTrigger } from "@/components/ui/sidebar"

const settingsTabs = [
  { id: "general", label: "General", desc: "Appearance, language, theme" },
  { id: "models", label: "Models", desc: "AI providers, default model, thinking level" },
  { id: "skills", label: "Skills", desc: "Skill discovery and permissions" },
  { id: "extensions", label: "Extensions", desc: "Extension management" },
  { id: "keybindings", label: "Keybindings", desc: "Keyboard shortcuts" },
  { id: "about", label: "About", desc: "Version, licenses, updates" },
]

export default function SettingsView() {
  const [activeTab, setActiveTab] = useState("general")

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="flex-shrink-0" />
        <div className="text-foreground text-sm font-medium">Settings</div>
      </div>

      {/* Two-panel body */}
      <div className="flex min-h-0 flex-1">
        {/* Left — tabs list */}
        <div className="border-hairline w-56 flex-shrink-0 border-r p-3">
          <nav className="flex flex-col gap-1">
            {settingsTabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors ${
                  activeTab === tab.id
                    ? "bg-accent/10 text-accent"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <span className="text-sm font-medium">{tab.label}</span>
                <span className="text-xs opacity-70">{tab.desc}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right — settings content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-8 py-8">
            <h2 className="mb-1 text-lg font-medium text-foreground">
              {settingsTabs.find((t) => t.id === activeTab)?.label}
            </h2>
            <p className="text-muted-foreground mb-6 text-sm">
              {settingsTabs.find((t) => t.id === activeTab)?.desc}
            </p>

            <div className="border-hairline flex items-center justify-center rounded-lg border p-16">
              <p className="text-muted-foreground text-xs">
                {activeTab} settings — coming soon
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
