import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Send,
  Folder,
  Search,
  ArrowUp,
  ArrowDown,
  X,
  Copy,
  Check,
  GitBranch,
  ChevronRight,
  ChevronDown,
  CornerUpLeft,
  MessageSquare,
  Cog,
  Scissors,
  Square,
  Info,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useChat, type ContentBlock } from "@/hooks/useChat";
import { useThreadSearch } from "@/hooks/use-thread-search";
import ToolCallCard from "@/components/ToolCallCard";
import PickModel from "@/components/PickModel";
import type { ModelOption, ProviderInfo } from "@/components/PickModel";
import ThinkingBlock from "@/components/ThinkingBlock";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  cancelCurrentRun,
  fileCompletions,
  getModels,
  getProviders,
  getSessionInfo,
  getSessionModel,
  getSessionTree,
  setSessionModel,
  listSlashCommands,
  navigateSessionTree,
  setSessionCwd,
  type SessionInfo,
  type SessionTreeNode,
} from "@/api/commands";

// ── @ path autocomplete helpers (port of TS autocomplete.ts) ──
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

function findLastDelimiter(text: string): number {
  for (let i = text.length - 1; i >= 0; i -= 1) {
    if (PATH_DELIMITERS.has(text[i] ?? "")) return i;
  }
  return -1;
}

function findUnclosedQuoteStart(text: string): number | null {
  let inQuotes = false;
  let quoteStart = -1;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '"') {
      inQuotes = !inQuotes;
      if (inQuotes) quoteStart = i;
    }
  }
  return inQuotes ? quoteStart : null;
}

function isTokenStart(text: string, index: number): boolean {
  return index === 0 || PATH_DELIMITERS.has(text[index - 1] ?? "");
}

function extractQuotedPrefix(text: string): string | null {
  const quoteStart = findUnclosedQuoteStart(text);
  if (quoteStart === null) return null;
  if (quoteStart > 0 && text[quoteStart - 1] === "@") {
    if (!isTokenStart(text, quoteStart - 1)) return null;
    return text.slice(quoteStart - 1);
  }
  if (!isTokenStart(text, quoteStart)) return null;
  return text.slice(quoteStart);
}

function extractAtPrefix(text: string): string | null {
  const quotedPrefix = extractQuotedPrefix(text);
  if (quotedPrefix?.startsWith('@"')) return quotedPrefix;
  const lastDelimiterIndex = findLastDelimiter(text);
  const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
  if (text[tokenStart] === "@") return text.slice(tokenStart);
  return null;
}

function parsePathPrefix(prefix: string): { rawPrefix: string; isQuotedPrefix: boolean } {
  if (prefix.startsWith('@"')) return { rawPrefix: prefix.slice(2), isQuotedPrefix: true };
  if (prefix.startsWith("@")) return { rawPrefix: prefix.slice(1), isQuotedPrefix: false };
  return { rawPrefix: prefix, isQuotedPrefix: false };
}

interface CompletionItem {
  name: string;
  path: string;
  isDir: boolean;
}

function nodeText(node: React.ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  const maybe = node as { props?: { children?: React.ReactNode } };
  if (maybe && typeof maybe === "object" && maybe.props?.children !== undefined) {
    return nodeText(maybe.props.children);
  }
  return "";
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 flex-1 truncate text-right">{children}</span>
    </div>
  );
}

function CopyButton({
  text,
  className,
  label,
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={copied ? "Copied!" : label ?? "Copy"}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={
        className ??
        "text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
      }
    >
      {copied ? <Check className="size-3.5 text-emerald-500" /> : <Copy className="size-3.5" />}
    </button>
  );
}

const mdComponents: Components = {
  code: ({ className, children, ...props }) => {
    const isInline = !className;
    if (isInline) {
      return (
        <code
          className="bg-bg-hover text-ink rounded px-1 py-0.5 font-mono text-xs"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <div className="group/code relative my-2">
        <pre className="rounded-card border-hairline bg-bg-hover text-ink-muted overflow-x-auto border p-3 pr-10 font-mono text-xs leading-relaxed">
          <code className={className} {...props}>
            {children}
          </code>
        </pre>
        <CopyButton
          text={nodeText(children)}
          className="text-muted-foreground hover:text-foreground absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover/code:opacity-100"
        />
      </div>
    );
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-hairline bg-bg-hover text-ink-muted border-b px-3 py-2 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-hairline text-ink-muted border-b px-3 py-2">
      {children}
    </td>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-ai hover:underline"
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-1 list-disc space-y-1 pl-5">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="my-1 list-decimal space-y-1 pl-5">{children}</ol>
  ),
  hr: () => <hr className="border-hairline my-3" />,
};



const KIND_ICON: Record<string, { icon: React.ReactNode; className: string }> = {
  message: { icon: <MessageSquare className="size-3" />, className: "" },
  model_change: { icon: <Cog className="size-3" />, className: "text-blue-500" },
  thinking_level_change: { icon: <Cog className="size-3" />, className: "text-purple-500" },
  compaction: { icon: <Scissors className="size-3" />, className: "text-amber-500" },
  branch_summary: { icon: <GitBranch className="size-3" />, className: "text-emerald-500" },
  session_info: { icon: <MessageSquare className="size-3" />, className: "text-muted-foreground" },
};

function TreeNode({
  node,
  depth,
  onNavigate,
  collapsed,
  onToggle,
}: {
  node: SessionTreeNode;
  depth: number;
  onNavigate: (id: string) => void;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const meta = KIND_ICON[node.kind] ?? KIND_ICON.session_info;

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors ${
          node.current
            ? "bg-accent/10 text-accent font-medium"
            : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onNavigate(node.id)}
      >
        <span className="flex w-3 shrink-0 justify-center">
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(node.id);
              }}
              className="rounded p-0.5 hover:bg-muted"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
            </button>
          ) : (
            <span className="size-3" />
          )}
        </span>
        <span className={`shrink-0 ${meta.className}`}>{meta.icon}</span>
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        {node.current && (
          <span className="bg-accent text-accent-foreground shrink-0 rounded-full px-1.5 text-[9px]">
            here
          </span>
        )}
      </div>
      {hasChildren && !isCollapsed && (
        <div>
          {node.children.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              onNavigate={onNavigate}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TimelinePanel({
  tree,
  sessionId,
  onClose,
  onTreeChange,
}: {
  tree: SessionTreeNode[];
  sessionId: string;
  onClose: () => void;
  onTreeChange: (tree: SessionTreeNode[]) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const navigate = useCallback(
    async (entryId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const updated = await navigateSessionTree(sessionId, entryId);
        onTreeChange(updated ?? []);
      } catch (e) {
        console.error("[navigate]", e);
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId, onTreeChange],
  );

  return (
    <div className="border-hairline bg-bg-surface flex w-72 shrink-0 flex-col border-l">
      <div className="border-hairline flex items-center gap-2 border-b px-3 py-2">
        <GitBranch className="text-muted-foreground size-3.5" />
        <span className="text-foreground flex-1 text-xs font-medium">
          Timeline
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
          title="Close timeline"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tree.length === 0 ? (
          <p className="text-muted-foreground px-2 py-4 text-center text-xs">
            No timeline yet
          </p>
        ) : (
          tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              onNavigate={navigate}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ))
        )}
        <div className="text-muted-foreground mt-2 flex items-center gap-1.5 px-2 text-[10px]">
          <CornerUpLeft className="size-3" />
          Click a node to jump to that branch point
        </div>
      </div>
    </div>
  );
}

/** Render a single content block. */
function BlockRenderer({ block }: { block: ContentBlock }) {
  switch (block.type) {
    case "text":
      return block.text ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {block.text}
        </ReactMarkdown>
      ) : null;

    case "thinking":
      return <ThinkingBlock thinking={block.thinking} />;

    case "toolCall":
      return (
        <ToolCallCard
          name={block.name ?? "tool"}
          args={block.arguments}
          status={block.status}
          result={block.result}
          isError={block.isError}
        />
      );

    case "image":
      return (
        <div className="my-2">
          <img
            src={block.text ?? block.arguments?.data ?? ""}
            alt=""
            className="max-h-64 rounded-lg border"
          />
        </div>
      );

    default:
      return null;
  }
}

export default function ChatView() {
  const {
    messages,
    sessions,
    sendMessage,
    streaming,
    loading,
    activeSessionId,
    activeSessionCwd,
  } = useChat();
  const [input, setInput] = useState("");
  const [showSlash, setShowSlash] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [timelineTree, setTimelineTree] = useState<SessionTreeNode[]>([]);
  const [modelList, setModelList] = useState<ModelOption[]>([]);
  const [providerList, setProviderList] = useState<ProviderInfo[]>([]);
  const [currentProvider, setCurrentProvider] = useState("");
  const [currentModel, setCurrentModel] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPrefix, setMentionPrefix] = useState("");
  const [mentionQuoted, setMentionQuoted] = useState(false);
  const [mentionFiles, setMentionFiles] = useState<CompletionItem[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommand[]>([]);

  interface SlashCommand {
    name: string;
    description?: string | null;
    argumentHint?: string | null;
    source: string;
  }

  const refreshSlashCommands = useCallback(async () => {
    try {
      setSlashCommands(((await listSlashCommands()) ?? []) as SlashCommand[]);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshSlashCommands();
  }, [refreshSlashCommands]);

  const refreshModelPicker = useCallback(async () => {
    try {
      const [prov, mods, cur] = await Promise.all([
        getProviders(),
        getModels(),
        getSessionModel(),
      ]);
      setProviderList(prov.providers as ProviderInfo[]);
      setModelList(mods.models as ModelOption[]);
      setCurrentProvider(cur.provider ?? "");
      setCurrentModel(cur.modelId ?? "");
    } catch (e) {
      console.error("[model picker]", e);
    }
  }, []);

  useEffect(() => {
    refreshModelPicker();
  }, [refreshModelPicker, activeSessionId]);

  const handleModelSelect = useCallback(
    async (provider: string, modelId: string) => {
      setModelOpen(false);
      try {
        await setSessionModel(provider, modelId);
        setCurrentProvider(provider);
        setCurrentModel(modelId);
      } catch (e) {
        console.error("[setSessionModel]", e);
      }
    },
    [],
  );

  const toggleInfo = useCallback(async () => {
    setInfoOpen((prev) => {
      const next = !prev;
      if (next && activeSessionId) {
        getSessionInfo(activeSessionId)
          .then((info) => setSessionInfo(info))
          .catch(() => setSessionInfo(null));
      }
      return next;
    });
  }, [activeSessionId]);

  const toggleTimeline = useCallback(async () => {
    setShowTimeline((prev) => {
      const next = !prev;
      if (next && activeSessionId) {
        getSessionTree(activeSessionId)
          .then((t) => setTimelineTree(t ?? []))
          .catch(() => setTimelineTree([]));
      }
      return next;
    });
  }, [activeSessionId]);
  const [mentionStart, setMentionStart] = useState(-1);
  const mentionForcedRef = useRef(false);
  const [showArgMenu, setShowArgMenu] = useState(false);
  const [argCmd, setArgCmd] = useState<"model" | "login">("model");
  const [argStart, setArgStart] = useState(0);
  const [argPrefix, setArgPrefix] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevInputRef = useRef("");

  // Scroll to bottom when switching sessions. The `key` on the container forces
  // a re-mount, and the ref callback runs after the DOM is committed.
  const scrollRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const threadSearch = useThreadSearch(timelineRef);

  // Cmd/Ctrl+F opens in-chat search; Esc closes it (the hook handles cleanup)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        threadSearch.open();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const ta = textareaRef.current;
        if (ta) {
          ta.focus();
          const pos = ta.value.length;
          ta.setSelectionRange(pos, pos);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [threadSearch]);

  // @ mention / Tab file completion — live workspace lookup (debounced)
  useEffect(() => {
    if (!showMention) {
      setMentionFiles([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        const items = await fileCompletions(activeSessionCwd, mentionQuery);
        setMentionFiles((items ?? []) as CompletionItem[]);
      } catch {
        setMentionFiles([]);
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [showMention, mentionQuery, activeSessionCwd]);

  const insertAtCursor = useCallback(
    (text: string, start?: number, end?: number) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const s = start ?? ta.selectionStart;
      const e = end ?? ta.selectionEnd;
      const before = input.slice(0, s);
      const after = input.slice(e);
      const newVal = before + text + after;
      setInput(newVal);
      prevInputRef.current = newVal;
      // Move cursor after inserted text
      requestAnimationFrame(() => {
        const pos = s + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      });
    },
    [input],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const prev = prevInputRef.current;
      prevInputRef.current = val;
      setInput(val);

      const cursorPos = e.target.selectionStart ?? val.length;
      const textBeforeCursor = val.slice(0, cursorPos);

      // Detect @ mention trigger (or continue a Tab-forced path completion)
      const atPrefix = extractAtPrefix(textBeforeCursor);
      let prefix: string | null = null;
      let quoted = false;
      if (atPrefix) {
        prefix = atPrefix;
        quoted = atPrefix.startsWith('@"');
      } else if (showMention && mentionForcedRef.current) {
        const q = extractQuotedPrefix(textBeforeCursor);
        if (q) {
          prefix = q;
          quoted = q.startsWith('"');
        } else {
          const lastDelimiterIndex = findLastDelimiter(textBeforeCursor);
          const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
          prefix = textBeforeCursor.slice(tokenStart);
          quoted = false;
        }
      }
      if (prefix !== null) {
        const { rawPrefix } = parsePathPrefix(prefix);
        setMentionPrefix(prefix);
        setMentionQuery(rawPrefix);
        setMentionQuoted(quoted);
        setMentionStart(textBeforeCursor.length - prefix.length);
        setShowMention(true);
      } else if (showMention) {
        setShowMention(false);
      }

      // Detect /command <arg> argument completion (builtin model/login)
      const argMatch = textBeforeCursor.match(/^\/(model|login)\s+([\w./:-]*)$/);
      if (argMatch) {
        const cmd = argMatch[1] as "model" | "login";
        const argPrefixText = argMatch[2];
        setArgCmd(cmd);
        setArgStart(("/" + cmd + " ").length);
        setArgPrefix(argPrefixText);
        setShowArgMenu(true);
      } else if (showArgMenu) {
        setShowArgMenu(false);
      }

      // Detect / slash trigger — only when `val` starts with `/` and `prev` didn't
      if (val.startsWith("/") && !prev.startsWith("/")) {
        setShowSlash(true);
      } else if (showSlash && val.includes(" ")) {
        // A command name + space means the user is past command selection.
        setShowSlash(false);
      } else if (!val.startsWith("/")) {
        setShowSlash(false);
      }
    },
    [showMention, showSlash],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;
    setInput("");
    prevInputRef.current = "";
    await sendMessage(text);
  }, [input, streaming, sendMessage]);

  const handleStop = useCallback(async () => {
    try {
      await cancelCurrentRun();
    } catch (e) {
      console.error("[cancelCurrentRun]", e);
    }
  }, []);

  const handlePickFolder = useCallback(async () => {
    if (!activeSessionId) return;
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string" || !selected) return;
    try {
      await setSessionCwd(activeSessionId, selected);
    } catch (e) {
      console.error("[setSessionCwd]", e);
    }
  }, [activeSessionId]);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      if (e.key === "Tab") {
        const ta = textareaRef.current;
        if (!ta) return;
        const textBeforeCursor = ta.value.slice(0, ta.selectionStart);
        const atPrefix = extractAtPrefix(textBeforeCursor);
        let prefix: string | null = null;
        let quoted = false;
        if (atPrefix) {
          prefix = atPrefix;
          quoted = atPrefix.startsWith('@"');
        } else if (!streaming) {
          // Force file completion at the current token (TS shouldTriggerFileCompletion).
          const q = extractQuotedPrefix(textBeforeCursor);
          if (q) {
            prefix = q;
            quoted = q.startsWith('"');
          } else {
            const lastDelimiterIndex = findLastDelimiter(textBeforeCursor);
            const tokenStart = lastDelimiterIndex === -1 ? 0 : lastDelimiterIndex + 1;
            const token = textBeforeCursor.slice(tokenStart);
            if (token !== "" || textBeforeCursor.endsWith(" ")) {
              prefix = token;
            }
          }
        }
        if (prefix !== null) {
          e.preventDefault();
          mentionForcedRef.current = true;
          const { rawPrefix } = parsePathPrefix(prefix);
          setMentionPrefix(prefix);
          setMentionQuery(rawPrefix);
          setMentionQuoted(quoted);
          setMentionStart(textBeforeCursor.length - prefix.length);
          setShowMention(true);
        }
      }
    },
    [handleSend, streaming],
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommand) => {
      insertAtCursor(`/${cmd.name} `);
      setShowSlash(false);
    },
    [insertAtCursor],
  );

  const argItems = useMemo(() => {
    const q = argPrefix.trim().toLowerCase();
    if (argCmd === "model") {
      return modelList
        .filter(
          (m) =>
            !q ||
            `${m.providerId}/${m.modelId}`.toLowerCase().includes(q) ||
            m.label.toLowerCase().includes(q),
        )
        .slice(0, 15)
        .map((m) => ({
          value: `${m.providerId}/${m.modelId}`,
          label: m.modelId,
          description: m.providerId,
        }));
    }
    return providerList
      .filter(
        (p) => !q || p.id.toLowerCase().includes(q) || p.name.toLowerCase().includes(q),
      )
      .slice(0, 15)
      .map((p) => ({ value: p.id, label: p.id, description: p.name }));
  }, [argCmd, argPrefix, modelList, providerList]);

  const handleArgSelect = useCallback(
    (value: string) => {
      insertAtCursor(value, argStart, argStart + argPrefix.length);
      setShowArgMenu(false);
    },
    [argStart, argPrefix, insertAtCursor],
  );

  const handleMentionSelect = useCallback(
    (item: CompletionItem) => {
      const needsQuotes = mentionQuoted || item.path.includes(" ");
      const base = needsQuotes ? `@"${item.path}"` : `@${item.path}`;
      const end = mentionStart + mentionPrefix.length;
      if (item.isDir) {
        // Directory continuation: insert with trailing slash, keep menu open
        // so the next token is scoped inside the directory (matches TS).
        insertAtCursor(`${base}/`, mentionStart, end);
      } else {
        insertAtCursor(`${base} `, mentionStart, end);
        setShowMention(false);
      }
    },
    [mentionStart, mentionPrefix, mentionQuoted, insertAtCursor],
  );

  const activeTitle =
    sessions.find((s) => s.id === activeSessionId)?.title || "";

  const isEmpty = messages.length === 0;

  return (
    <div className="flex size-full flex-col">
      {/* Header */}
      <div className="border-hairline bg-bg-surface flex shrink-0 items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="shrink-0" />
        <div className="text-ink-muted flex min-w-0 shrink items-center gap-1.5 text-xs whitespace-nowrap">
          <span className="font-medium text-foreground">
            {activeTitle || "pi-gui"}
          </span>
          {activeSessionCwd && (
            <span className="text-muted-foreground hidden truncate font-mono text-[11px] md:inline">
              · {activeSessionCwd.split("/").filter(Boolean).pop()}
            </span>
          )}
        </div>
        <Popover open={modelOpen} onOpenChange={setModelOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!activeSessionId}
              className="text-muted-foreground hover:text-foreground inline-flex max-w-[220px] items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] transition-colors disabled:opacity-40"
              title="Select model"
            >
              <span className="truncate">
                {currentProvider && currentModel
                  ? `${currentProvider}/${currentModel}`
                  : "select model"}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-80 p-2">
            <PickModel
              models={modelList}
              providers={providerList}
              providerId={currentProvider || undefined}
              modelId={currentModel || undefined}
              onSelect={handleModelSelect}
            />
          </PopoverContent>
        </Popover>
        <Popover open={infoOpen} onOpenChange={setInfoOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!activeSessionId}
              onClick={toggleInfo}
              className="text-muted-foreground hover:text-foreground rounded-md p-1 transition-colors disabled:opacity-40"
              title="Session info"
            >
              <Info className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 p-0">
            {sessionInfo && (
              <div className="flex flex-col gap-2 p-3 text-xs">
                <div className="text-foreground truncate text-sm font-medium">
                  {sessionInfo.title || "Untitled"}
                </div>
                <InfoRow label="Session ID">
                  <button
                    type="button"
                    className="text-muted-foreground hover:text-foreground truncate font-mono transition-colors"
                    title="Copy session ID"
                    onClick={() => {
                      navigator.clipboard?.writeText(sessionInfo.id).catch(() => {});
                    }}
                  >
                    {sessionInfo.id}
                  </button>
                </InfoRow>
                {sessionInfo.cwd && (
                  <InfoRow label="Working directory">
                    <span className="text-muted-foreground truncate font-mono">
                      {sessionInfo.cwd}
                    </span>
                  </InfoRow>
                )}
                {sessionInfo.sessionFile && (
                  <InfoRow label="Session file">
                    <span className="text-muted-foreground truncate font-mono">
                      {sessionInfo.sessionFile}
                    </span>
                  </InfoRow>
                )}
                <InfoRow label="Messages">
                  <span className="text-muted-foreground">
                    {sessionInfo.messageCount ?? 0}
                  </span>
                </InfoRow>
                {sessionInfo.model?.provider && sessionInfo.model.modelId && (
                  <InfoRow label="Model">
                    <span className="text-muted-foreground font-mono">
                      {sessionInfo.model.provider}/{sessionInfo.model.modelId}
                    </span>
                  </InfoRow>
                )}
                {sessionInfo.createdAt && (
                  <InfoRow label="Created">
                    <span className="text-muted-foreground">
                      {new Date(sessionInfo.createdAt).toLocaleString()}
                    </span>
                  </InfoRow>
                )}
              </div>
            )}
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={toggleTimeline}
          disabled={!activeSessionId}
          className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-40 ${
            showTimeline
              ? "bg-accent/10 text-accent"
              : "text-muted-foreground hover:text-foreground"
          }`}
          title="Toggle session timeline"
        >
          <GitBranch className="size-3.5" />
          Timeline
        </button>
      </div>

      {/* Messages or empty state */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            key={activeSessionId}
          ref={(el) => {
            timelineRef.current = el;
            scrollRef(el);
          }}
          className="timeline relative flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
        >
          {threadSearch.isOpen && (
            <div className="bg-popover border-hairline absolute top-3 right-3 z-40 flex items-center gap-1.5 rounded-lg border px-2 py-1.5 shadow-md">
              <Search className="text-muted-foreground size-3.5" />
              <input
                ref={threadSearch.inputRef}
                value={threadSearch.query}
                onChange={(e) => threadSearch.search(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    threadSearch.goToMatch(e.shiftKey ? -1 : 1);
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    threadSearch.close();
                  }
                }}
                placeholder="Find in chat…"
                className="h-6 w-40 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
              <span className="text-muted-foreground min-w-[2.5rem] text-center font-mono text-[10px]">
                {threadSearch.matchCount === 0
                  ? "0/0"
                  : `${threadSearch.activeIndex + 1}/${threadSearch.matchCount}`}
              </span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
                onClick={() => threadSearch.goToMatch(-1)}
                title="Previous match (Shift+Enter)"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
                onClick={() => threadSearch.goToMatch(1)}
                title="Next match (Enter)"
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
                onClick={() => threadSearch.close()}
                title="Close (Esc)"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {isEmpty ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="max-w-[500px] text-center">
                <h2 className="mb-2 text-2xl font-medium text-foreground">
                  AI 编程助手
                </h2>
                <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
                  Start a conversation with your AI coding assistant. Ask
                  questions, request code reviews, or discuss architecture.
                </p>
                <div className="border-hairline bg-bg-surface mx-auto inline-flex flex-col items-start gap-1.5 rounded-lg border px-4 py-3 text-left text-xs text-muted-foreground">
                  <span className="text-foreground text-xs font-medium">
                    Quick tips
                  </span>
                  <span>
                    <kbd className="bg-bg-hover rounded px-1 font-mono">/</kbd>{" "}
                    Slash commands for specific tasks
                  </span>
                  <span>
                    <kbd className="bg-bg-hover rounded px-1 font-mono">@</kbd>{" "}
                    Reference files in your workspace
                  </span>
                  <span>
                    <kbd className="bg-bg-hover rounded px-1 font-mono">
                      Enter
                    </kbd>{" "}
                    Send ·{" "}
                    <kbd className="bg-bg-hover rounded px-1 font-mono">
                      Shift+Enter
                    </kbd>{" "}
                    New line
                  </span>
                </div>
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isLastAi =
                msg.role === "assistant" && idx === messages.length - 1;
              return (
                <div
                  key={msg.id}
                  className={`group flex max-w-[820px] gap-3 ${msg.role === "user" ? "flex-row-reverse self-end" : ""}`}
                >
                  <span
                    className={`flex size-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                      msg.role === "user"
                        ? "bg-ai text-white"
                        : "bg-bg-hover text-foreground"
                    }`}
                  >
                    {msg.role === "user" ? "U" : "AI"}
                  </span>
                  <div
                    className={`relative rounded-xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-ink-dim max-w-[70%] rounded-tr-sm text-foreground"
                        : "border-hairline bg-bg-surface rounded-tl-sm border text-foreground/80"
                    }`}
                  >
                    <CopyButton
                      text={msg.content}
                      className="text-muted-foreground hover:text-foreground absolute -top-1 right-1 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
                    />
                    {msg.role === "assistant" ? (
                      msg.blocks.length > 0 ? (
                        msg.blocks.map((block, bi) => (
                          <BlockRenderer
                            key={`${msg.id}-b${bi}`}
                            block={block}
                          />
                        ))
                      ) : streaming && isLastAi ? (
                        <div className="flex gap-1 py-1">
                          <span className="bg-muted-foreground size-1.5 animate-pulse rounded-full" />
                          <span
                            className="bg-muted-foreground size-1.5 animate-pulse rounded-full"
                            style={{ animationDelay: "0.2s" }}
                          />
                          <span
                            className="bg-muted-foreground size-1.5 animate-pulse rounded-full"
                            style={{ animationDelay: "0.4s" }}
                          />
                        </div>
                      ) : null
                    ) : (
                      msg.content
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Slash command dialog */}
        <CommandDialog
          open={showSlash}
          onOpenChange={(open) => {
            if (!open) {
              setShowSlash(false);
              requestAnimationFrame(() => textareaRef.current?.focus());
            }
          }}
        >
          <Command>
            <CommandInput placeholder="Search commands..." />
            <CommandList>
              <CommandEmpty>No matching commands</CommandEmpty>
              {(["builtin", "extension", "prompt", "skill"] as const).map(
                (source) => {
                  const group = slashCommands.filter((c) => c.source === source);
                  if (group.length === 0) return null;
                  return (
                    <CommandGroup
                      key={source}
                      heading={
                        source === "builtin"
                          ? "Builtin"
                          : source === "extension"
                            ? "Extensions"
                            : source === "prompt"
                              ? "Prompts"
                              : "Skills"
                      }
                    >
                      {group.map((cmd) => (
                        <CommandItem
                          key={`${source}:${cmd.name}`}
                          onSelect={() => handleSlashSelect(cmd)}
                        >
                          <span className="flex-1 truncate font-medium">
                            /{cmd.name}
                          </span>
                          {cmd.argumentHint && (
                            <span className="text-muted-foreground font-mono text-[10px]">
                              {cmd.argumentHint}
                            </span>
                          )}
                          <span className="text-muted-foreground ml-auto max-w-[220px] truncate text-[10px]">
                            {cmd.description}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  );
                },
              )}
            </CommandList>
          </Command>
        </CommandDialog>

        {/* Working directory picker */}
        <div className="border-hairline bg-bg-surface shrink-0 border-t px-4 pt-2">
          <button
            type="button"
            onClick={handlePickFolder}
            disabled={!activeSessionId}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50"
            title={activeSessionCwd ?? "选择工作目录"}
          >
            <Folder className="size-3.5" />
            <span className="max-w-[260px] truncate">
              {activeSessionCwd
                ? (activeSessionCwd.split("/").filter(Boolean).pop() ??
                  activeSessionCwd)
                : "选择工作目录"}
            </span>
          </button>
        </div>
        {/* Composer */}
        <div className="border-hairline bg-bg-surface shrink-0 border-t px-4 py-2">
          <div className="relative mx-auto max-w-[820px]">
            {/* @ mention / file completion popover */}
            {showMention && (
              <div className="bg-popover border-hairline absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-lg border p-1 shadow-md">
                {mentionFiles.length === 0 ? (
                  <div className="text-muted-foreground px-3 py-2 text-xs">
                    No files found
                  </div>
                ) : (
                  mentionFiles.map((f) => (
                    <button
                      key={f.path}
                      className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors"
                      onClick={() => handleMentionSelect(f)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      {f.isDir ? (
                        <Folder className="text-ai size-3.5 shrink-0" />
                      ) : (
                        <svg
                          className="text-muted-foreground size-3 shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      )}
                      <span className="min-w-0 flex-1 truncate">
                        {f.name}
                        {f.isDir ? "/" : ""}
                      </span>
                      <span className="text-muted-foreground/70 max-w-[50%] truncate font-mono text-[10px]">
                        {f.path}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* /command argument completion popover */}
            {showArgMenu && (
              <div className="bg-popover border-hairline absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-lg border p-1 shadow-md">
                {argItems.length === 0 ? (
                  <div className="text-muted-foreground px-3 py-2 text-xs">
                    No matching {argCmd === "model" ? "models" : "providers"}
                  </div>
                ) : (
                  argItems.map((item) => (
                    <button
                      key={item.value}
                      className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors"
                      onClick={() => handleArgSelect(item.value)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono">
                        {item.label}
                      </span>
                      <span className="text-muted-foreground/70 truncate text-[10px]">
                        {item.description}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            <Textarea
              ref={textareaRef}
              value={input}
              onChange={onInputChange}
              onKeyDown={onInputKeyDown}
              placeholder="Ask anything...  (/ for commands, @ to reference files)"
              disabled={loading}
              className="max-h-[120px] min-h-[44px] resize-none pr-12 text-sm"
              rows={1}
            />
            {streaming ? (
              <Button
                size="icon"
                variant="secondary"
                className="absolute right-1.5 bottom-1.5 size-8"
                onClick={handleStop}
                title="Stop generating"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="absolute right-1.5 bottom-1.5 size-8"
                onClick={handleSend}
                disabled={!input.trim()}
                title="Send"
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
        </div>
        </div>
        {showTimeline && activeSessionId && (
          <TimelinePanel
            tree={timelineTree}
            sessionId={activeSessionId}
            onClose={() => setShowTimeline(false)}
            onTreeChange={setTimelineTree}
          />
        )}
      </div>
    </div>
  );
}
