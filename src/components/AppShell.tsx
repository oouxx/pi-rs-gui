import { useEffect, useState } from "react"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import PiSidebar from "./PiSidebar"
import ChatView from "./ChatView"
import SkillsView from "./SkillsView"
import ExtensionsView from "./ExtensionsView"
import SettingsView from "./SettingsView"
import TerminalView from "./TerminalView"

export type AppView = "chat" | "skills" | "extensions" | "terminal" | "settings"

const VIEWS: Record<AppView, React.ReactNode> = {
  chat: <ChatView />,
  skills: <SkillsView />,
  extensions: <ExtensionsView />,
  terminal: <TerminalView />,
  settings: <SettingsView />,
};

export default function AppShell() {
  const [mode, setMode] = useState<AppView>("chat")

  // Cmd/Ctrl+, toggles the Settings view from anywhere.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        setMode((m) => (m === "settings" ? "chat" : "settings"));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [])

  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <PiSidebar mode={mode} onModeChange={setMode} />
        <SidebarInset className="overflow-hidden">{VIEWS[mode]}</SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
