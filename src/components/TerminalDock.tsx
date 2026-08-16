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
// Routes backend `terminal-output` events to per-session subscribers.
// Output for sessions without a live subscriber yet is buffered so the
// shell prompt emitted right after spawn is never lost (the dock registers
// its listener before any terminal is started).
const terminalSubs = new Map<string, Set<(data: string) => void>>();
const terminalBuffers = new Map<string, string[]>();

function routeTerminalOutput(id: string, data: string) {
  const set = terminalSubs.get(id);
  if (set && set.size > 0) {
    for (const fn of [...set]) fn(data);
  } else {
    let buf = terminalBuffers.get(id);
    if (!buf) {
      buf = [];
      terminalBuffers.set(id, buf);
    }
    buf.push(data);
  }
}

function subscribeTerminal(id: string, fn: (data: string) => void): () => void {
  const buffered = terminalBuffers.get(id);
  if (buffered && buffered.length > 0) {
    for (const d of buffered) fn(d);
    terminalBuffers.delete(id);
  }
  const set = terminalSubs.get(id) ?? new Set<(data: string) => void>();
  set.add(fn);
  terminalSubs.set(id, set);
  return () => {
    set.delete(fn);
    if (set.size === 0) terminalSubs.delete(id);
  };
}

// ── Single terminal tab ──────────────────────────────────────────
function TerminalInstance({
  sessionId,
  active,
}: {
  sessionId: string;
  active: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const unsub = subscribeTerminal(sessionId, (data) => {
      if (!disposed) term.write(data);
    });

    // Sync the PTY size with the current xterm viewport.
    const dims = fit.proposeDimensions();
    if (dims) terminalResize(sessionId, dims.cols, dims.rows).catch(() => {});

    const dataSub = term.onData((d) => {
      terminalWrite(sessionId, d).catch(() => {});
    });
    const resizeSub = term.onResize(({ cols, rows }) => {
      terminalResize(sessionId, cols, rows).catch(() => {});
    });

    const doFit = () => {
      if (active) requestAnimationFrame(() => fit.fit());
    };
    const ro = new ResizeObserver(doFit);
    ro.observe(container);
    window.addEventListener("resize", doFit);

    return () => {
      disposed = true;
      unsub();
      ro.disconnect();
      window.removeEventListener("resize", doFit);
      dataSub.dispose();
      resizeSub.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Re-fit when this tab becomes active (inactive tabs are display:none so
  // their container has zero size until shown).
  useEffect(() => {
    if (!active) return;
    const fit = fitRef.current;
    if (fit) requestAnimationFrame(() => fit.fit());
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="h-full w-full bg-[#0d1117]"
      style={{ display: active ? "block" : "none" }}
    />
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

  // One global listener routes output to per-session subscribers.
  useEffect(() => {
    let unsub: (() => void) | undefined;
    (async () => {
      unsub = await tauriListen<any>("terminal-output", (evt: any) => {
        routeTerminalOutput(evt.sessionId, evt.data ?? "");
      });
    })();
    return () => {
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

      {/* Terminals (only the active one is visible) */}
      <div className="min-h-0 flex-1">
        {tabs.map((t) => (
          <TerminalInstance
            key={t.id}
            sessionId={t.id}
            active={t.id === activeId}
          />
        ))}
      </div>
    </div>
  );
}
