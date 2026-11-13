import { useCallback, useSyncExternalStore } from "react";
import en, { type TranslationKey } from "./en";
import zh from "./zh";

export type Language = "en" | "zh";
export type LanguagePreference = "system" | "en" | "zh";

const STORAGE_KEY = "pi-gui:language";
const listeners = new Set<() => void>();

const dictionaries: Record<Language, Record<TranslationKey, string>> = {
  en,
  zh,
};

function detectSystem(): Language {
  const language =
    typeof navigator !== "undefined" ? navigator.language : undefined;
  if (!language) return "en";
  return language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function loadPreference(): LanguagePreference {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "system" || value === "en" || value === "zh") return value;
  } catch {
    /* ignore */
  }
  return "system";
}

let currentPreference: LanguagePreference = loadPreference();

export function resolveLanguage(
  preference: LanguagePreference = currentPreference,
): Language {
  if (preference === "en" || preference === "zh") return preference;
  return detectSystem();
}

export function translate(
  language: Language,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const template = dictionaries[language][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    String(params[name] ?? `{${name}}`),
  );
}

/** Translate outside React (imperative helpers). */
export function t(
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  return translate(resolveLanguage(), key, params);
}

function applyDocumentLanguage(language: Language) {
  if (typeof document === "undefined") return;
  document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
}

/** Apply the resolved language to `<html lang>` at startup. */
export function initLanguage() {
  applyDocumentLanguage(resolveLanguage());
}

export function setLanguagePreference(preference: LanguagePreference) {
  currentPreference = preference;
  try {
    localStorage.setItem(STORAGE_KEY, preference);
  } catch {
    /* ignore */
  }
  applyDocumentLanguage(resolveLanguage(preference));
  listeners.forEach((listener) => listener());
}

export function useI18n() {
  const preference = useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => currentPreference,
    () => currentPreference,
  );
  const language = resolveLanguage(preference);
  const translateKey = useCallback(
    (key: TranslationKey, params?: Record<string, string | number>) =>
      translate(language, key, params),
    [language],
  );
  return {
    preference,
    language,
    t: translateKey,
    setLanguage: setLanguagePreference,
  };
}

export type { TranslationKey };
