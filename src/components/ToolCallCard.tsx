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
  Globe,
  Bot,
  ArrowUpRight,
  Copy,
} from "lucide-react";
import { getActiveSessionCwd, openFile, openPath } from "@/api/commands";
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
  web_search: { icon: <Globe className="size-3.5" /> },
  web_fetch: { icon: <Globe className="size-3.5" /> },
  subagent: { icon: <Bot className="size-3.5" /> },
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
  embedded = false,
}: {
  text: string;
  truncated?: boolean;
  embedded?: boolean;
}) {
  const { t } = useI18n();
  const lines = text.split("\n").slice(0, 600);
  return (
    <div
      className={
        embedded
          ? "overflow-hidden"
          : "border-border bg-muted mt-1 overflow-hidden rounded-lg border"
      }
    >
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

// ── Extension tool rendering (web_search / web_fetch / subagent) ──

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface WebSearchItem {
  title: string;
  url: string;
  snippet: string;
}

function webSearchItems(details: unknown): WebSearchItem[] {
  const record = asRecord(details);
  const results = Array.isArray(record?.results) ? record.results : [];
  return results.slice(0, 20).flatMap((item, index) => {
    const result = asRecord(item);
    if (!result) return [];
    const url = textOf(result.url) || textOf(result.link);
    return [
      {
        title:
          textOf(result.title) ||
          textOf(result.name) ||
          url ||
          `#${index + 1}`,
        url,
        snippet:
          textOf(result.content) ||
          textOf(result.summary) ||
          textOf(result.snippet) ||
          textOf(result.description),
      },
    ];
  });
}

function webFetchInfo(details: unknown): {
  title: string;
  content: string;
  links: string[];
} {
  const record = asRecord(details);
  return {
    title: textOf(record?.title),
    content: textOf(record?.content),
    links: Array.isArray(record?.links)
      ? record.links.filter((link): link is string => typeof link === "string")
      : [],
  };
}

function finalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (!message || message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((block) => {
          const record = asRecord(block);
          return record && record.type === "text" ? textOf(record.text) : "";
        })
        .join("");
      if (text) return text;
    }
  }
  return "";
}

interface SubagentUsage {
  turns?: number;
  input?: number;
  output?: number;
  cost?: number;
}

interface SubagentItem {
  agent: string;
  task: string;
  finalOutput: string;
  error: string;
  failed: boolean;
  step?: number;
  usage?: SubagentUsage;
}

function subagentItems(
  args: unknown,
  details: unknown,
): { mode: string; items: SubagentItem[] } {
  const argsRecord = asRecord(args) ?? {};
  const detailsRecord = asRecord(details) ?? {};
  const mode =
    textOf(detailsRecord.mode) ||
    (Array.isArray(argsRecord.tasks)
      ? "parallel"
      : Array.isArray(argsRecord.chain)
        ? "chain"
        : "single");

  const items: SubagentItem[] = [];
  if (Array.isArray(detailsRecord.results)) {
    for (const raw of detailsRecord.results) {
      const result = asRecord(raw);
      if (!result) continue;
      const stop = textOf(result.stopReason);
      const exitCode =
        typeof result.exitCode === "number" ? result.exitCode : 0;
      const error = textOf(result.errorMessage);
      const usage = asRecord(result.usage);
      items.push({
        agent: textOf(result.agent),
        task: textOf(result.task),
        finalOutput: finalAssistantText(result.messages),
        error,
        failed: exitCode !== 0 || !!error || stop === "error" || stop === "aborted",
        step: typeof result.step === "number" ? result.step : undefined,
        usage: usage
          ? {
              turns:
                typeof usage.turns === "number" ? usage.turns : undefined,
              input:
                typeof usage.input === "number" ? usage.input : undefined,
              output:
                typeof usage.output === "number" ? usage.output : undefined,
              cost: typeof usage.cost === "number" ? usage.cost : undefined,
            }
          : undefined,
      });
    }
  }

  if (items.length === 0) {
    const steps =
      mode === "single"
        ? [argsRecord]
        : Array.isArray(argsRecord.tasks)
          ? argsRecord.tasks
          : Array.isArray(argsRecord.chain)
            ? argsRecord.chain
            : [];
    for (const raw of steps) {
      const step = asRecord(raw) ?? {};
      items.push({
        agent: textOf(step.agent),
        task: textOf(step.task),
        finalOutput: "",
        error: "",
        failed: false,
      });
    }
  }

  return { mode, items };
}

function subagentTitleKey(mode: string): TranslationKey {
  if (mode === "parallel") return "tool.subagents";
  if (mode === "chain") return "tool.subagentChain";
  return "tool.subagent";
}

function formatUsage(usage: SubagentUsage, t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(t("tool.turns", { count: usage.turns }));
  if (usage.input != null || usage.output != null) {
    parts.push(`↑${usage.input ?? 0} ↓${usage.output ?? 0}`);
  }
  if (usage.cost != null) parts.push(`$${usage.cost.toFixed(2)}`);
  return parts.join(" · ");
}

function DetailsToggle({
  showDetails,
  onToggle,
}: {
  showDetails: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={onToggle}
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
  );
}

function RawDetails({
  argsStr,
  result,
  effError,
  showDetails,
}: {
  argsStr: string;
  result?: string;
  effError: boolean;
  showDetails: boolean;
}) {
  return (
    <AnimatePresence initial={false}>
      {showDetails && (
        <motion.div
          {...expand}
          transition={PANEL_TRANSITION}
          className="border-t border-border overflow-hidden"
        >
          {argsStr && (
            <pre className="text-muted-foreground bg-background max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
              {argsStr}
            </pre>
          )}
          {result && (
            <pre
              className={`bg-background max-h-80 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed ${
                effError ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {result}
            </pre>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function WebSearchBlock({
  query,
  items,
  resultPreview,
  effError,
  showDetails,
  onToggle,
  argsStr,
  result,
}: {
  query: string;
  items: WebSearchItem[];
  resultPreview: string;
  effError: boolean;
  showDetails: boolean;
  onToggle: () => void;
  argsStr: string;
  result?: string;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const open = async (url: string) => {
    if (!url) return;
    try {
      await openPath(url);
    } catch (error) {
      toast({
        variant: "error",
        title: t("common.openFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
      <div className="px-3 py-2">
        {query && (
          <div className="flex items-baseline gap-2 text-xs">
            <span className="text-subtle-foreground shrink-0">
              {t("tool.query")}
            </span>
            <span className="text-foreground min-w-0 font-medium break-words">
              {query}
            </span>
            {items.length > 0 && (
              <span className="text-subtle-foreground ml-auto shrink-0 text-[10px]">
                {t("tool.results", { count: items.length })}
              </span>
            )}
          </div>
        )}
        {!showDetails && items.length > 0 && (
          <div className="mt-1.5 flex flex-col">
            {items.slice(0, 3).map((item, index) => (
              <button
                key={`${item.url}-${index}`}
                type="button"
                disabled={!item.url}
                onClick={() => open(item.url)}
                className="hover:bg-accent/60 -mx-1 flex flex-col items-start gap-0.5 rounded-md px-1 py-1 text-left transition-colors disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="text-foreground line-clamp-1 text-[11px] font-medium">
                  {item.title}
                  {item.url && (
                    <ArrowUpRight className="text-subtle-foreground ml-1 inline size-3" />
                  )}
                </span>
                {item.url && (
                  <span className="text-subtle-foreground line-clamp-1 font-mono text-[10px]">
                    {item.url}
                  </span>
                )}
                {item.snippet && (
                  <span className="text-muted-foreground line-clamp-2 text-[11px]">
                    {item.snippet}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {!showDetails && items.length === 0 && resultPreview && (
          <div
            className={`mt-1 break-words whitespace-pre-wrap text-[11px] ${
              effError ? "text-destructive" : "text-subtle-foreground"
            }`}
          >
            {effError ? "✗ " : ""}
            {resultPreview}
          </div>
        )}
      </div>
      {(argsStr || result) && (
        <DetailsToggle showDetails={showDetails} onToggle={onToggle} />
      )}
      <RawDetails
        argsStr={argsStr}
        result={result}
        effError={effError}
        showDetails={showDetails}
      />
    </div>
  );
}

function WebFetchBlock({
  url,
  info,
  resultPreview,
  effError,
  showDetails,
  onToggle,
  argsStr,
  result,
}: {
  url: string;
  info: { title: string; content: string; links: string[] };
  resultPreview: string;
  effError: boolean;
  showDetails: boolean;
  onToggle: () => void;
  argsStr: string;
  result?: string;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const open = async () => {
    if (!url) return;
    try {
      await openPath(url);
    } catch (error) {
      toast({
        variant: "error",
        title: t("common.openFailed"),
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
      <div className="px-3 py-2">
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="text-subtle-foreground shrink-0">
            {t("tool.url")}
          </span>
          <button
            type="button"
            onClick={open}
            disabled={!url}
            className="text-primary min-w-0 truncate text-left font-mono hover:underline disabled:text-foreground disabled:no-underline"
          >
            {url || "—"}
          </button>
        </div>
        {info.title && (
          <div className="text-foreground mt-1 text-xs font-medium">
            {info.title}
          </div>
        )}
        {!showDetails && info.content && (
          <p className="text-muted-foreground mt-1 line-clamp-3 text-[11px] whitespace-pre-wrap">
            {info.content}
          </p>
        )}
        {!showDetails && info.links.length > 0 && (
          <p className="text-subtle-foreground mt-1 text-[10px]">
            {t("tool.linksFound", { count: info.links.length })}
          </p>
        )}
        {!showDetails && !info.content && resultPreview && (
          <p
            className={`mt-1 break-words whitespace-pre-wrap text-[11px] ${
              effError ? "text-destructive" : "text-subtle-foreground"
            }`}
          >
            {effError ? "✗ " : ""}
            {resultPreview}
          </p>
        )}
      </div>
      {(argsStr || result) && (
        <DetailsToggle showDetails={showDetails} onToggle={onToggle} />
      )}
      <RawDetails
        argsStr={argsStr}
        result={result}
        effError={effError}
        showDetails={showDetails}
      />
    </div>
  );
}

function SubagentBlock({
  items,
  status,
  effError,
  showDetails,
  onToggle,
  argsStr,
  result,
}: {
  items: SubagentItem[];
  status?: "running" | "success" | "error";
  effError: boolean;
  showDetails: boolean;
  onToggle: () => void;
  argsStr: string;
  result?: string;
}) {
  const { t } = useI18n();
  const running = status === "running";

  return (
    <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
      <div className="flex flex-col gap-1.5 px-3 py-2">
        {items.length === 0 && (
          <p className="text-subtle-foreground text-[11px]">
            {t("tool.noDetails")}
          </p>
        )}
        {items.map((item, index) => {
          const failed = item.failed || (effError && index === items.length - 1);
          return (
            <div key={index} className="flex items-start gap-2">
              <span className="mt-0.5 shrink-0">
                {running ? (
                  <Loader2 className="text-warning size-3 animate-spin" />
                ) : failed ? (
                  <XCircle className="text-destructive size-3" />
                ) : (
                  <CheckCircle2 className="text-success size-3" />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 font-mono text-[10px]">
                    {item.agent || t("tool.agent")}
                  </span>
                  {item.step != null && (
                    <span className="text-subtle-foreground text-[10px]">
                      {t("tool.step", { n: item.step })}
                    </span>
                  )}
                </div>
                {item.task && (
                  <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">
                    {item.task}
                  </p>
                )}
                {item.error && (
                  <p className="text-destructive mt-0.5 text-[11px] break-words">
                    {item.error}
                  </p>
                )}
                {!showDetails && item.finalOutput && (
                  <p className="text-subtle-foreground mt-1 line-clamp-3 text-[11px] whitespace-pre-wrap">
                    {item.finalOutput}
                  </p>
                )}
                {showDetails && item.finalOutput && (
                  <pre className="text-muted-foreground bg-background mt-1 max-h-64 overflow-auto rounded-md px-2 py-1.5 font-mono text-[11px] whitespace-pre-wrap">
                    {item.finalOutput}
                  </pre>
                )}
                {showDetails && item.usage && (
                  <p className="text-subtle-foreground mt-1 text-[10px]">
                    {formatUsage(item.usage, t)}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {(argsStr || result) && (
        <DetailsToggle showDetails={showDetails} onToggle={onToggle} />
      )}
      <RawDetails
        argsStr={argsStr}
        result={result}
        effError={effError}
        showDetails={showDetails}
      />
    </div>
  );
}

// ── Built-in tool rendering (read / grep / find / ls / edit / write) ──

const BUILTIN_TITLE_KEYS: Record<string, TranslationKey> = {
  bash: "tool.runCommand",
  read: "tool.readFile",
  edit: "tool.editFile",
  edit_diff: "tool.editFile",
  write: "tool.writeFile",
  grep: "tool.searchFiles",
  find: "tool.findFiles",
  ls: "tool.listDirectory",
};

const FILE_TOOLS = new Set(["read", "edit", "edit_diff", "write"]);

interface GrepMatch {
  file: string;
  line: string;
  text: string;
  context: boolean;
}

function grepMatches(result?: string): GrepMatch[] {
  if (!result) return [];
  return result.split("\n").flatMap((line) => {
    const match = /^(.*?)([:-])(\d+)\2 (.*)$/.exec(line);
    if (!match) return [];
    return [
      {
        file: match[1],
        line: match[3],
        text: match[4],
        context: match[2] === "-",
      },
    ];
  });
}

function listEntries(result?: string): string[] {
  if (!result) return [];
  return result
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line && !/^\[.*\]$/.test(line));
}

function diffStats(text: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function PathRow({
  path,
  onOpen,
  meta,
}: {
  path: string;
  onOpen?: () => void;
  meta?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="border-border flex items-center gap-2 border-b px-3 py-1.5">
      <span
        className="text-muted-foreground min-w-0 truncate font-mono text-[11px]"
        title={path}
      >
        {path || "—"}
      </span>
      {meta}
      {onOpen && (
        <button
          type="button"
          onClick={onOpen}
          className="text-subtle-foreground hover:text-muted-foreground ml-auto shrink-0 rounded p-0.5 transition-colors"
          title={t("common.openInEditor")}
          aria-label={t("common.openInEditor")}
        >
          <ExternalLink className="size-3" />
        </button>
      )}
    </div>
  );
}

function ReadBlock({
  path,
  result,
  resultPreview,
  effError,
  showDetails,
  onToggle,
  argsStr,
  onOpen,
}: {
  path: string;
  result?: string;
  resultPreview: string;
  effError: boolean;
  showDetails: boolean;
  onToggle: () => void;
  argsStr: string;
  onOpen?: () => void;
}) {
  const lines = result ? result.split("\n") : [];
  const preview = result ? lines.slice(0, 8).join("\n") : resultPreview;
  const more = lines.length > 8;
  return (
    <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
      <PathRow path={path} onOpen={onOpen} />
      {!showDetails && preview && (
        <pre
          className={`max-h-40 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed ${
            effError ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {preview}
          {more ? "\n…" : ""}
        </pre>
      )}
      {(argsStr || result) && (
        <DetailsToggle showDetails={showDetails} onToggle={onToggle} />
      )}
      <RawDetails
        argsStr={argsStr}
        result={result}
        effError={effError}
        showDetails={showDetails}
      />
    </div>
  );
}

function GrepBlock({
  pattern,
  scope,
  result,
  resultPreview,
  effError,
  showDetails,
  onToggle,
  argsStr,
  onOpenFile,
}: {
  pattern: string;
  scope: string;
  result?: string;
  resultPreview: string;
  effError: boolean;
  showDetails: boolean;
  onToggle: () => void;
  argsStr: string;
  onOpenFile: (path: string) => void;
}) {
  const { t } = useI18n();
  const matches = grepMatches(result);
  const matchCount = matches.filter((match) => !match.context).length;
  return (
    <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
      <div className="border-border flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b px-3 py-1.5 text-[11px]">
        {pattern && (
          <>
            <span className="text-subtle-foreground">
              {t("tool.pattern")}
            </span>
            <span className="text-foreground font-mono">{pattern}</span>
          </>
        )}
        {scope && (
          <span
            className="text-subtle-foreground min-w-0 truncate font-mono"
            title={scope}
          >
            {scope}
          </span>
        )}
        {matchCount > 0 && (
          <span className="text-subtle-foreground ml-auto shrink-0 text-[10px]">
            {t("tool.matches", { count: matchCount })}
          </span>
        )}
      </div>
      {!showDetails && matches.length > 0 ? (
        <div className="flex flex-col py-1">
          {matches.slice(0, 6).map((match, index) => (
            <button
              key={`${match.file}-${match.line}-${index}`}
              type="button"
              onClick={() => onOpenFile(match.file)}
              className={`hover:bg-accent/60 flex items-baseline gap-2 px-3 py-0.5 text-left transition-colors ${
                match.context ? "opacity-60" : ""
              }`}
            >
              <span className="text-muted-foreground w-40 shrink-0 truncate font-mono text-[10px]">
                {match.file}
              </span>
              <span className="text-subtle-foreground w-8 shrink-0 text-right font-mono text-[10px] tabular-nums">
                {match.line}
              </span>
              <span className="text-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
                {match.text}
              </span>
            </button>
          ))}
          {matches.length > 6 && (
            <span className="text-subtle-foreground px-3 text-[10px]">…</span>
          )}
        </div>
      ) : (
        !showDetails &&
        resultPreview && (
          <pre
            className={`max-h-40 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed ${
              effError ? "text-destructive" : "text-subtle-foreground"
            }`}
          >
            {resultPreview}
          </pre>
        )
      )}
      {(argsStr || result) && (
        <DetailsToggle showDetails={showDetails} onToggle={onToggle} />
      )}
      <RawDetails
        argsStr={argsStr}
        result={result}
        effError={effError}
        showDetails={showDetails}
      />
    </div>
  );
}

function ListBlock({
  path,
  hint,
  result,
  resultPreview,
  effError,
  showDetails,
  onToggle,
  argsStr,
}: {
  path: string;
  hint?: string;
  result?: string;
  resultPreview: string;
  effError: boolean;
  showDetails: boolean;
  onToggle: () => void;
  argsStr: string;
}) {
  const { t } = useI18n();
  const entries = listEntries(result);
  return (
    <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
      <div className="border-border flex items-center gap-2 border-b px-3 py-1.5">
        <span
          className="text-muted-foreground min-w-0 truncate font-mono text-[11px]"
          title={path}
        >
          {path || "—"}
        </span>
        {hint && (
          <span
            className="text-subtle-foreground min-w-0 truncate font-mono text-[10px]"
            title={hint}
          >
            {hint}
          </span>
        )}
        {entries.length > 0 && (
          <span className="text-subtle-foreground ml-auto shrink-0 text-[10px]">
            {t("tool.entries", { count: entries.length })}
          </span>
        )}
      </div>
      {!showDetails && entries.length > 0 ? (
        <div className="flex flex-col py-1">
          {entries.slice(0, 10).map((entry, index) => (
            <span
              key={`${entry}-${index}`}
              className="text-muted-foreground truncate px-3 py-0.5 font-mono text-[11px]"
              title={entry}
            >
              {entry}
            </span>
          ))}
          {entries.length > 10 && (
            <span className="text-subtle-foreground px-3 text-[10px]">…</span>
          )}
        </div>
      ) : (
        !showDetails &&
        resultPreview && (
          <pre
            className={`max-h-40 overflow-auto px-3 py-2 font-mono text-[11px] leading-relaxed ${
              effError ? "text-destructive" : "text-subtle-foreground"
            }`}
          >
            {resultPreview}
          </pre>
        )
      )}
      {(argsStr || result) && (
        <DetailsToggle showDetails={showDetails} onToggle={onToggle} />
      )}
      <RawDetails
        argsStr={argsStr}
        result={result}
        effError={effError}
        showDetails={showDetails}
      />
    </div>
  );
}

function DiffBlock({
  path,
  diffText,
  truncated,
  showDetails,
  onToggle,
  argsStr,
  result,
  effError,
  onOpen,
}: {
  path: string;
  diffText: string;
  truncated: boolean;
  showDetails: boolean;
  onToggle: () => void;
  argsStr: string;
  result?: string;
  effError: boolean;
  onOpen?: () => void;
}) {
  const stats = diffStats(diffText);
  return (
    <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
      <PathRow
        path={path}
        onOpen={onOpen}
        meta={
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10px]">
            <span className="text-success">+{stats.additions}</span>
            <span className="text-destructive">−{stats.deletions}</span>
          </span>
        }
      />
      <DiffView text={diffText} truncated={truncated} embedded />
      {(argsStr || result) && (
        <DetailsToggle showDetails={showDetails} onToggle={onToggle} />
      )}
      <RawDetails
        argsStr={argsStr}
        result={result}
        effError={effError}
        showDetails={showDetails}
      />
    </div>
  );
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

  const webItems = name === "web_search" ? webSearchItems(details) : [];
  const webFetch = name === "web_fetch" ? webFetchInfo(details) : null;
  const subagent = name === "subagent" ? subagentItems(args, details) : null;
  const title =
    name === "web_search"
      ? t("tool.webSearch")
      : name === "web_fetch"
        ? t("tool.webFetch")
        : subagent
          ? t(subagentTitleKey(subagent.mode))
          : BUILTIN_TITLE_KEYS[name]
            ? t(BUILTIN_TITLE_KEYS[name])
            : name;
  const isFileTool = FILE_TOOLS.has(name);

  const openWorkspaceFile = useCallback(
    async (target: string) => {
      if (!target) return;
      try {
        const cwd = await getActiveSessionCwd();
        await openFile(target, cwd);
      } catch (error) {
        toast({
          variant: "error",
          title: t("common.openFailed"),
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [t, toast],
  );

  return (
    <div className="my-2">
      {/* Header: icon + tool name + status */}
      <div className="flex items-center gap-2 text-sm">
        <span className={`shrink-0 ${st.color}`}>{meta.icon}</span>
        <span
          className="text-muted-foreground font-medium"
          title={title === name ? undefined : name}
        >
          {title}
        </span>
        {isFileTool && filePath && (
          <button
            type="button"
            onClick={() => openWorkspaceFile(filePath)}
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

      {name === "web_search" ? (
        <WebSearchBlock
          query={textOf(argsRecord?.query)}
          items={webItems}
          resultPreview={resultPreview}
          effError={effError}
          showDetails={showDetails}
          onToggle={() => setShowDetails((value) => !value)}
          argsStr={argsStr}
          result={result}
        />
      ) : name === "web_fetch" ? (
        <WebFetchBlock
          url={textOf(argsRecord?.url)}
          info={webFetch ?? { title: "", content: "", links: [] }}
          resultPreview={resultPreview}
          effError={effError}
          showDetails={showDetails}
          onToggle={() => setShowDetails((value) => !value)}
          argsStr={argsStr}
          result={result}
        />
      ) : name === "subagent" && subagent ? (
        <SubagentBlock
          items={subagent.items}
          status={status}
          effError={effError}
          showDetails={showDetails}
          onToggle={() => setShowDetails((value) => !value)}
          argsStr={argsStr}
          result={result}
        />
      ) : name === "bash" ? (
        /* bash: terminal-style block with `$` prompt */
        <div className="border-border bg-muted mt-1 overflow-hidden rounded-lg border">
          <div className="px-3 py-2 font-mono text-[13px] leading-relaxed">
            {summary && (
              <div className="group/cmd flex items-start gap-1">
                <div className="text-foreground min-w-0 flex-1 break-words whitespace-pre-wrap">
                  <span className="text-success select-none">$ </span>
                  {summary}
                </div>
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard?.writeText(summary).catch(() => {})
                  }
                  title={t("tool.copyCommand")}
                  aria-label={t("tool.copyCommand")}
                  className="text-subtle-foreground hover:text-muted-foreground shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover/cmd:opacity-100 focus-visible:opacity-100"
                >
                  <Copy className="size-3" />
                </button>
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
      ) : name === "read" ? (
        <ReadBlock
          path={filePath}
          result={result}
          resultPreview={resultPreview}
          effError={effError}
          showDetails={showDetails}
          onToggle={() => setShowDetails((value) => !value)}
          argsStr={argsStr}
          onOpen={filePath ? () => openWorkspaceFile(filePath) : undefined}
        />
      ) : name === "grep" ? (
        <GrepBlock
          pattern={textOf(argsRecord?.pattern)}
          scope={filePath}
          result={result}
          resultPreview={resultPreview}
          effError={effError}
          showDetails={showDetails}
          onToggle={() => setShowDetails((value) => !value)}
          argsStr={argsStr}
          onOpenFile={openWorkspaceFile}
        />
      ) : name === "find" || name === "ls" ? (
        <ListBlock
          path={filePath}
          hint={name === "find" ? textOf(argsRecord?.pattern) : undefined}
          result={result}
          resultPreview={resultPreview}
          effError={effError}
          showDetails={showDetails}
          onToggle={() => setShowDetails((value) => !value)}
          argsStr={argsStr}
        />
      ) : (name === "edit" || name === "edit_diff" || name === "write") &&
        diff.text ? (
        <DiffBlock
          path={filePath}
          diffText={diff.text}
          truncated={diff.truncated}
          showDetails={showDetails}
          onToggle={() => setShowDetails((value) => !value)}
          argsStr={argsStr}
          result={result}
          effError={effError}
          onOpen={filePath ? () => openWorkspaceFile(filePath) : undefined}
        />
      ) : (
        <>
          {/* Other tools: dimmed one-line summary */}
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
