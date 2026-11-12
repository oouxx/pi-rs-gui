import { useEffect, useState } from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ChatProvider } from "@/hooks/ChatProvider"
import PiSidebar from "./PiSidebar"
import ChatView from "./ChatView"
import SkillsView from "./SkillsView"
import ExtensionsView from "./ExtensionsView"
import SettingsView from "./SettingsView"
import { matchesBinding, useKeybindings } from "@/lib/keybindings"

export type AppView = "chat" | "skills" | "extensions" | "settings"

export default function AppShell() {
  const [mode, setMode] = useState<AppView>("chat")
  const { bindings } = useKeybindings()
  // A tab request remounts SettingsView, so `/mcp` can reopen the MCP tab even
  // when Settings was last left on another tab.
  const [settingsTab, setSettingsTab] = useState({ tab: "general", nonce: 0 })
  const openSettings = (tab?: string) => {
    setSettingsTab((prev) => ({
      tab: tab ?? prev.tab,
      nonce: prev.nonce + 1,
    }))
    setMode("settings")
  }
  const views: Record<AppView, React.ReactNode> = {
    chat: <ChatView onOpenSettings={openSettings} />,
    skills: <SkillsView />,
    extensions: <ExtensionsView />,
    settings: (
      <SettingsView key={settingsTab.nonce} initialTab={settingsTab.tab} />
    ),
  }

  // Cmd/Ctrl+, toggles the Settings view from anywhere (customizable).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesBinding(e, bindings.openSettings)) {
        e.preventDefault();
        setMode((m) => (m === "settings" ? "chat" : "settings"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings.openSettings])

  return (
    <TooltipProvider>
      <ChatProvider>
        <SidebarProvider defaultOpen>
          <PiSidebar mode={mode} onModeChange={setMode} />
          <SidebarInset className="overflow-hidden">{views[mode]}</SidebarInset>
        </SidebarProvider>
      </ChatProvider>
    </TooltipProvider>
  )
}
