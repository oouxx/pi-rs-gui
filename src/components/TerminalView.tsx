import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { RotateCcw, TerminalSquare } from "lucide-react";
import {
  getActiveSessionCwd,
  terminalStart,
  terminalStop,
  terminalWrite,
} from "@/api/commands";
import { tauriListen } from "@/api/events";

export default function TerminalView() {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [status, setStatus] = useState<"starting" | "running" | "failed">(
    "starting",
  );
  const [key, setKey] = useState(0);

  const boot = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    // Dispose any previous terminal instance.
    termRef.current?.dispose();
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      theme: { background: "#0d1117" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    setStatus("starting");
    sessionIdRef.current = null;

    let disposed = false;
    let unsub: (() => void) | undefined;

    (async () => {
      try {
        const cwd = await getActiveSessionCwd();
        const id = await terminalStart(cwd);
        if (disposed) {
          await terminalStop();
          return;
        }
        sessionIdRef.current = id;
        setStatus("running");
        unsub = await tauriListen<any>("terminal-output", (evt: any) => {
          if (disposed || evt.sessionId !== sessionIdRef.current) return;
          term.write(evt.data ?? "");
        });
      } catch (e) {
        console.error("[terminal start]", e);
        if (!disposed) setStatus("failed");
      }
    })();

    const dataSub = term.onData((d) => {
      if (sessionIdRef.current) {
        terminalWrite(sessionIdRef.current, d).catch(() => {});
      }
    });

    const resize = () => fit.fit();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    const onWinResize = () => fit.fit();
    window.addEventListener("resize", onWinResize);

    return () => {
      disposed = true;
      ro.disconnect();
      window.removeEventListener("resize", onWinResize);
      dataSub.dispose();
      unsub?.();
      terminalStop().catch(() => {});
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    const cleanup = boot();
    return () => {
      cleanup.then((fn) => fn?.());
    };
  }, [boot, key]);

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="shrink-0" />
        <div className="text-foreground flex items-center gap-1.5 text-sm font-medium">
          <TerminalSquare className="size-3.5" />
          Terminal
        </div>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] uppercase ${
            status === "running"
              ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
              : status === "failed"
                ? "bg-red-500/10 text-red-600 dark:text-red-400"
                : "bg-muted text-muted-foreground"
          }`}
        >
          {status}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setKey((k) => k + 1)}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors"
          title="Restart terminal"
        >
          <RotateCcw className="size-3.5" />
          Restart
        </button>
      </div>

      {/* xterm container */}
      <div ref={containerRef} className="min-h-0 flex-1 bg-[#0d1117] p-2" />
    </div>
  );
}
