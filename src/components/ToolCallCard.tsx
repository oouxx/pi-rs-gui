import { useState, type ReactNode } from "react";
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
  args?: any;
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
function summarizeArgs(name: string, args: any): string {
  if (args == null) return "";
  let obj: any = args;
  if (typeof args === "string") {
    // Streaming partial JSON — try to parse; fall back to the raw fragment.
    try {
      obj = JSON.parse(args);
    } catch {
      return args.length > 200 ? args.slice(0, 200) + "…" : args;
    }
  }
  if (typeof obj !== "object") return String(obj);
  switch (name) {
    case "bash":
      return obj.command ?? "";
    case "read":
      return obj.path ?? "";
    case "edit":
    case "edit_diff":
    case "write":
      return obj.path ?? obj.file_path ?? "";
    case "grep": {
      const p = obj.pattern ?? "";
      const path = obj.path ?? "";
      return path ? `${p} in ${path}` : p;
    }
    case "find": {
      const p = obj.pattern ?? obj.name ?? "";
      const path = obj.path ?? "";
      return path ? `${p} in ${path}` : p;
    }
    case "ls":
      return obj.path ?? "";
    default: {
      const s = JSON.stringify(obj);
      return s.length > 200 ? s.slice(0, 200) + "…" : s;
    }
  }
}

const STATUS_META: Record<string, { label: string; icon: ReactNode; color: string }> = {
  running: {
    label: "running",
    icon: <Loader2 className="size-3 animate-spin" />,
    color: "text-codex-amber",
  },
  success: {
    label: "done",
    icon: <CheckCircle2 className="size-3" />,
    color: "text-codex-green-bright",
  },
  error: {
    label: "failed",
    icon: <XCircle className="size-3" />,
    color: "text-codex-red",
  },
};

const IDLE_META = {
  label: "pending",
  icon: <Loader2 className="size-3 animate-spin" />,
  color: "text-codex-faint",
};

export default function ToolCallCard({
  name,
  args,
  status,
  result,
  isError,
}: ToolCallCardProps) {
  const [showDetails, setShowDetails] = useState(false);
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
    <div className="my-1.5 font-mono">
      {/* Header: icon + tool name + status (Codex CLI style) */}
      <div className="flex items-center gap-2 text-xs">
        <span className={`shrink-0 ${st.color}`}>{meta.icon}</span>
        <span className="text-codex-dim font-medium">{name}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className={st.color}>{st.icon}</span>
          <span className="text-codex-faint text-[10px]">{st.label}</span>
        </span>
      </div>

      {name === "bash" ? (
        /* bash: terminal-style block with `$` prompt */
        <div className="mt-1 overflow-hidden rounded-md border border-codex-border bg-codex-bg">
          <div className="px-3 py-2 text-xs leading-relaxed">
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
              className="hover:text-codex-dim flex w-full items-center gap-1 border-t border-codex-border/60 px-3 py-1 text-left font-mono text-[10px] text-codex-faint transition-colors"
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
            <div className="border-t border-codex-border/60">
              {argsStr && (
                <pre className="text-codex-dim overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {argsStr}
                </pre>
              )}
              {result && (
                <pre
                  className={`overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed ${
                    effError ? "text-codex-red" : "text-codex-faint"
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
              className="text-codex-dim mt-1 truncate font-mono text-[11px]"
              title={summary}
            >
              {summary}
            </div>
          )}
          {resultPreview && !showDetails && (
            <div
              className={`mt-0.5 truncate font-mono text-[11px] ${
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
              className="hover:text-codex-dim mt-0.5 flex items-center gap-1 font-mono text-[10px] text-codex-faint transition-colors"
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
            <div className="mt-1 overflow-hidden rounded-md border border-codex-border bg-codex-bg">
              {argsStr && (
                <pre className="text-codex-dim overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed">
                  {argsStr}
                </pre>
              )}
              {result && (
                <pre
                  className={`overflow-x-auto px-3 py-2 font-mono text-[11px] leading-relaxed ${
                    effError ? "text-codex-red" : "text-codex-faint"
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
