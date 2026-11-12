import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "pi-gui:theme";
const listeners = new Set<() => void>();
const media =
  typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  } catch {
    /* ignore */
  }
  return "system";
}

let current: ThemePreference = readPreference();

export function resolveTheme(pref: ThemePreference = current): ResolvedTheme {
  if (pref === "light" || pref === "dark") return pref;
  return media?.matches ? "dark" : "light";
}

function apply(pref: ThemePreference) {
  if (typeof document === "undefined") return;
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  document.documentElement.style.colorScheme = resolved;
}

/** Apply the stored preference at startup and follow OS theme changes while
 *  the preference is "system". */
export function initTheme() {
  apply(current);
  media?.addEventListener("change", () => {
    if (current !== "system") return;
    apply(current);
    listeners.forEach((listener) => listener());
  });
}

export function setThemePreference(pref: ThemePreference) {
  current = pref;
  try {
    localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    /* ignore */
  }
  apply(pref);
  listeners.forEach((listener) => listener());
}

export function useTheme() {
  const preference = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => current,
    () => current,
  );
  return {
    preference,
    resolved: resolveTheme(preference),
    setTheme: setThemePreference,
  };
}
