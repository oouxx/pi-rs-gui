import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { expand, FAST_TRANSITION, PANEL_TRANSITION } from "@/lib/motion";
import {
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
  ExternalLink,
} from "lucide-react";
import { getActiveSessionCwd, openFile } from "@/api/commands";
import { useToast } from "@/components/ui/toast";
import { useI18n, type TranslationKey } from "@/i18n";

interface ToolCallCardProps {
  name: string;
  args?: unknown;
  status?: "running" | "success" | "error";
  result?: string;
  isError?: boolean;
  /** ToolResult details (edit: diff/patch/firstChangedLine). */
  details?: unknown;
}

// ── Per-tool icon (the tool name itself is shown as the title) ──
const TOOL_META: Record<string, { icon: ReactNode }> = {
  bash: { icon: <Terminal className="size-3.5" /> },
  read: { icon: <FileText className="size-3.5" /> },
  edit: { icon: <FileEdit className="size-3.5" /> },
  edit_diff: { icon: <FileEdit className="size-3.5" /> },
  write: { icon: <FileEdit className="size-3.5" /> },
  grep: { icon: <Search className="size-3.5" /> },
  find: { icon: <FolderSearch className="size-3.5" /> },
  ls: { icon: <FolderOpen className="size-3.5" /> },
};

const DEFAULT_META = { icon: <Wrench className="size-3.5" /> };

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

const STATUS_META: Record<
  string,
  { labelKey: TranslationKey; icon: ReactNode; color: string }
> = {
  running: {
    labelKey: "tool.running",
    icon: <Loader2 className="size-3 animate-spin" />,
    color: "text-warning",
  },
  success: {
    labelKey: "tool.done",
    icon: <CheckCircle2 className="size-3" />,
    color: "text-success",
  },
  error: {
    labelKey: "tool.failed",
    icon: <XCircle className="size-3" />,
    color: "text-destructive",
  },
};

const IDLE_META = {
  labelKey: "tool.pending" as TranslationKey,
  icon: <Loader2 className="size-3 animate-spin" />,
  color: "text-subtle-foreground",
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

function asRecord(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return null;
    }
  }
  return parsed && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * Render pi-rs's display-oriented diff (`details.diff`):
 * `" 12 context"`, `"-12 removed"`, `"+12 added"`.
 */
function DiffView({
  text,
  truncated,
}: {
  text: string;
  truncated?: boolean;
}) {
  const { t } = useI18n();
  const lines = text.split("\n").slice(0, 600);
  return (
    <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
      <div className="max-h-80 overflow-auto font-mono text-[12px] leading-relaxed">
        {lines.map((line, index) => {
          const marker = line[0];
          const kind =
            marker === "+" ? "add" : marker === "-" ? "del" : "ctx";
          const match = line.slice(1).match(/^(\s*\d+)\s(.*)$/s);
          const number = match?.[1]?.trim() ?? "";
          const content = match ? match[2] : line.slice(1);
          const tone =
            kind === "add"
              ? "bg-success/10 text-success"
              : kind === "del"
                ? "bg-destructive/10 text-destructive"
                : "text-muted-foreground";
          return (
            <div key={index} className={`flex ${tone}`}>
              <span className="w-10 shrink-0 pr-2 text-right opacity-50 select-none">
                {number}
              </span>
              <span className="w-4 shrink-0 select-none">
                {kind === "add" ? "+" : kind === "del" ? "-" : " "}
              </span>
              <span className="min-w-0 flex-1 pr-3 break-all whitespace-pre-wrap">
                {content}
              </span>
            </div>
          );
        })}
      </div>
      {truncated && (
        <div className="text-subtle-foreground border-border border-t px-3 py-1 text-[11px]">
          {t("tool.truncated")}
        </div>
      )}
    </div>
  );
}

/** Build the diff shown for edit/write tool calls. */
function diffFor(
  name: string,
  args: unknown,
  details: unknown,
): { text: string; truncated: boolean } {
  const detailsRecord = asRecord(details);
  if (name === "edit" || name === "edit_diff") {
    const diff = detailsRecord?.diff;
    return {
      text: typeof diff === "string" ? diff : "",
      truncated: false,
    };
  }
  if (name === "write") {
    const argsRecord = asRecord(args);
    const content =
      typeof argsRecord?.content === "string" ? argsRecord.content : "";
    if (!content) return { text: "", truncated: false };
    const lines = content.split("\n");
    const shown = lines.slice(0, 400);
    const width = String(shown.length).length;
    return {
      text: shown
        .map((line, index) => `+${String(index + 1).padStart(width)} ${line}`)
        .join("\n"),
      truncated: lines.length > shown.length,
    };
  }
  return { text: "", truncated: false };
}

export default function ToolCallCard({
  name,
  args,
  status,
  result,
  isError,
  details,
}: ToolCallCardProps) {
  const { toast } = useToast();
  const { t } = useI18n();
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
  const diff = diffFor(name, args, details);
  const argsRecord = asRecord(args);
  const filePath =
    typeof argsRecord?.path === "string"
      ? argsRecord.path
      : typeof argsRecord?.file_path === "string"
        ? argsRecord.file_path
        : "";

  const handleOpenFile = useCallback(
    async (event: React.MouseEvent) => {
      event.stopPropagation();
      if (!filePath) return;
      try {
        const cwd = await getActiveSessionCwd();
        await openFile(filePath, cwd);
      } catch (error) {
        toast({
          variant: "error",
          title: t("common.openFailed"),
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [filePath, t, toast],
  );

  return (
    <div className="my-2">
      {/* Header: icon + tool name + status */}
      <div className="flex items-center gap-2 text-sm">
        <span className={`shrink-0 ${st.color}`}>{meta.icon}</span>
        <span className="text-muted-foreground font-medium">{name}</span>
        {filePath && (
          <button
            type="button"
            onClick={handleOpenFile}
            className="text-subtle-foreground hover:text-muted-foreground shrink-0"
            title={t("common.openInEditor")} aria-label={t("common.openInEditor")}
          >
            <ExternalLink className="size-3" />
          </button>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className={st.color}>{st.icon}</span>
          <span className="text-subtle-foreground text-xs">
            {t(st.labelKey)}
          </span>
          {elapsedMs !== null && (
            <span className="text-subtle-foreground tabular-nums text-xs">
              {formatElapsed(elapsedMs)}
            </span>
          )}
        </span>
      </div>

      {name === "bash" ? (
        /* bash: terminal-style block with `$` prompt */
        <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
          <div className="px-3 py-2 font-mono text-[13px] leading-relaxed">
            {summary && (
              <div className="text-foreground break-words whitespace-pre-wrap">
                <span className="text-success select-none">$ </span>
                {summary}
              </div>
            )}
            {resultPreview && !showDetails && (
              <div
                className={`mt-1 break-words whitespace-pre-wrap ${
                  effError ? "text-destructive" : "text-subtle-foreground"
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
              className="hover:text-muted-foreground flex w-full items-center gap-1 border-t border-border px-3 py-1.5 text-left text-xs text-subtle-foreground transition-colors"
            >
              <motion.span
                className="inline-flex"
                animate={{ rotate: showDetails ? 90 : 0 }}
                transition={FAST_TRANSITION}
              >
                <ChevronRight className="size-3" />
              </motion.span>
              {t("tool.details")}
            </button>
          )}
          <AnimatePresence initial={false}>
            {showDetails && (
              <motion.div
                {...expand}
                transition={PANEL_TRANSITION}
                className="border-t border-border overflow-hidden"
              >
                {argsStr && (
                  <pre className="text-muted-foreground bg-background overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
                    {argsStr}
                  </pre>
                )}
                {result && (
                  <pre
                    className={`bg-background overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed ${
                      effError ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {result}
                  </pre>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      ) : (
        <>
          {/* Non-bash tools: dimmed one-line summary */}
          {summary && (
            <div
              className="text-muted-foreground mt-1 truncate text-xs"
              title={summary}
            >
              {summary}
            </div>
          )}
          {diff.text ? (
            <DiffView text={diff.text} truncated={diff.truncated} />
          ) : (
            resultPreview &&
            !showDetails && (
              <div
                className={`mt-0.5 truncate text-xs ${
                  effError ? "text-destructive" : "text-subtle-foreground"
                }`}
                title={result}
              >
                {effError ? "✗ " : ""}
                {resultPreview}
              </div>
            )
          )}
          {(argsStr || result) && (
            <button
              type="button"
              onClick={() => setShowDetails((v) => !v)}
              className="hover:text-muted-foreground mt-1 flex items-center gap-1 text-xs text-subtle-foreground transition-colors"
            >
              <motion.span
                className="inline-flex"
                animate={{ rotate: showDetails ? 90 : 0 }}
                transition={FAST_TRANSITION}
              >
                <ChevronRight className="size-3" />
              </motion.span>
              {t("tool.details")}
            </button>
          )}
          <AnimatePresence initial={false}>
            {showDetails && (
              <motion.div
                {...expand}
                transition={PANEL_TRANSITION}
                className="border-border bg-muted mt-1 overflow-hidden rounded-lg border"
              >
                {argsStr && (
                  <pre className="text-muted-foreground bg-background overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
                    {argsStr}
                  </pre>
                )}
                {result && (
                  <pre
                    className={`bg-background overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed ${
                      effError ? "text-destructive" : "text-muted-foreground"
                    }`}
                  >
                    {result}
                  </pre>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
