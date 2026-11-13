import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Plus, X, TerminalSquare, ChevronDown } from "lucide-react";
import {
  terminalResize,
  terminalStart,
  terminalStop,
  terminalStopAll,
  terminalWrite,
} from "@/api/commands";
import { tauriListen } from "@/api/events";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/ui/toast";

// ── terminal-output bus ──────────────────────────────────────────
// Retains a capped raw-output log per session (so a re-mounted tab can
// rehydrate its visible history quickly) and routes live events to the
// session's subscriber (only the active tab is mounted, so at most one
// subscriber exists).
const terminalLogs = new Map<string, string[]>();
const terminalSubs = new Map<string, Set<(data: string) => void>>();
const LOG_CAP_CHARS = 200_000;

function trimLog(log: string[]) {
  let total = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    total += log[i].length;
    if (total > LOG_CAP_CHARS && i > 0) {
      log.splice(0, i);
      break;
    }
  }
}

function routeTerminalOutput(id: string, data: string) {
  const log = terminalLogs.get(id) ?? [];
  log.push(data);
  trimLog(log);
  terminalLogs.set(id, log);
  const set = terminalSubs.get(id);
  if (set && set.size > 0) {
    for (const fn of [...set]) fn(data);
  }
}

function subscribeTerminal(id: string, fn: (data: string) => void): () => void {
  const set = terminalSubs.get(id) ?? new Set<(data: string) => void>();
  set.add(fn);
  terminalSubs.set(id, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) terminalSubs.delete(id);
  };
}

function writeLog(id: string, term: Terminal) {
  const log = terminalLogs.get(id);
  if (log) {
    for (const d of log) term.write(d);
  }
}

/** Warm ANSI palette so shell colors sit on the paper/charcoal surfaces
 *  instead of xterm's default cool primaries. */
const TERMINAL_ANSI_LIGHT = {
  black: "#1f1e1d",
  red: "#bf4d43",
  green: "#5c7a4a",
  yellow: "#96601a",
  blue: "#4f6b8a",
  magenta: "#8a5a76",
  cyan: "#4f7470",
  white: "#d9d6cc",
  brightBlack: "#75736b",
  brightRed: "#d0655a",
  brightGreen: "#72925c",
  brightYellow: "#b57a2a",
  brightBlue: "#5f7ea3",
  brightMagenta: "#a36c8d",
  brightCyan: "#5f8783",
  brightWhite: "#faf9f5",
} as const;

const TERMINAL_ANSI_DARK = {
  black: "#1f1e1d",
  red: "#e07a6e",
  green: "#8fa870",
  yellow: "#d9a441",
  blue: "#7f9cc0",
  magenta: "#c08ba8",
  cyan: "#7fb3ac",
  white: "#d8d4ca",
  brightBlack: "#8d8b83",
  brightRed: "#ef9185",
  brightGreen: "#a8c088",
  brightYellow: "#e9b95a",
  brightBlue: "#9cb6d6",
  brightMagenta: "#d4a0bd",
  brightCyan: "#98c9c2",
  brightWhite: "#f5f3ec",
} as const;

/** Resolve the terminal palette from the active theme tokens. xterm needs
 *  literal colors, so the surface values live as CSS variables in theme.css. */
function readTerminalTheme() {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() || fallback;
  const dark = document.documentElement.dataset.theme === "dark";
  return {
    background: token("--terminal-bg", "#faf9f5"),
    foreground: token("--terminal-fg", "#141413"),
    cursor: token("--terminal-cursor", "#b85c3f"),
    selectionBackground: token("--terminal-selection", "rgba(184, 92, 63, 0.18)"),
    ...(dark ? TERMINAL_ANSI_DARK : TERMINAL_ANSI_LIGHT),
  };
}

// ── Single terminal tab (only mounted while active) ──────────────
function TerminalInstance({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [hasOutput, setHasOutput] = useState(false);
  const hasOutputRef = useRef(false);
  const { resolved } = useTheme();
  const { t } = useI18n();

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: readTerminalTheme(),
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);

    // The container is live (this tab is active) and laid out by now, so a
    // synchronous fit gives the correct size BEFORE the retained log is
    // written — avoids rendering it at the default 80x24 then re-rendering.
    fit.fit();
    setHasOutput((terminalLogs.get(sessionId)?.length ?? 0) > 0);

    // Rehydrate retained output, then subscribe for live output. There is no
    // gap: routeTerminalOutput appends to the log synchronously, and this
    // whole block runs without awaiting between writeLog and subscribe.
    writeLog(sessionId, term);
    const unsub = subscribeTerminal(sessionId, (data) => {
      // Flip the placeholder exactly once; React bails on identical state so
      // subsequent per-chunk writes don't re-render the component.
      if (!hasOutputRef.current) {
        hasOutputRef.current = true;
        setHasOutput(true);
      }
      term.write(data);
    });

    // Sync the PTY size with the current xterm viewport (immediate for the
    // initial fit; later onResize events are debounced).
    const dims = fit.proposeDimensions();
    if (dims) terminalResize(sessionId, dims.cols, dims.rows).catch(() => {});

    const dataSub = term.onData((d) => {
      terminalWrite(sessionId, d).catch(() => {});
    });

    // Debounce resize IPC: term.onResize fires on every fit(), which can be
    // rapid during window drags / panel resizes.
    let resizeTimer: number | undefined;
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        terminalResize(sessionId, cols, rows).catch(() => {});
      }, 100);
    });

    const doFit = () => requestAnimationFrame(() => fit.fit());
    const ro = new ResizeObserver(doFit);
    ro.observe(container);
    window.addEventListener("resize", doFit);

    return () => {
      unsub();
      if (resizeTimer !== undefined) clearTimeout(resizeTimer);
      ro.disconnect();
      window.removeEventListener("resize", doFit);
      dataSub.dispose();
      resizeSub.dispose();
      termRef.current = null;
      term.dispose();
    };
  }, [sessionId]);

  // Follow light/dark switches without recreating the terminal (which would
  // drop the shell session).
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = readTerminalTheme();
  }, [resolved]);

  return (
    <div className="bg-[var(--terminal-bg)] relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      {/* Shell is still initializing (e.g. slow .zshrc) — show a hint so the
          blank screen doesn't look frozen. */}
      {!hasOutput && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-muted-foreground animate-pulse text-xs">
            {t("terminal.starting")}
          </span>
        </div>
      )}
    </div>
  );
}

// ── Terminal dock (Chrome-tab style) ─────────────────────────────
interface TerminalTab {
  id: string;
  title: string;
}

export default function TerminalDock({
  cwd,
  onClose,
}: {
  cwd?: string | null;
  onClose: () => void;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const autoCreatedRef = useRef(false);
  const { t } = useI18n();
  const { toast } = useToast();

  // One global listener routes output to the bus (log + subscriber).
  // The `disposed` flag guards against React StrictMode's double effect: the
  // async tauriListen may resolve AFTER the first cleanup, which would leave
  // two live listeners and double every output chunk (typing shows twice).
  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | undefined;
    (async () => {
      const u = await tauriListen<{ sessionId: string; data?: string }>(
        "terminal-output",
        (evt) => {
          routeTerminalOutput(evt.sessionId, evt.data ?? "");
        },
      );
      if (disposed) {
        u();
        return;
      }
      unsub = u;
    })();
    return () => {
      disposed = true;
      unsub?.();
    };
  }, []);

  // Kill every backend session when the dock unmounts.
  useEffect(
    () => () => {
      terminalStopAll().catch(() => {});
    },
    [],
  );

  const addTab = useCallback(async () => {
    try {
      const id = await terminalStart(cwd ?? undefined);
      const base = cwd?.split("/").filter(Boolean).pop() ?? "terminal";
      setTabs((prev) => [
        ...prev,
        {
          id,
          title: prev.length === 0 ? base : `${base} ${prev.length + 1}`,
        },
      ]);
      setActiveId(id);
    } catch (e) {
      console.error("[terminal start]", e);
      toast({
        variant: "error",
        title: t("terminal.startFailed"),
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [cwd, t, toast]);

  // Auto-create the first tab when the dock opens with none (guarded against
  // React StrictMode's double effect invocation).
  useEffect(() => {
    if (tabs.length === 0 && !autoCreatedRef.current) {
      autoCreatedRef.current = true;
      addTab();
    }
  }, [tabs.length, addTab]);

  const closeTab = useCallback(
    async (id: string) => {
      await terminalStop(id).catch(() => {});
      terminalLogs.delete(id);
      const remaining = tabs.filter((t) => t.id !== id);
      setTabs(remaining);
      setActiveId((cur) =>
        cur === id ? (remaining[remaining.length - 1]?.id ?? null) : cur,
      );
      // Allow auto-create again once the last tab is closed.
      if (remaining.length === 0) autoCreatedRef.current = false;
    },
    [tabs],
  );

  return (
    <div className="bg-background flex h-full min-h-0 flex-col">
      {/* Tab bar */}
      <div className="border-border/60 flex items-center border-b px-1.5 pt-1">
        <TerminalSquare className="text-subtle-foreground mx-1.5 size-3.5 shrink-0" />
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
          {tabs.map((tab) => {
            const active = tab.id === activeId;
            return (
              <div
                key={tab.id}
                onClick={() => setActiveId(tab.id)}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1 text-[11px] transition-colors ${
                  active
                    ? "border-border bg-muted text-foreground"
                    : "text-subtle-foreground hover:text-muted-foreground border-transparent"
                }`}
                title={`${tab.title} — ${cwd ?? ""}`}
              >
                <span className="max-w-[120px] truncate">{tab.title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(tab.id);
                  }}
                  className="hover:bg-accent rounded p-0.5"
                  title={t("terminal.close")} aria-label={t("terminal.close")}
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addTab}
            className="text-subtle-foreground hover:text-muted-foreground mb-1 ml-1 rounded p-1"
            title={t("terminal.new")} aria-label={t("terminal.new")}
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-subtle-foreground hover:text-muted-foreground ml-1 rounded p-1.5"
          title={t("terminal.closePanel")} aria-label={t("terminal.closePanel")}
        >
          <ChevronDown className="size-3.5" />
        </button>
      </div>

      {/* Only the active tab's terminal is mounted (bounds memory/DOM to one
          xterm; switching remounts it and rehydrates from the retained log). */}
      <div className="min-h-0 flex-1">
        {tabs.map((t) =>
          t.id === activeId ? (
            <TerminalInstance key={t.id} sessionId={t.id} />
          ) : null,
        )}
      </div>
    </div>
  );
}
