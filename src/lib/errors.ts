import { t, type TranslationKey } from "@/i18n";

export interface ErrorPayload {
  code: string;
  message: string;
}

const codeKeys: Record<string, TranslationKey> = {
  file_outside_roots: "error.fileOutsideRoots",
  too_large: "error.tooLarge",
  not_utf8: "error.notUtf8",
  not_a_file: "error.notAFile",
  gh_missing: "error.ghMissing",
  gh_not_logged_in: "error.ghNotLoggedIn",
};

export function parseError(error: unknown): ErrorPayload {
  if (typeof error === "string") return { code: "error", message: error };
  if (error instanceof Error) return { code: "error", message: error.message };
  if (error && typeof error === "object") {
    const payload = error as { code?: unknown; message?: unknown };
    if (typeof payload.message === "string") {
      return {
        code: typeof payload.code === "string" ? payload.code : "error",
        message: payload.message,
      };
    }
  }
  return { code: "error", message: String(error) };
}

export function errorCode(error: unknown): string {
  return parseError(error).code;
}

export function errorText(error: unknown): string {
  const { code, message } = parseError(error);
  const key = codeKeys[code];
  return key ? t(key) : message;
}
