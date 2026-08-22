import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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
  ShieldCheck,
  ShieldX,
  TerminalSquare,
  Paperclip,
  AlertCircle,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Components } from "react-markdown";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { useChat, type ContentBlock, type DisplayMessage } from "@/hooks/useChat";
import { useThreadSearch } from "@/hooks/use-thread-search";
import { useToast } from "@/components/ui/toast";
import type { ComposerImage } from "@/api/commands";
import ToolCallCard from "@/components/ToolCallCard";
import PickModel from "@/components/PickModel";
import TerminalDock from "@/components/TerminalDock";
import type { ModelOption, ProviderInfo } from "@/components/PickModel";
import ThinkingBlock from "@/components/ThinkingBlock";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  compactSession,
  exportSession,
  fileCompletions,
  forkSessionAt,
  getProjectTrust,
  importSession,
  reloadSession,
  setProjectTrust,
  getModels,
  getProviders,
  getSessionInfo,
  getSessionModel,
  getSessionTree,
  setSessionModel,
  listSlashCommands,
  navigateSessionTree,
  renameSession,
  setSessionCwd,
  cloneSession,
  shareSession,
  type SessionInfo,
  type SessionTreeNode,
} from "@/api/commands";

// ── Attachment helpers ────────────────────────────────────────

const MAX_ATTACHMENTS = 4;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** Read a File into a ComposerImage (raw base64 + mimeType). */
function fileToComposerImage(file: File): Promise<ComposerImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      // result is `data:<mime>;base64,<data>` — strip the prefix.
      const comma = result.indexOf(",");
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      const mimeMatch = result.match(/^data:([^;,]+)/);
      resolve({
        data,
        mimeType: file.type || mimeMatch?.[1] || "image/png",
      });
    };
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

function imageDataUrl(block: ContentBlock): string {
  if (block.data) {
    return block.data.startsWith("data:")
      ? block.data
      : `data:${block.mimeType || "image/png"};base64,${block.data}`;
  }
  return block.text ?? block.arguments?.data ?? "";
}

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
    // react-markdown v9 does not pass an `inline` prop. A fenced block without
    // a language has no className either, so fall back to a newline check to
    // distinguish block code from inline code. Block code is wrapped by the
    // `pre` component below (no nested <pre> here).
    const text = nodeText(children);
    const isInline = !className && !text.includes("\n");
    if (isInline) {
      return (
        <code
          className="bg-codex-inset text-codex-text rounded-md px-1.5 py-0.5 font-mono text-[12px]"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <div className="group/code relative my-2">
      <pre className="text-codex-dim border-codex-border bg-codex-inset overflow-x-auto rounded-lg border p-3 pr-10 font-mono text-xs leading-relaxed">
        {children}
      </pre>
      <CopyButton
        text={nodeText(children)}
        className="text-codex-faint hover:text-codex-dim absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover/code:opacity-100"
      />
    </div>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs">
        {children}
      </table>
    </div>
  ),
  th: ({ children }) => (
    <th className="text-codex-dim border-codex-border border-b bg-codex-inset px-3 py-2 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="text-codex-dim border-codex-border border-b px-3 py-2">
      {children}
    </td>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-codex-green hover:underline"
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
  h1: ({ children }) => <h1 className="mt-3 mb-1 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-sm font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-medium">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-medium">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-1 text-xs font-medium">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-1 text-xs font-medium">{children}</h6>,
  p: ({ children }) => <p className="my-1.5">{children}</p>,
  hr: () => <hr className="border-codex-border my-3" />,
};



const KIND_ICON: Record<string, { icon: React.ReactNode; className: string }> = {
  message: { icon: <MessageSquare className="size-3" />, className: "" },
  model_change: { icon: <Cog className="size-3" />, className: "text-blue-500" },
  thinking_level_change: { icon: <Cog className="size-3" />, className: "text-purple-500" },
  compaction: { icon: <Scissors className="size-3" />, className: "text-amber-500" },
  branch_summary: { icon: <GitBranch className="size-3" />, className: "text-emerald-500" },
  session_info: { icon: <MessageSquare className="size-3" />, className: "text-codex-faint" },
};

function TreeNode({
  node,
  depth,
  onNavigate,
  onFork,
  collapsed,
  onToggle,
}: {
  node: SessionTreeNode;
  depth: number;
  onNavigate: (id: string) => void;
  onFork: (id: string) => void;
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
            ? "bg-codex-green/10 text-codex-green font-medium"
            : "text-codex-faint hover:bg-codex-panel-2 hover:text-codex-dim"
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
              className="hover:bg-codex-panel-3 rounded p-0.5"
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
        <span className="text-codex-dim min-w-0 flex-1 truncate">
          {node.label}
        </span>
        {node.current && (
          <span className="bg-codex-green text-white shrink-0 rounded-full px-1.5 text-[9px]">
            here
          </span>
        )}
        <button
          type="button"
          title="Fork session at this point"
          onClick={(e) => {
            e.stopPropagation();
            onFork(node.id);
          }}
          className="text-codex-faint hover:text-codex-green shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <GitBranch className="size-3" />
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <div>
          {node.children.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              onNavigate={onNavigate}
              onFork={onFork}
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
  onFork,
}: {
  tree: SessionTreeNode[];
  sessionId: string;
  onClose: () => void;
  onTreeChange: (tree: SessionTreeNode[]) => void;
  onFork: (id: string) => void;
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
    <div className="border-codex-border bg-white flex w-72 shrink-0 flex-col border-l">
      <div className="border-codex-border flex items-center gap-2 border-b px-3 py-2">
        <GitBranch className="text-codex-faint size-3.5" />
        <span className="text-codex-text flex-1 text-xs font-medium">
          Timeline
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-codex-faint hover:text-codex-dim rounded p-0.5 transition-colors"
          title="Close timeline"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tree.length === 0 ? (
          <p className="text-codex-faint px-2 py-4 text-center text-xs">
            No timeline yet
          </p>
        ) : (
          tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              onNavigate={navigate}
              onFork={onFork}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ))
        )}
        <div className="text-codex-faint mt-2 flex items-center gap-1.5 px-2 text-[10px]">
          <CornerUpLeft className="size-3" />
          Click a node to jump to that branch point
        </div>
      </div>
    </div>
  );
}

/** Render a single content block. Memoized: unchanged block references skip
 *  re-render entirely, so a text_delta only re-renders the affected block.
 *  Text is rendered progressively (real-time markdown, like ChatGPT/Claude). */
const BlockRenderer = memo(function BlockRenderer({
  block,
}: {
  block: ContentBlock;
}) {
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
            src={imageDataUrl(block)}
            alt=""
            className="border-codex-border max-h-64 rounded-md border"
          />
        </div>
      );

    default:
      return null;
  }
});

/** A single transcript message. Memoized: during streaming only the last
 *  assistant message's props change (new blocks), so all other messages skip
 *  re-rendering entirely. */
const MessageItem = memo(function MessageItem({
  msg,
  streaming,
  isLast,
}: {
  msg: DisplayMessage;
  streaming: boolean;
  isLast: boolean;
}) {
  const isLastAi = msg.role === "assistant" && isLast;
  return (
    <div
      {...(isLast ? { "data-msg-last": "true" } : {})}
      className="group w-full max-w-[820px]"
    >
      {msg.role === "user" ? (
        /* Codex desktop: user prompt in a subtle neutral box, full width */
        <div className="border-codex-border bg-codex-panel relative rounded-lg border px-4 py-3 text-[15px] leading-relaxed text-codex-text">
          <CopyButton
            text={msg.content}
            className="text-codex-faint hover:text-codex-dim absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
          />
          <div className="break-words whitespace-pre-wrap">{msg.content}</div>
          {msg.blocks
            .filter((b) => b.type === "image")
            .map((b, bi) => (
              <img
                key={`${msg.id}-img${bi}`}
                src={imageDataUrl(b)}
                alt=""
                className="border-codex-border mt-2 max-h-48 rounded-lg border"
              />
            ))}
        </div>
      ) : msg.errorMessage ? (
        <div className="border-red-200 bg-red-50 relative flex items-start gap-2 rounded-lg border px-4 py-3 text-sm text-red-600">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 break-words whitespace-pre-wrap">
            {msg.errorMessage}
          </div>
        </div>
      ) : (
        /* Codex web: assistant answers are plain markdown, no bubble */
        <div className="text-codex-text relative text-[15px] leading-relaxed">
          <CopyButton
            text={msg.content}
            className="text-codex-faint hover:text-codex-dim absolute -top-1 right-1 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
          />
          {msg.blocks.length > 0 ? (
            msg.blocks.map((block, bi) => (
              <BlockRenderer key={`${msg.id}-b${bi}`} block={block} />
            ))
          ) : streaming && isLastAi ? (
            <span className="text-codex-faint inline-block animate-pulse">▍</span>
          ) : null}
        </div>
      )}
    </div>
  );
});

export default function ChatView({
  onOpenSettings,
}: {
  onOpenSettings?: () => void;
}) {
  const {
    messages,
    sessions,
    createSession,
    selectSession,
    sendMessage,
    stop,
    streaming,
    loading,
    activeSessionId,
    activeSessionCwd,
  } = useChat();
  const { toast } = useToast();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerImage[]>([]);
  const [attachmentNames, setAttachmentNames] = useState<string[]>([]);
  const [showSlash, setShowSlash] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [timelineTree, setTimelineTree] = useState<SessionTreeNode[]>([]);
  const [modelList, setModelList] = useState<ModelOption[]>([]);
  const [providerList, setProviderList] = useState<ProviderInfo[]>([]);
  const [currentProvider, setCurrentProvider] = useState("");
  const [currentModel, setCurrentModel] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [trustOpen, setTrustOpen] = useState(false);
  const [trustInfo, setTrustInfo] = useState<{
    cwd: string;
    decision: boolean | null;
  } | null>(null);
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

  // Per-session composer drafts (survive session switches and restarts).
  useEffect(() => {
    if (!activeSessionId) {
      setInput("");
      prevInputRef.current = "";
      return;
    }
    try {
      const draft = localStorage.getItem(`pi-gui:draft:${activeSessionId}`);
      setInput(draft ?? "");
      prevInputRef.current = draft ?? "";
    } catch {
      setInput("");
    }
  }, [activeSessionId]);

  const saveDraft = useCallback((sessionId: string | null, value: string) => {
    if (!sessionId) return;
    try {
      if (value.trim()) localStorage.setItem(`pi-gui:draft:${sessionId}`, value);
      else localStorage.removeItem(`pi-gui:draft:${sessionId}`);
    } catch {
      /* ignore */
    }
  }, []);

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

  const toggleInfo = useCallback(() => {
    setInfoOpen((prev) => !prev);
  }, []);

  useEffect(() => {
    if (infoOpen && activeSessionId) {
      getSessionInfo(activeSessionId)
        .then((info) => setSessionInfo(info))
        .catch(() => setSessionInfo(null));
    }
  }, [infoOpen, activeSessionId]);

  const toggleTimeline = useCallback(() => {
    setShowTimeline((prev) => !prev);
  }, []);

  useEffect(() => {
    if (showTimeline && activeSessionId) {
      getSessionTree(activeSessionId)
        .then((t) => setTimelineTree(t ?? []))
        .catch(() => setTimelineTree([]));
    }
  }, [showTimeline, activeSessionId]);
  const [mentionStart, setMentionStart] = useState(-1);
  const mentionForcedRef = useRef(false);
  const [showArgMenu, setShowArgMenu] = useState(false);
  const [argCmd, setArgCmd] = useState<"model" | "login">("model");
  const [argStart, setArgStart] = useState(0);
  const [argPrefix, setArgPrefix] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Attachments (images) ──
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const all = Array.from(files);
      const images = all.filter((f) => f.type.startsWith("image/"));
      if (all.length > 0 && images.length === 0) {
        toast({ variant: "error", title: "Only images can be attached" });
        return;
      }
      const room = MAX_ATTACHMENTS - attachments.length;
      if (images.length > room) {
        toast({
          variant: "error",
          title: "Too many attachments",
          description: `At most ${MAX_ATTACHMENTS} images can be attached`,
        });
      }
      const picked = images.slice(0, Math.max(0, room));
      const tooBig = picked.filter((f) => f.size > MAX_ATTACHMENT_BYTES);
      if (tooBig.length > 0) {
        toast({
          variant: "error",
          title: "File too large",
          description: "Images must be smaller than 10 MB",
        });
      }
      const ok = picked.filter((f) => f.size <= MAX_ATTACHMENT_BYTES);
      if (ok.length === 0) return;
      try {
        const converted = await Promise.all(ok.map(fileToComposerImage));
        setAttachments((prev) => [...prev, ...converted].slice(0, MAX_ATTACHMENTS));
        setAttachmentNames((prev) =>
          [...prev, ...ok.map((f) => f.name)].slice(0, MAX_ATTACHMENTS),
        );
      } catch {
        toast({ variant: "error", title: "Failed to read image" });
      }
    },
    [attachments.length, toast],
  );

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) {
        addFiles(files).catch(() => {});
        e.target.value = "";
      }
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        addFiles(files).catch(() => {});
      }
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const images: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const f = item.getAsFile();
          if (f) images.push(f);
        }
      }
      if (images.length > 0) {
        e.preventDefault();
        addFiles(images).catch(() => {});
      }
    },
    [addFiles],
  );

  const removeAttachment = useCallback((idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
    setAttachmentNames((prev) => prev.filter((_, i) => i !== idx));
  }, []);
  const prevInputRef = useRef("");

  const timelineRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const threadSearch = useThreadSearch(timelineRef);

  // Auto-scroll to the bottom while streaming, unless the user scrolled up.
  // Also resets stick-to-bottom on session switch so the newly loaded
  // transcript lands at the bottom.
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      stickToBottomRef.current = nearBottom;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, [activeSessionId]);

  // Scroll to the bottom whenever content changes (streaming deltas, or a
  // transcript that finished loading after a session switch) while the user
  // hasn't scrolled up. Prefers scrollIntoView on the last message — it
  // scrolls whichever ancestor actually scrolls, so it doesn't depend on the
  // timeline div being the scroll container. Falls back to scrollTop.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = timelineRef.current;
    if (!el) return;
    const raf = requestAnimationFrame(() => {
      const last = el.querySelector('[data-msg-last="true"]');
      if (last instanceof HTMLElement) {
        last.scrollIntoView({ block: "end" });
      } else {
        el.scrollTop = el.scrollHeight;
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, activeSessionId, streaming]);

  // Belt-and-suspenders: when a session's transcript finishes loading
  // (messages went from empty to non-empty), scroll synchronously before
  // paint so the new content is never shown at the top.
  const prevEmptyRef = useRef(true);
  useLayoutEffect(() => {
    const isEmpty = messages.length === 0;
    if (prevEmptyRef.current && !isEmpty) {
      const el = timelineRef.current;
      if (el) {
        const last = el.querySelector('[data-msg-last="true"]');
        if (last instanceof HTMLElement) {
          last.scrollIntoView({ block: "end" });
        } else {
          el.scrollTop = el.scrollHeight;
        }
      }
    }
    prevEmptyRef.current = isEmpty;
  }, [messages, activeSessionId]);

  // Cmd/Ctrl+F opens in-chat search; Esc closes it (the hook handles cleanup)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        threadSearch.open();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setTerminalOpen((o) => !o);
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
      saveDraft(activeSessionId, newVal);
      // Move cursor after inserted text
      requestAnimationFrame(() => {
        const pos = s + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      });
    },
    [input, activeSessionId, saveDraft],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const prev = prevInputRef.current;
      prevInputRef.current = val;
      setInput(val);
      saveDraft(activeSessionId, val);

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
    [showMention, showSlash, activeSessionId, saveDraft],
  );

  const handleForkAt = useCallback(
    async (entryId: string) => {
      try {
        await forkSessionAt(entryId);
        setShowTimeline(false);
      } catch (e) {
        console.error("[fork]", e);
        toast({
          variant: "error",
          title: "Fork failed",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [toast],
  );

  const exportActiveSession = useCallback(async () => {
    if (!activeSessionId) return false;
    const session = sessions.find((s) => s.id === activeSessionId);
    const title = session?.title || "session";
    const path = await saveDialog({
      title: "Export session",
      defaultPath: `${title}.jsonl`,
      filters: [{ name: "JSONL file", extensions: ["jsonl"] }],
    });
    if (typeof path !== "string" || !path) return false;
    try {
      await exportSession(activeSessionId, "jsonl", path);
    } catch (e) {
      console.error("[export]", e);
      toast({
        variant: "error",
        title: "Export failed",
        description: e instanceof Error ? e.message : String(e),
      });
    }
    return true;
  }, [activeSessionId, sessions, toast]);

  // Route builtin slash commands to real actions (TS interactive mode does
  // the same; unhandled commands fall through to the LLM as plain text).
  const tryHandleSlash = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text.startsWith("/")) return false;
      const [cmd, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ").trim();
      switch (cmd) {
        case "/new":
          await createSession();
          return true;
        case "/name":
          if (arg && activeSessionId) {
            await renameSession(activeSessionId, arg).catch(() => {});
          }
          return true;
        case "/compact":
          await compactSession(arg || undefined).catch((e) => {
            console.error(e);
            toast({
              variant: "error",
              title: "Compact failed",
              description: e instanceof Error ? e.message : String(e),
            });
          });
          return true;
        case "/clone":
          try {
            await cloneSession();
            setShowTimeline(false);
            toast({ variant: "success", title: "Session cloned" });
          } catch (e) {
            toast({
              variant: "error",
              title: "Clone failed",
              description: e instanceof Error ? e.message : String(e),
            });
          }
          return true;
        case "/share":
          try {
            const url = await shareSession();
            navigator.clipboard?.writeText(url).catch(() => {});
            toast({
              variant: "success",
              title: "Session shared",
              description: url,
            });
          } catch (e) {
            toast({
              variant: "error",
              title: "Share failed",
              description: e instanceof Error ? e.message : String(e),
            });
          }
          return true;
        case "/export":
          await exportActiveSession();
          return true;
        case "/copy": {
          const last = [...messages].reverse().find((m) => m.role === "assistant");
          if (last) navigator.clipboard?.writeText(last.content).catch(() => {});
          return true;
        }
        case "/session":
          if (activeSessionId) {
            getSessionInfo(activeSessionId)
              .then((info) => setSessionInfo(info))
              .catch(() => {});
            setInfoOpen(true);
          }
          return true;
        case "/tree":
          setShowTimeline(true);
          if (activeSessionId) {
            getSessionTree(activeSessionId)
              .then((t) => setTimelineTree(t ?? []))
              .catch(() => setTimelineTree([]));
          }
          return true;
        case "/settings":
        case "/hotkeys":
          onOpenSettings?.();
          return true;
        case "/model": {
          if (arg) {
            // /model <provider>/<modelId> — apply the selection directly.
            const [prov, modelId] = arg.split("/");
            if (prov && modelId) {
              try {
                await setSessionModel(prov, modelId);
                setCurrentProvider(prov);
                setCurrentModel(modelId);
              } catch (e) {
                console.error("[setSessionModel]", e);
              }
            } else {
              setModelOpen(true);
            }
          } else {
            setModelOpen(true);
          }
          return true;
        }
        case "/login":
          setModelOpen(true);
          return true;
        case "/fork":
          setShowTimeline(true);
          if (activeSessionId) {
            getSessionTree(activeSessionId)
              .then((t) => setTimelineTree(t ?? []))
              .catch(() => setTimelineTree([]));
          }
          return true;
        case "/import": {
          const selected = await openDialog({
            multiple: false,
            filters: [{ name: "JSONL session", extensions: ["jsonl"] }],
          });
          if (typeof selected === "string" && selected) {
            await importSession(selected).catch((e) => console.error(e));
          }
          return true;
        }
        case "/reload":
          await reloadSession().catch((e) => console.error(e));
          return true;
        case "/logout":
          onOpenSettings?.();
          return true;
        case "/trust": {
          try {
            const info = await getProjectTrust(activeSessionCwd);
            setTrustInfo(info);
            setTrustOpen(true);
          } catch (e) {
            console.error(e);
          }
          return true;
        }
        case "/resume": {
          const q = arg.toLowerCase();
          if (q) {
            const match = sessions.find(
              (s) =>
                s.id.toLowerCase().startsWith(q) ||
                s.title.toLowerCase().includes(q),
            );
            if (match) await selectSession(match.id);
          }
          return true;
        }
        case "/quit":
          try {
            await getCurrentWindow().close();
          } catch {
            /* ignore */
          }
          return true;
        default:
          return false;
      }
    },
    [
      createSession,
      selectSession,
      sessions,
      activeSessionId,
      messages,
      toggleInfo,
      onOpenSettings,
      exportActiveSession,
      toast,
    ],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || streaming) return;
    if (tryHandleSlash && text.startsWith("/") && (await tryHandleSlash(text))) {
      setInput("");
      prevInputRef.current = "";
      saveDraft(activeSessionId, "");
      return;
    }
    const imgs = attachments;
    setInput("");
    prevInputRef.current = "";
    setAttachments([]);
    setAttachmentNames([]);
    saveDraft(activeSessionId, "");
    await sendMessage(text, imgs.length > 0 ? imgs : undefined);
  }, [input, attachments, streaming, sendMessage, activeSessionId, saveDraft, tryHandleSlash]);

  const handlePickFolder = useCallback(async () => {
    if (!activeSessionId) return;
    const selected = await openDialog({ directory: true, multiple: false });
    if (typeof selected !== "string" || !selected) return;
    try {
      await setSessionCwd(activeSessionId, selected);
    } catch (e) {
      console.error("[setSessionCwd]", e);
      toast({
        variant: "error",
        title: "Failed to set working directory",
        description: e instanceof Error ? e.message : String(e),
      });
    }
  }, [activeSessionId, toast]);

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
        return;
      }
      if (e.key === "Escape") {
        if (showMention) setShowMention(false);
        if (showArgMenu) setShowArgMenu(false);
        if (showSlash) setShowSlash(false);
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
    [handleSend, streaming, showMention, showArgMenu, showSlash],
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
      const end = mentionStart + mentionPrefix.length;
      if (item.isDir) {
        // Directory continuation: insert the scoped path with a trailing
        // slash and keep the menu open so the search re-runs inside the
        // directory (matches TS autocomplete).
        const newRaw = item.path.endsWith("/") ? item.path : `${item.path}/`;
        const needsQuotes = mentionQuoted || newRaw.includes(" ");
        const newPrefix = needsQuotes ? `@"${newRaw}"` : `@${newRaw}`;
        insertAtCursor(newPrefix, mentionStart, end);
        setMentionPrefix(newPrefix);
        setMentionQuery(newRaw);
        setMentionQuoted(needsQuotes);
      } else {
        const needsQuotes = mentionQuoted || item.path.includes(" ");
        const base = needsQuotes ? `@"${item.path}"` : `@${item.path}`;
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
      {/* Header — Codex desktop: minimal, hairline */}
      <div className="border-codex-border bg-codex-bg flex shrink-0 items-center gap-3 border-b px-4 py-2">
        <SidebarTrigger className="shrink-0" />
        <div className="text-codex-faint flex min-w-0 shrink items-center gap-1.5 text-sm whitespace-nowrap">
          <span className="text-codex-text font-medium">
            {activeTitle || "New conversation"}
          </span>
          {activeSessionCwd && (
            <span className="text-codex-faint hidden truncate text-xs md:inline">
              · {activeSessionCwd.split("/").filter(Boolean).pop()}
            </span>
          )}
        </div>
        <Popover open={modelOpen} onOpenChange={setModelOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!activeSessionId}
              className="text-codex-faint hover:text-codex-dim inline-flex max-w-[220px] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs transition-colors disabled:opacity-40"
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
              className="text-codex-faint hover:text-codex-dim rounded-md p-1 transition-colors disabled:opacity-40"
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
              ? "bg-codex-green/10 text-codex-green"
              : "text-codex-faint hover:text-codex-dim"
          }`}
          title="Toggle session timeline"
        >
          <GitBranch className="size-3.5" />
          Timeline
        </button>
      </div>

      {/* Messages or empty state */}
      <div className="bg-codex-bg flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 flex-col">
          <div
            key={activeSessionId}
            ref={timelineRef}
            className="timeline custom-scroll bg-codex-bg relative flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-6"
          >
          {threadSearch.isOpen && (
            <div className="border-codex-border bg-white absolute top-3 right-3 z-40 flex items-center gap-1.5 rounded-lg border px-2 py-1.5 shadow-lg">
              <Search className="text-codex-faint size-3.5" />
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
                className="text-codex-text h-6 w-40 bg-transparent text-xs outline-none placeholder:text-codex-faint"
              />
              <span className="text-codex-faint min-w-[2.5rem] text-center text-[10px]">
                {threadSearch.matchCount === 0
                  ? "0/0"
                  : `${threadSearch.activeIndex + 1}/${threadSearch.matchCount}`}
              </span>
              <button
                type="button"
                className="text-codex-faint hover:text-codex-dim rounded p-0.5 transition-colors"
                onClick={() => threadSearch.goToMatch(-1)}
                title="Previous match (Shift+Enter)"
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                className="text-codex-faint hover:text-codex-dim rounded p-0.5 transition-colors"
                onClick={() => threadSearch.goToMatch(1)}
                title="Next match (Enter)"
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                className="text-codex-faint hover:text-codex-dim rounded p-0.5 transition-colors"
                onClick={() => threadSearch.close()}
                title="Close (Esc)"
              >
                <X className="size-3.5" />
              </button>
            </div>
          )}
          {isEmpty ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="max-w-[520px] text-center">
                <div className="text-codex-green mb-4 text-2xl">✦</div>
                <h2 className="text-codex-text mb-2 text-2xl font-medium">
                  AI 编程助手
                </h2>
                <p className="text-codex-faint mb-6 text-sm leading-relaxed">
                  Start a conversation with your AI coding assistant. Ask
                  questions, request code reviews, or discuss architecture.
                </p>
                <div className="border-codex-border bg-codex-inset mx-auto inline-flex flex-col items-start gap-1.5 rounded-lg border px-4 py-3 text-left text-xs text-codex-dim">
                  <span className="text-codex-text text-xs font-medium">
                    Quick tips
                  </span>
                  <span>
                    <kbd className="border-codex-border bg-white rounded px-1 font-mono">/</kbd>{" "}
                    Slash commands for specific tasks
                  </span>
                  <span>
                    <kbd className="border-codex-border bg-white rounded px-1 font-mono">@</kbd>{" "}
                    Reference files in your workspace
                  </span>
                  <span>
                    <kbd className="border-codex-border bg-white rounded px-1 font-mono">
                      Enter
                    </kbd>{" "}
                    Send ·{" "}
                    <kbd className="border-codex-border bg-white rounded px-1 font-mono">
                      Shift+Enter
                    </kbd>{" "}
                    New line
                  </span>
                </div>
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => (
              <MessageItem
                key={msg.id}
                msg={msg}
                streaming={streaming}
                isLast={idx === messages.length - 1}
              />
            ))
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

        {/* Terminal dock — between the messages and the composer */}
        {terminalOpen && (
          <TerminalDock
            cwd={activeSessionCwd}
            onClose={() => setTerminalOpen(false)}
          />
        )}

        {/* Working directory picker + terminal toggle */}
        <div className="border-codex-border bg-codex-bg flex shrink-0 items-center gap-1 border-t px-4 pt-2">
          <button
            type="button"
            onClick={handlePickFolder}
            disabled={!activeSessionId}
            className="text-codex-faint hover:text-codex-dim inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors disabled:opacity-50"
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
          <button
            type="button"
            onClick={() => setTerminalOpen((o) => !o)}
            className={`inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors ${
              terminalOpen
                ? "bg-codex-green/10 text-codex-green"
                : "text-codex-faint hover:text-codex-dim"
            }`}
            title="Toggle terminal panel (⌘J)"
          >
            <TerminalSquare className="size-3.5" />
            Terminal
          </button>
        </div>
        {/* Composer — Codex desktop input */}
        <div className="border-codex-border bg-codex-bg shrink-0 border-t px-4 py-3">
          <div className="relative mx-auto max-w-[820px]">
            {/* @ mention / file completion popover */}
            {showMention && (
              <div className="border-codex-border bg-white absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-lg border p-1 shadow-lg">
                {mentionFiles.length === 0 ? (
                  <div className="text-codex-dim px-3 py-2 font-mono text-xs">
                    No files found
                  </div>
                ) : (
                  mentionFiles.map((f) => (
                    <button
                      key={f.path}
                      className="hover:bg-codex-panel-2 text-codex-dim flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors"
                      onClick={() => handleMentionSelect(f)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      {f.isDir ? (
                        <Folder className="text-codex-green-bright size-3.5 shrink-0" />
                      ) : (
                        <svg
                          className="text-codex-faint size-3 shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                          <polyline points="14 2 14 8 20 8" />
                        </svg>
                      )}
                      <span className="text-codex-text min-w-0 flex-1 truncate">
                        {f.name}
                        {f.isDir ? "/" : ""}
                      </span>
                      <span className="text-codex-faint/70 max-w-[50%] truncate text-[10px]">
                        {f.path}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            {/* /command argument completion popover */}
            {showArgMenu && (
              <div className="border-codex-border bg-white absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-lg border p-1 shadow-lg">
                {argItems.length === 0 ? (
                  <div className="text-codex-dim px-3 py-2 font-mono text-xs">
                    No matching {argCmd === "model" ? "models" : "providers"}
                  </div>
                ) : (
                  argItems.map((item) => (
                    <button
                      key={item.value}
                      className="hover:bg-codex-panel-2 text-codex-dim flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors"
                      onClick={() => handleArgSelect(item.value)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <span className="text-codex-text min-w-0 flex-1 truncate">
                        {item.label}
                      </span>
                      <span className="text-codex-faint/70 truncate text-[10px]">
                        {item.description}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}

            <div
              className="relative"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
            {/* Attachment preview chips */}
            {attachments.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {attachments.map((a, idx) => (
                  <div
                    key={`${a.data.slice(0, 24)}-${idx}`}
                    className="border-codex-border bg-codex-inset group/att relative h-14 w-14 overflow-hidden rounded-lg border"
                    title={attachmentNames[idx] ?? ""}
                  >
                    <img
                      src={`data:${a.mimeType};base64,${a.data}`}
                      alt=""
                      className="size-full object-cover"
                    />
                    <button
                      type="button"
                      className="bg-black/50 text-white absolute top-0.5 right-0.5 rounded p-0.5 opacity-0 transition-opacity group-hover/att:opacity-100"
                      onClick={() => removeAttachment(idx)}
                      title="Remove attachment"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={onInputChange}
              onKeyDown={onInputKeyDown}
              onPaste={handlePaste}
              placeholder="Ask anything...  (/ for commands, @ to reference files, paste or drop images)"
              disabled={loading}
              className="border-codex-border focus:border-codex-border-strong bg-codex-bg text-codex-text placeholder:text-codex-faint max-h-[120px] min-h-[44px] resize-none rounded-xl border pl-10 pr-14 text-[15px] shadow-sm"
              rows={1}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            <Button
              size="icon"
              variant="ghost"
              className="text-codex-faint hover:text-codex-dim absolute bottom-1.5 left-1.5 size-8"
              onClick={handleAttachClick}
              disabled={loading || streaming}
              title="Attach image"
            >
              <Paperclip className="size-4" />
            </Button>
            {streaming ? (
              <Button
                size="icon"
                variant="secondary"
                className="bg-codex-panel-2 text-codex-dim absolute right-1.5 bottom-1.5 size-8 hover:bg-codex-panel-3"
                onClick={stop}
                title="Stop generating"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="bg-black text-white absolute right-1.5 bottom-1.5 size-8 hover:bg-neutral-800"
                onClick={handleSend}
                disabled={!input.trim() && attachments.length === 0}
                title="Send"
              >
                <Send className="size-4" />
              </Button>
            )}
            </div>
            {/* Status line — Codex desktop composer footer */}
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="border-codex-border bg-codex-inset text-codex-dim inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs">
                <span
                  className={`size-1.5 rounded-full ${
                    currentProvider && currentModel
                      ? "bg-codex-green"
                      : "bg-codex-faint"
                  }`}
                />
                <span className="font-medium">
                  {currentProvider && currentModel
                    ? currentModel
                    : "Select model"}
                </span>
              </span>
              <span className="text-codex-faint hidden items-center gap-2 text-[11px] md:flex">
                {streaming ? <span className="animate-pulse">running…</span> : null}
                <span>Enter to send</span>
                <span>·</span>
                <span>Shift+Enter newline</span>
              </span>
            </div>
          </div>
        </div>
        </div>
        <Dialog open={trustOpen} onOpenChange={setTrustOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Project trust</DialogTitle>
              <DialogDescription>
                {trustInfo?.cwd ?? ""}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground text-xs">
                Current:{" "}
                {trustInfo?.decision === true
                  ? "Trusted"
                  : trustInfo?.decision === false
                    ? "Ignored"
                    : "Not set"}
              </span>
            </div>
            <DialogFooter className="flex items-center gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  if (trustInfo) {
                    await setProjectTrust(trustInfo.cwd, true).catch(() => {});
                    setTrustOpen(false);
                  }
                }}
              >
                <ShieldCheck className="size-3.5" />
                Trust
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  if (trustInfo) {
                    await setProjectTrust(trustInfo.cwd, false).catch(() => {});
                    setTrustOpen(false);
                  }
                }}
              >
                <ShieldX className="size-3.5" />
                Ignore
              </Button>
              <Button
                variant="ghost"
                onClick={async () => {
                  if (trustInfo) {
                    await setProjectTrust(trustInfo.cwd, null).catch(() => {});
                    setTrustOpen(false);
                  }
                }}
              >
                Clear
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {showTimeline && activeSessionId && (
          <TimelinePanel
            tree={timelineTree}
            sessionId={activeSessionId}
            onClose={() => setShowTimeline(false)}
            onTreeChange={setTimelineTree}
            onFork={handleForkAt}
          />
        )}
      </div>
    </div>
  );
}
