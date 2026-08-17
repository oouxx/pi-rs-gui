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

// ── Per-tool metadata (icon + human label), matching Claude Code / Codex ──
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
      return args.length > 120 ? args.slice(0, 120) + "…" : args;
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
      return s.length > 120 ? s.slice(0, 120) + "…" : s;
    }
  }
}

const STATUS_LABEL: Record<string, string> = {
  running: "Running",
  success: "Done",
  error: "Failed",
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
  const resultPreview = result
    ? result.length > 120
      ? result.slice(0, 120) + "…"
      : result
    : "";

  const statusIcon = () => {
    switch (status) {
      case "running":
        return <Loader2 className="size-3.5 animate-spin text-amber-500" />;
      case "success":
        return <CheckCircle2 className="size-3.5 text-emerald-500" />;
      case "error":
        return <XCircle className="size-3.5 text-red-500" />;
      default:
        return <Loader2 className="size-3.5 text-muted-foreground" />;
    }
  };

  return (
    <div className="border-hairline bg-bg-surface my-2 overflow-hidden rounded-lg border text-xs">
      {/* Header: icon + tool name + status */}
      <div className="flex items-center gap-2 px-3 py-2">
        <span
          title={meta.label}
          className={`shrink-0 ${
            status === "error"
              ? "text-red-500"
              : status === "success"
                ? "text-emerald-500"
                : status === "running"
                  ? "text-amber-500"
                  : "text-muted-foreground"
          }`}
        >
          {meta.icon}
        </span>
        <span className="font-medium text-foreground">{name}</span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {statusIcon()}
          <span className="text-muted-foreground text-[10px] capitalize">
            {STATUS_LABEL[status ?? ""] ?? "Pending"}
          </span>
        </div>
      </div>

      {/* Key argument summary (always visible, human-readable) */}
      {summary && (
        <div className="border-t border-border/50 px-3 py-1.5">
          <span
            className="text-muted-foreground block truncate font-mono text-[11px]"
            title={summary}
          >
            {summary}
          </span>
        </div>
      )}

      {/* Result preview (visible while collapsed) */}
      {resultPreview && !showDetails && (
        <div className="border-t border-border/50 px-3 py-1.5">
          <span
            className={`block truncate font-mono text-[11px] ${
              isError ? "text-red-400" : "text-muted-foreground/80"
            }`}
            title={result}
          >
            {isError ? "✗ " : ""}
            {resultPreview}
          </span>
        </div>
      )}

      {/* Details (collapsible: full args + result) */}
      {(argsStr || result) && (
        <button
          type="button"
          onClick={() => setShowDetails((v) => !v)}
          className="hover:bg-bg-hover flex w-full items-center gap-1.5 border-t border-border/50 px-3 py-1.5 text-left transition-colors"
        >
          {showDetails ? (
            <ChevronDown className="size-3" />
          ) : (
            <ChevronRight className="size-3" />
          )}
          <span className="text-muted-foreground font-mono text-[10px]">
            Details
          </span>
        </button>
      )}
      {showDetails && (
        <div className="border-t border-border/50">
          {argsStr && (
            <pre className="bg-bg-hover overflow-x-auto px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {argsStr}
            </pre>
          )}
          {result && (
            <pre
              className={`overflow-x-auto px-3 py-2 font-mono text-[10px] leading-relaxed ${
                isError
                  ? "bg-red-950/20 text-red-400"
                  : "bg-bg-hover text-muted-foreground"
              }`}
            >
              {result}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
