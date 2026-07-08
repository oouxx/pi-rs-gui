import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAppMode } from "@/contexts/AppModeContext"
import PiSidebar from "./PiSidebar"
import ChatView from "./ChatView"
import WorkspaceView from "./WorkspaceView"
import SkillsView from "./SkillsView"
import ExtensionsView from "./ExtensionsView"
import SettingsView from "./SettingsView"

export default function AppShell() {
  const { mode } = useAppMode()
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <PiSidebar />
        <SidebarInset className="overflow-hidden">
          {mode === "workspace" ? (
            <WorkspaceView />
          ) : mode === "chat" ? (
            <ChatView />
          ) : mode === "skills" ? (
            <SkillsView />
          ) : mode === "extensions" ? (
            <ExtensionsView />
          ) : mode === "settings" ? (
            <SettingsView />
          ) : (
            <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
              <div className="border-hairline flex items-center gap-2 border-b px-3 py-2">
                <SidebarTrigger />
                <div className="text-muted-foreground text-xs">pi-gui</div>
              </div>
              <div className="flex h-full items-center justify-center text-muted-foreground">
                {mode} view coming soon
              </div>
            </div>
          )}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
