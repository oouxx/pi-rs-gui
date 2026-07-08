// src/contexts/AppModeContext.tsx
import { createContext, useContext, useState, type ReactNode } from "react"

export type AppMode = "chat" | "threads" | "skill-editor" | "settings" | "extensions"

interface AppModeContextType {
  mode: AppMode
  setMode: (mode: AppMode) => void
}

const AppModeContext = createContext<AppModeContextType | null>(null)

export function AppModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AppMode>("chat")
  return <AppModeContext.Provider value={{ mode, setMode }}>{children}</AppModeContext.Provider>
}

export function useAppMode(): AppModeContextType {
  const ctx = useContext(AppModeContext)
  if (!ctx) throw new Error("useAppMode must be used within AppModeProvider")
  return ctx
}
