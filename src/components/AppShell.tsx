import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar"
import { TooltipProvider } from "@/components/ui/tooltip"
import { useAppMode } from "@/contexts/AppModeContext"
import ConversationSidebar from "./ConversationSidebar"

export default function AppShell() {
  const { mode } = useAppMode()
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <ConversationSidebar />
        <SidebarInset className="overflow-hidden">
          <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
            <div className="border-hairline flex items-center gap-2 border-b px-3 py-2">
              <SidebarTrigger />
              <div className="text-muted-foreground text-xs">pi-gui</div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {mode === "chat" ? (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  Chat view coming soon
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  {mode} view coming soon
                </div>
              )}
            </div>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  )
}
