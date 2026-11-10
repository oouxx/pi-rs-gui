import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Terminal,
  FileText,
  FileEdit,
  Search,
  FolderSearch,
  FolderOpen,
  Wrench,
  CheckCircle2,
  XCircle,
  Loader2,
} from "lucide-react";

interface ToolCallCardProps {
  name: string;
  args?: unknown;
  status?: "running" | "success" | "error";
  result?: string;
  isError?: boolean;
}

// ── Per-tool metadata (icon + human label), matching Codex CLI ──
const TOOL_META: Record<string, { icon: ReactNode; label: string }> = {
  bash: { icon: <Terminal className="size-3.5" />, label: "Run command" },
  read: { icon: <FileText className="size-3.5" />, label: "Read file" },
  edit: { icon: <FileEdit className="size-3.5" />, label: "Edit file" },
  edit_diff: { icon: <FileEdit className="size-3.5" />, label: "Edit file" },
  write: { icon: <FileEdit className="size-3.5" />, label: "Write file" },
  grep: { icon: <Search className="size-3.5" />, label: "Search files" },
  find: { icon: <FolderSearch className="size-3.5" />, label: "Find files" },
  ls: { icon: <FolderOpen className="size-3.5" />, label: "List directory" },
};

const DEFAULT_META = { icon: <Wrench className="size-3.5" />, label: "Tool" };

/** Extract a human-readable summary of the key argument (not raw JSON). */
function summarizeArgs(name: string, args: unknown): string {
  if (args == null) return "";
  let obj: unknown = args;
  if (typeof args === "string") {
    // Streaming partial JSON — try to parse; fall back to the raw fragment.
    try {
      obj = JSON.parse(args);
    } catch {
      return args.length > 200 ? args.slice(0, 200) + "…" : args;
    }
  }
  if (typeof obj !== "object" || obj === null) return String(obj);
  const rec = obj as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === "string" ? v : v == null ? "" : String(v);
  switch (name) {
    case "bash":
      return str(rec.command);
    case "read":
      return str(rec.path);
    case "edit":
    case "edit_diff":
    case "write":
      return str(rec.path) || str(rec.file_path);
    case "grep": {
      const p = str(rec.pattern);
      const path = str(rec.path);
      return path ? `${p} in ${path}` : p;
    }
    case "find": {
      const p = str(rec.pattern) || str(rec.name);
      const path = str(rec.path);
      return path ? `${p} in ${path}` : p;
    }
    case "ls":
      return str(rec.path);
    default: {
      const s = JSON.stringify(obj);
      return s.length > 200 ? s.slice(0, 200) + "…" : s;
    }
  }
}

const STATUS_META: Record<string, { label: string; icon: ReactNode; color: string }> = {
  running: {
    label: "Running",
    icon: <Loader2 className="size-3 animate-spin" />,
    color: "text-codex-amber",
  },
  success: {
    label: "Done",
    icon: <CheckCircle2 className="size-3" />,
    color: "text-codex-green",
  },
  error: {
    label: "Failed",
    icon: <XCircle className="size-3" />,
    color: "text-codex-red",
  },
};

const IDLE_META = {
  label: "Pending",
  icon: <Loader2 className="size-3 animate-spin" />,
  color: "text-codex-faint",
};

/** Format elapsed ms like the TS original's `formatDuration`: seconds with
 *  one decimal, switching to m/s past a minute so a hung command stays
 *  readable (e.g. `12.3s`, `2m 05s`). */
function formatElapsed(ms: number): string {
  const totalSecs = ms / 1000;
  if (totalSecs < 60) return `${totalSecs.toFixed(1)}s`;
  const m = Math.floor(totalSecs / 60);
  const s = Math.floor(totalSecs % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

export default function ToolCallCard({
  name,
  args,
  status,
  result,
  isError,
}: ToolCallCardProps) {
  const [showDetails, setShowDetails] = useState(false);
  // Elapsed timer — the TS original's TUI re-renders every second while a
  // tool runs (`renderResult` setInterval + `Elapsed X.Xs`), so the status
  // line keeps moving even when a command produces no output (e.g. a hung
  // `git clone`). The ACP layer sends no heartbeats (pi-acp doesn't either),
  // so the client clocks it locally.
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (status === "running") {
      startedAtRef.current ??= Date.now();
      setElapsedMs(0);
      const id = setInterval(() => {
        setElapsedMs(Date.now() - (startedAtRef.current ?? Date.now()));
      }, 100);
      return () => clearInterval(id);
    }
    if (startedAtRef.current !== null) {
      // Done/failed: freeze the total duration (TS original's `Took X.Xs`).
      setElapsedMs(Date.now() - startedAtRef.current);
    }
    return undefined;
  }, [status]);

  const meta = TOOL_META[name] ?? DEFAULT_META;
  const summary = summarizeArgs(name, args);
  const argsStr = args
    ? typeof args === "string"
      ? args
      : JSON.stringify(args, null, 2)
    : "";
  const st = STATUS_META[status ?? ""] ?? IDLE_META;
  const effError = isError || status === "error";

  const resultPreview = result
    ? result.length > 240
      ? result.slice(0, 240) + "…"
      : result
    : "";

  return (
    <div className="my-2">
      {/* Header: icon + tool name + status (Codex desktop card) */}
      <div className="flex items-center gap-2 text-sm">
        <span className={`shrink-0 ${st.color}`}>{meta.icon}</span>
        <span className="text-codex-dim font-medium">{name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className={st.color}>{st.icon}</span>
          <span className="text-codex-faint text-xs">{st.label}</span>
          {elapsedMs !== null && (
            <span className="text-codex-faint tabular-nums text-xs">
              {formatElapsed(elapsedMs)}
            </span>
          )}
        </span>
      </div>

      {name === "bash" ? (
        /* bash: terminal-style block with `$` prompt */
        <div className="border-codex-border bg-codex-inset mt-1 overflow-hidden rounded-lg border">
          <div className="px-3 py-2 font-mono text-[13px] leading-relaxed">
            {summary && (
              <div className="text-codex-text break-words whitespace-pre-wrap">
                <span className="text-codex-green select-none">$ </span>
                {summary}
              </div>
            )}
            {resultPreview && !showDetails && (
              <div
                className={`mt-1 break-words whitespace-pre-wrap ${
                  effError ? "text-codex-red" : "text-codex-faint"
                }`}
              >
                {effError ? "✗ " : ""}
                {resultPreview}
              </div>
            )}
          </div>
          {(argsStr || result) && (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="hover:text-codex-dim flex w-full items-center gap-1 border-t border-codex-border px-3 py-1.5 text-left text-xs text-codex-faint transition-colors"
            >
              {showDetails ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              details
            </button>
          )}
          {showDetails && (
            <div className="border-t border-codex-border">
              {argsStr && (
                <pre className="text-codex-dim bg-codex-bg overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
                  {argsStr}
                </pre>
              )}
              {result && (
                <pre
                  className={`bg-codex-bg overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed ${
                    effError ? "text-codex-red" : "text-codex-dim"
                  }`}
                >
                  {result}
                </pre>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* Non-bash tools: dimmed one-line summary */}
          {summary && (
            <div
              className="text-codex-dim mt-1 truncate text-xs"
              title={summary}
            >
              {summary}
            </div>
          )}
          {resultPreview && !showDetails && (
            <div
              className={`mt-0.5 truncate text-xs ${
                effError ? "text-codex-red" : "text-codex-faint"
              }`}
              title={result}
            >
              {effError ? "✗ " : ""}
              {resultPreview}
            </div>
          )}
          {(argsStr || result) && (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="hover:text-codex-dim mt-1 flex items-center gap-1 text-xs text-codex-faint transition-colors"
            >
              {showDetails ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              details
            </button>
          )}
          {showDetails && (
            <div className="border-codex-border bg-codex-inset mt-1 overflow-hidden rounded-lg border">
              {argsStr && (
                <pre className="text-codex-dim bg-codex-bg overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
                  {argsStr}
                </pre>
              )}
              {result && (
                <pre
                  className={`bg-codex-bg overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed ${
                    effError ? "text-codex-red" : "text-codex-dim"
                  }`}
                >
                  {result}
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
