import { create } from "zustand"

interface ThreadStoreState {
  activeSessionId: number | null
  setActiveSessionId: (id: number | null) => void
}

export const useThreadStore = create<ThreadStoreState>((set) => ({
  activeSessionId: (() => {
    try {
      const v = localStorage.getItem("pi-gui-active-session")
      return v ? Number(v) : null
    } catch {
      return null
    }
  })(),

  setActiveSessionId: (id) => {
    if (id !== null) localStorage.setItem("pi-gui-active-session", String(id))
    else localStorage.removeItem("pi-gui-active-session")
    set({ activeSessionId: id })
  },
}))
