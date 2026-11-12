import { useSyncExternalStore } from "react";

export interface KeybindingDefinition {
  id: string;
  label: string;
  /** Canonical form, e.g. `Mod+N`, `Mod+Shift+P`, `Mod+,`. */
  defaultBinding: string;
}

/** Customizable shortcuts. Mod = Cmd on macOS, Ctrl elsewhere. */
export const KEYBINDING_DEFINITIONS: KeybindingDefinition[] = [
  { id: "newThread", label: "Start a new thread", defaultBinding: "Mod+N" },
  { id: "focusComposer", label: "Focus the composer", defaultBinding: "Mod+K" },
  { id: "openSettings", label: "Open / close Settings", defaultBinding: "Mod+," },
  { id: "findInChat", label: "Find in chat", defaultBinding: "Mod+F" },
  { id: "toggleTerminal", label: "Toggle the terminal panel", defaultBinding: "Mod+J" },
  { id: "cycleModel", label: "Cycle scoped models", defaultBinding: "Mod+P" },
  {
    id: "cycleModelBackward",
    label: "Cycle scoped models backward",
    defaultBinding: "Mod+Shift+P",
  },
];

export type KeybindingMap = Record<string, string>;

const STORAGE_KEY = "pi-gui:keybindings";
const listeners = new Set<() => void>();

function defaults(): KeybindingMap {
  return Object.fromEntries(
    KEYBINDING_DEFINITIONS.map((item) => [item.id, item.defaultBinding]),
  );
}

function load(): KeybindingMap {
  const base = defaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of Object.keys(base)) {
      const value = parsed[key];
      if (typeof value === "string" && value.includes("+")) {
        base[key] = value;
      }
    }
  } catch {
    /* ignore corrupt state */
  }
  return base;
}

let current: KeybindingMap = load();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
}

function emit() {
  listeners.forEach((listener) => listener());
}

export function setKeybinding(id: string, binding: string) {
  current = { ...current, [id]: binding };
  persist();
  emit();
}

export function resetKeybindings() {
  current = defaults();
  persist();
  emit();
}

/** The definition whose binding collides with `binding`, excluding `id`. */
export function findKeybindingConflict(
  id: string,
  binding: string,
): KeybindingDefinition | null {
  return (
    KEYBINDING_DEFINITIONS.find(
      (item) => item.id !== id && current[item.id] === binding,
    ) ?? null
  );
}

/** Canonical binding for a keyboard event, or null when no modifier is held. */
export function bindingFromEvent(event: KeyboardEvent): string | null {
  if (!(event.metaKey || event.ctrlKey)) return null;
  if (["Meta", "Control", "Shift", "Alt"].includes(event.key)) return null;
  if (event.key === "Escape") return null;
  const parts = ["Mod"];
  if (event.shiftKey) parts.push("Shift");
  if (event.altKey) parts.push("Alt");
  const key =
    event.key === " "
      ? "Space"
      : event.key.length === 1
        ? event.key.toUpperCase()
        : event.key;
  parts.push(key);
  return parts.join("+");
}

export function matchesBinding(
  event: KeyboardEvent,
  binding: string | undefined,
): boolean {
  if (!binding) return false;
  const parts = binding.split("+");
  const key = parts[parts.length - 1] ?? "";
  const needMod = parts.includes("Mod");
  const needShift = parts.includes("Shift");
  const needAlt = parts.includes("Alt");
  const hasMod = event.metaKey || event.ctrlKey;
  if (needMod !== hasMod) return false;
  if (needShift !== event.shiftKey) return false;
  if (needAlt !== event.altKey) return false;
  const eventKey =
    event.key === " " ? "Space" : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return eventKey.toLowerCase() === key.toLowerCase();
}

/** Display tokens, e.g. `["Cmd/Ctrl", "Shift", "P"]`. */
export function formatBinding(binding: string | undefined): string[] {
  if (!binding) return ["—"];
  return binding
    .split("+")
    .map((part) => (part === "Mod" ? "Cmd/Ctrl" : part));
}

export function useKeybindings() {
  const bindings = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => current,
    () => current,
  );
  return {
    bindings,
    setBinding: setKeybinding,
    resetAll: resetKeybindings,
  };
}
