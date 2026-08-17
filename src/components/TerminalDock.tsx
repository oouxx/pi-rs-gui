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

// ── Single terminal tab (only mounted while active) ──────────────
function TerminalInstance({ sessionId }: { sessionId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hasOutput, setHasOutput] = useState(false);
  const hasOutputRef = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#0d1117" },
    });
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
      term.dispose();
    };
  }, [sessionId]);

  return (
    <div className="relative h-full w-full bg-[#0d1117]">
      <div ref={containerRef} className="h-full w-full" />
      {/* Shell is still initializing (e.g. slow .zshrc) — show a hint so the
          blank screen doesn't look frozen. */}
      {!hasOutput && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="text-muted-foreground animate-pulse text-xs">
            Starting shell…
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

  // One global listener routes output to the bus (log + subscriber).
  // The `disposed` flag guards against React StrictMode's double effect: the
  // async tauriListen may resolve AFTER the first cleanup, which would leave
  // two live listeners and double every output chunk (typing shows twice).
  useEffect(() => {
    let disposed = false;
    let unsub: (() => void) | undefined;
    (async () => {
      const u = await tauriListen<any>("terminal-output", (evt: any) => {
        routeTerminalOutput(evt.sessionId, evt.data ?? "");
      });
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
      setTabs((prev) => [...prev, { id, title: `bash ${prev.length + 1}` }]);
      setActiveId(id);
    } catch (e) {
      console.error("[terminal start]", e);
    }
  }, [cwd]);

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
    <div className="border-hairline bg-bg-surface flex h-56 shrink-0 flex-col border-t">
      {/* Tab bar */}
      <div className="flex items-center border-b border-border/50 px-1.5 pt-1">
        <TerminalSquare className="text-muted-foreground mx-1.5 size-3.5 shrink-0" />
        <div className="flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto">
          {tabs.map((t) => {
            const active = t.id === activeId;
            return (
              <div
                key={t.id}
                onClick={() => setActiveId(t.id)}
                className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-t-md border border-b-0 px-3 py-1 text-[11px] transition-colors ${
                  active
                    ? "border-border bg-[#0d1117] text-zinc-100"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
                title={`${t.title} — ${cwd ?? ""}`}
              >
                <span className="max-w-[120px] truncate">{t.title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  className="hover:bg-muted rounded p-0.5"
                  title="Close terminal"
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={addTab}
            className="text-muted-foreground hover:text-foreground mb-1 ml-1 rounded p-1"
            title="New terminal"
          >
            <Plus className="size-3.5" />
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground ml-1 rounded p-1.5"
          title="Close terminal panel"
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
