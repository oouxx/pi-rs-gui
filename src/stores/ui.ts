import { create } from "zustand"

interface UiState {
  /** 当前主题: 'dark' | 'light'，默认跟随系统或 localStorage */
  theme: "dark" | "light"
  setTheme: (theme: "dark" | "light") => void
}

export const useUiStore = create<UiState>((set) => ({
  theme:
    (localStorage.getItem("pi-gui-theme") as "dark" | "light") ||
    (window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark"),
  setTheme: (theme) => {
    localStorage.setItem("pi-gui-theme", theme)
    document.documentElement.setAttribute("data-theme", theme)
    set({ theme })
  },
}))
