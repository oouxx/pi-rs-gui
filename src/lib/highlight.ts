import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";

type LanguageModule = { default: LanguageFn };

const loaders: Record<string, () => Promise<unknown>> = {
  bash: () => import("highlight.js/lib/languages/bash"),
  c: () => import("highlight.js/lib/languages/c"),
  cpp: () => import("highlight.js/lib/languages/cpp"),
  csharp: () => import("highlight.js/lib/languages/csharp"),
  css: () => import("highlight.js/lib/languages/css"),
  diff: () => import("highlight.js/lib/languages/diff"),
  dockerfile: () => import("highlight.js/lib/languages/dockerfile"),
  go: () => import("highlight.js/lib/languages/go"),
  graphql: () => import("highlight.js/lib/languages/graphql"),
  ini: () => import("highlight.js/lib/languages/ini"),
  java: () => import("highlight.js/lib/languages/java"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  json: () => import("highlight.js/lib/languages/json"),
  kotlin: () => import("highlight.js/lib/languages/kotlin"),
  less: () => import("highlight.js/lib/languages/less"),
  lua: () => import("highlight.js/lib/languages/lua"),
  makefile: () => import("highlight.js/lib/languages/makefile"),
  markdown: () => import("highlight.js/lib/languages/markdown"),
  objectivec: () => import("highlight.js/lib/languages/objectivec"),
  perl: () => import("highlight.js/lib/languages/perl"),
  php: () => import("highlight.js/lib/languages/php"),
  powershell: () => import("highlight.js/lib/languages/powershell"),
  python: () => import("highlight.js/lib/languages/python"),
  r: () => import("highlight.js/lib/languages/r"),
  ruby: () => import("highlight.js/lib/languages/ruby"),
  rust: () => import("highlight.js/lib/languages/rust"),
  scss: () => import("highlight.js/lib/languages/scss"),
  sql: () => import("highlight.js/lib/languages/sql"),
  swift: () => import("highlight.js/lib/languages/swift"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  xml: () => import("highlight.js/lib/languages/xml"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
};

const aliases: Record<string, string> = {
  "c#": "csharp",
  "c++": "cpp",
  cjs: "javascript",
  console: "bash",
  cs: "csharp",
  docker: "dockerfile",
  env: "ini",
  html: "xml",
  js: "javascript",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  md: "markdown",
  mjs: "javascript",
  objc: "objectivec",
  patch: "diff",
  ps1: "powershell",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  toml: "ini",
  ts: "typescript",
  tsp: "typescript",
  tsx: "typescript",
  vue: "xml",
  yml: "yaml",
  zsh: "bash",
};

/** Well-known file names that carry no usable extension. */
const fileNameLanguages: Record<string, string> = {
  ".env": "ini",
  dockerfile: "dockerfile",
  makefile: "makefile",
};

/** Language for a file path, by file name or extension (`null` when unknown). */
export function languageFromPath(path?: string | null): string | null {
  if (!path) return null;
  const base = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  const named = fileNameLanguages[base];
  if (named) return named;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  return resolveLanguage(base.slice(dot + 1));
}

const pending = new Map<string, Promise<boolean>>();

export function resolveLanguage(raw?: string | null): string | null {
  if (!raw) return null;
  const name = raw.trim().toLowerCase();
  const resolved = aliases[name] ?? name;
  return resolved in loaders ? resolved : null;
}

function load(language: string): Promise<boolean> {
  const ready = pending.get(language);
  if (ready) return ready;
  const promise = (loaders[language]?.() ?? Promise.reject())
    .then((module) => {
      const register = (module as LanguageModule).default;
      hljs.registerLanguage(language, register);
      return true;
    })
    .catch(() => false);
  pending.set(language, promise);
  return promise;
}

export function ensureLanguage(language: string): Promise<boolean> {
  return load(language);
}

export function isLanguageLoaded(language: string): boolean {
  return hljs.getLanguage(language) !== undefined;
}

export function highlightSync(
  code: string,
  language: string,
): string | null {
  if (!isLanguageLoaded(language)) return null;
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}
