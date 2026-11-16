import { useEffect, useMemo, useState } from "react";
import {
  ensureLanguage,
  highlightSync,
  isLanguageLoaded,
  resolveLanguage,
} from "@/lib/highlight";

const MAX_HIGHLIGHT_CHARS = 20000;

export function useHighlightedCode(
  code: string,
  language?: string | null,
): string | null {
  const name = resolveLanguage(language);
  const [ready, setReady] = useState(() =>
    name ? isLanguageLoaded(name) : false,
  );

  useEffect(() => {
    if (!name) {
      setReady(false);
      return;
    }
    if (isLanguageLoaded(name)) {
      setReady(true);
      return;
    }
    let alive = true;
    void ensureLanguage(name).then((ok) => {
      if (alive && ok) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [name]);

  return useMemo(() => {
    if (!name || !ready || code.length > MAX_HIGHLIGHT_CHARS) return null;
    return highlightSync(code, name);
  }, [code, name, ready]);
}
