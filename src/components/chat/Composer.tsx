import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Folder, X, Paperclip, Square, FileText } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { useToast } from "@/components/ui/toast";
import {
  fileCompletions,
  getModels,
  getProviders,
  listSlashCommands,
  type ComposerImage,
  type FileCompletion,
  type QueuedMessage,
  type StreamingBehavior,
} from "@/api/commands";
import type { ModelOption, ProviderInfo, SlashCommandInfo } from "@/api/types";
import { matchesBinding, useKeybindings } from "@/lib/keybindings";
import { useI18n } from "@/i18n";
import {
  extractAtPrefix,
  extractCompletionToken,
  extractQuotedPrefix,
  findLastDelimiter,
  parsePathPrefix,
} from "@/lib/composer-paths";
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_TEXT_ATTACHMENTS,
  MAX_TEXT_ATTACHMENT_BYTES,
  fileToComposerImage,
  fileToTextAttachment,
  isTextFile,
  type TextAttachment,
} from "@/lib/attachments";

interface ComposerProps {
  sessionId: string | null;
  cwd: string | null;
  loading: boolean;
  streaming: boolean;
  queued: QueuedMessage[];
  onSend: (
    text: string,
    images?: ComposerImage[],
    streamingBehavior?: StreamingBehavior,
    files?: TextAttachment[],
  ) => void | Promise<void>;
  onStop: () => void;
  /** Returns true when a builtin slash command was handled locally. */
  onSlashCommand: (text: string) => Promise<boolean>;
}

/**
 * Chat composer: text input, image attachments, `/` command picker and
 * `@` path completion. Owns only composer-local state; message/session state
 * comes from the shared chat context.
 */
export default function Composer({
  sessionId,
  cwd,
  loading,
  streaming,
  queued,
  onSend,
  onStop,
  onSlashCommand,
}: ComposerProps) {
  const { toast } = useToast();
  const { bindings } = useKeybindings();
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerImage[]>([]);
  const [attachmentNames, setAttachmentNames] = useState<string[]>([]);
  const [textAttachments, setTextAttachments] = useState<TextAttachment[]>([]);
  const [showSlash, setShowSlash] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPrefix, setMentionPrefix] = useState("");
  const [mentionQuoted, setMentionQuoted] = useState(false);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFiles, setMentionFiles] = useState<FileCompletion[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [showArgMenu, setShowArgMenu] = useState(false);
  const [argCmd, setArgCmd] = useState<"model" | "login">("model");
  const [argStart, setArgStart] = useState(0);
  const [argPrefix, setArgPrefix] = useState("");
  const [modelList, setModelList] = useState<ModelOption[]>([]);
  const [providerList, setProviderList] = useState<ProviderInfo[]>([]);

  const prevInputRef = useRef("");
  const mentionForcedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const slashInputRef = useRef<HTMLInputElement>(null);
  const slashMenuRef = useRef<HTMLDivElement>(null);

  // ── Drafts (per session, survive switches and restarts) ────
  const saveDraft = useCallback((sid: string | null, value: string) => {
    if (!sid) return;
    try {
      if (value.trim()) localStorage.setItem(`pi-gui:draft:${sid}`, value);
      else localStorage.removeItem(`pi-gui:draft:${sid}`);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setInput("");
      prevInputRef.current = "";
      return;
    }
    try {
      const draft = localStorage.getItem(`pi-gui:draft:${sessionId}`);
      setInput(draft ?? "");
      prevInputRef.current = draft ?? "";
    } catch {
      setInput("");
    }
  }, [sessionId]);

  // ── Slash commands / model lists for completion ────────────
  const refreshSlashCommands = useCallback(async () => {
    try {
      setSlashCommands((await listSlashCommands()) ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshSlashCommands();
  }, [refreshSlashCommands, sessionId]);

  useEffect(() => {
    Promise.all([getProviders(), getModels()])
      .then(([prov, mods]) => {
        setProviderList(prov.providers ?? []);
        setModelList(mods.models ?? []);
      })
      .catch((e) => console.error("[composer] model list", e));
  }, []);

  // Focus the slash menu's search field so cmdk handles type-to-filter and
  // arrow navigation (matches Codex's floating picker).
  useEffect(() => {
    if (showSlash) {
      requestAnimationFrame(() => slashInputRef.current?.focus());
    }
  }, [showSlash]);

  // Close the slash picker when clicking anywhere outside it.
  useEffect(() => {
    if (!showSlash) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (
        slashMenuRef.current &&
        !slashMenuRef.current.contains(e.target as Node)
      ) {
        setShowSlash(false);
      }
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [showSlash]);

  // Cmd/Ctrl+K focuses the composer (customizable).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesBinding(e, bindings.focusComposer)) {
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
  }, [bindings.focusComposer]);

  // @ mention / Tab file completion — live workspace lookup (debounced)
  useEffect(() => {
    if (!showMention) {
      setMentionFiles([]);
      return;
    }
    const handle = setTimeout(async () => {
      try {
        setMentionFiles((await fileCompletions(cwd, mentionQuery)) ?? []);
      } catch {
        setMentionFiles([]);
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [showMention, mentionQuery, cwd]);

  // ── Attachments ────────────────────────────────────────────
  const addFiles = useCallback(
    async (files: FileList | File[]) => {
      const all = Array.from(files);
      const images = all.filter((f) => f.type.startsWith("image/"));
      const textFiles = all.filter(
        (f) => !f.type.startsWith("image/") && isTextFile(f),
      );
      if (images.length + textFiles.length < all.length) {
        toast({
          variant: "error",
          title: "Unsupported file",
          description: "Only images and text/code files can be attached",
        });
      }

      const imageRoom = MAX_ATTACHMENTS - attachments.length;
      const pickedImages = images.slice(0, Math.max(0, imageRoom));
      if (images.length > imageRoom) {
        toast({
          variant: "error",
          title: "Too many attachments",
          description: `At most ${MAX_ATTACHMENTS} images can be attached`,
        });
      }
      const tooBigImages = pickedImages.filter(
        (f) => f.size > MAX_ATTACHMENT_BYTES,
      );
      if (tooBigImages.length > 0) {
        toast({
          variant: "error",
          title: "File too large",
          description: "Images must be smaller than 10 MB",
        });
      }

      const textRoom = MAX_TEXT_ATTACHMENTS - textAttachments.length;
      const pickedText = textFiles.slice(0, Math.max(0, textRoom));
      if (textFiles.length > textRoom) {
        toast({
          variant: "error",
          title: "Too many files",
          description: `At most ${MAX_TEXT_ATTACHMENTS} text files can be attached`,
        });
      }
      const tooBigText = pickedText.filter(
        (f) => f.size > MAX_TEXT_ATTACHMENT_BYTES,
      );
      if (tooBigText.length > 0) {
        toast({
          variant: "error",
          title: "File too large",
          description: "Text files must be smaller than 256 KB",
        });
      }

      const okImages = pickedImages.filter(
        (f) => f.size <= MAX_ATTACHMENT_BYTES,
      );
      const okText = pickedText.filter(
        (f) => f.size <= MAX_TEXT_ATTACHMENT_BYTES,
      );
      if (okImages.length === 0 && okText.length === 0) return;

      try {
        const [convertedImages, convertedText] = await Promise.all([
          Promise.all(okImages.map(fileToComposerImage)),
          Promise.all(okText.map(fileToTextAttachment)),
        ]);
        if (convertedImages.length > 0) {
          setAttachments((prev) =>
            [...prev, ...convertedImages].slice(0, MAX_ATTACHMENTS),
          );
          setAttachmentNames((prev) =>
            [...prev, ...okImages.map((f) => f.name)].slice(
              0,
              MAX_ATTACHMENTS,
            ),
          );
        }
        if (convertedText.length > 0) {
          setTextAttachments((prev) =>
            [...prev, ...convertedText].slice(0, MAX_TEXT_ATTACHMENTS),
          );
        }
      } catch {
        toast({ variant: "error", title: "Failed to read attachment" });
      }
    },
    [attachments.length, textAttachments.length, toast],
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

  // ── Input / completion ─────────────────────────────────────
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
      saveDraft(sessionId, newVal);
      requestAnimationFrame(() => {
        const pos = s + text.length;
        ta.setSelectionRange(pos, pos);
        ta.focus();
      });
    },
    [input, sessionId, saveDraft],
  );

  const onInputChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value;
      const prev = prevInputRef.current;
      prevInputRef.current = val;
      setInput(val);
      saveDraft(sessionId, val);

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
    [showMention, showSlash, showArgMenu, sessionId, saveDraft],
  );

  const clearComposer = useCallback(() => {
    setInput("");
    prevInputRef.current = "";
    setAttachments([]);
    setAttachmentNames([]);
    setTextAttachments([]);
    saveDraft(sessionId, "");
  }, [sessionId, saveDraft]);

  const handleSend = useCallback(
    async (followUp = false) => {
      const text = input.trim();
      if (!text && attachments.length === 0 && textAttachments.length === 0)
        return;
      if (text.startsWith("/") && (await onSlashCommand(text))) {
        clearComposer();
        return;
      }
      const imgs = attachments;
      const files = textAttachments;
      // While a turn runs: Enter steers (delivered at the next boundary),
      // Alt+Enter queues a follow-up (delivered after the run), matching the
      // TUI's Enter / Alt+Enter behavior.
      const behavior: StreamingBehavior | undefined = streaming
        ? followUp
          ? "followUp"
          : "steer"
        : undefined;
      clearComposer();
      await onSend(
        text,
        imgs.length > 0 ? imgs : undefined,
        behavior,
        files.length > 0 ? files : undefined,
      );
    },
    [
      input,
      attachments,
      textAttachments,
      streaming,
      onSend,
      onSlashCommand,
      clearComposer,
    ],
  );

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend(e.altKey);
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
        let token: { prefix: string; quoted: boolean } | null = null;
        if (atPrefix) {
          token = { prefix: atPrefix, quoted: atPrefix.startsWith('@"') };
        } else if (!streaming) {
          // Force file completion at the current token (TS shouldTriggerFileCompletion).
          token = extractCompletionToken(textBeforeCursor);
        }
        if (token) {
          e.preventDefault();
          mentionForcedRef.current = true;
          const { rawPrefix } = parsePathPrefix(token.prefix);
          setMentionPrefix(token.prefix);
          setMentionQuery(rawPrefix);
          setMentionQuoted(token.quoted);
          setMentionStart(textBeforeCursor.length - token.prefix.length);
          setShowMention(true);
        }
      }
    },
    [handleSend, streaming, showMention, showArgMenu, showSlash],
  );

  const handleSlashSelect = useCallback(
    (cmd: SlashCommandInfo) => {
      // Replace any partial `/query` already typed with the full command
      // (the composer holds just `/` while the picker is open).
      const space = input.indexOf(" ");
      const end = space === -1 ? input.length : space;
      insertAtCursor(`/${cmd.name} `, 0, end);
      setShowSlash(false);
    },
    [input, insertAtCursor],
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
    (item: FileCompletion) => {
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

  return (
    <div className="border-codex-border bg-codex-bg shrink-0 border-t px-4 py-3">
      <div className="relative mx-auto max-w-[820px]">
        {/* Slash command picker — bottom-anchored above the composer */}
        {showSlash && (
          <div
            ref={slashMenuRef}
            className="border-codex-border bg-codex-bg absolute bottom-full left-0 right-0 z-50 mb-1.5 overflow-hidden rounded-xl border shadow-lg"
          >
            <Command className="bg-codex-bg p-0">
              <div className="border-codex-border border-b px-3 pt-2 pb-1.5">
                <CommandInput
                  ref={slashInputRef}
                  placeholder="Search commands"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setShowSlash(false);
                      requestAnimationFrame(() => textareaRef.current?.focus());
                    }
                  }}
                />
              </div>
              <CommandList className="max-h-[300px] p-1">
                <CommandEmpty className="text-codex-faint py-6 text-center text-sm">
                  No matching commands
                </CommandEmpty>
                {(["builtin", "extension", "prompt", "skill"] as const).map(
                  (source) => {
                    const group = slashCommands.filter((c) => c.source === source);
                    if (group.length === 0) return null;
                    return (
                      <CommandGroup
                        key={source}
                        heading={
                          source === "builtin"
                            ? "Commands"
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
                            value={`/${cmd.name} ${cmd.description ?? ""}`}
                            onSelect={() => handleSlashSelect(cmd)}
                            className="data-selected:bg-codex-panel-2 data-selected:text-codex-text flex items-baseline gap-2 rounded-md px-3 py-2"
                          >
                            <span className="text-codex-text font-mono text-sm font-medium">
                              /{cmd.name}
                            </span>
                            {cmd.argumentHint && (
                              <span className="text-codex-faint font-mono text-[11px]">
                                {cmd.argumentHint}
                              </span>
                            )}
                            <span className="text-codex-faint min-w-0 flex-1 truncate text-left text-xs">
                              {cmd.description}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    );
                  },
                )}
              </CommandList>
              <div className="border-codex-border bg-codex-inset px-3 py-1.5 text-[11px] text-codex-faint">
                ↑↓ navigate · ↵ select · Esc close
              </div>
            </Command>
          </div>
        )}

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
          {/* Queued steer / follow-up messages */}
          {queued.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {queued.map((q, idx) => (
                <span
                  key={`${q.mode}-${idx}`}
                  className="border-codex-border bg-codex-inset text-codex-dim inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
                  title={q.text}
                >
                  <span className="text-codex-faint">
                    {q.mode === "steer"
                      ? t("composer.steer")
                      : t("composer.queued")}
                  </span>
                  <span className="max-w-[240px] truncate">{q.text}</span>
                </span>
              ))}
            </div>
          )}
          {/* Text/code attachment chips */}
          {textAttachments.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {textAttachments.map((file, idx) => (
                <div
                  key={`${file.name}-${idx}`}
                  className="border-codex-border bg-codex-inset text-codex-dim flex max-w-[240px] items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]"
                >
                  <FileText className="text-codex-faint size-3 shrink-0" />
                  <span className="truncate" title={file.name}>
                    {file.name}
                  </span>
                  <button
                    type="button"
                    className="text-codex-faint hover:text-codex-dim shrink-0"
                    onClick={() =>
                      setTextAttachments((prev) =>
                        prev.filter((_, index) => index !== idx),
                      )
                    }
                    title="Remove file"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
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
            placeholder={t("composer.placeholder")}
            disabled={loading}
            className="border-codex-border focus:border-codex-border-strong bg-codex-bg text-codex-text placeholder:text-codex-faint max-h-[120px] min-h-[44px] resize-none rounded-xl border pl-10 pr-14 text-[15px] shadow-sm"
            rows={1}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,text/*,.md,.json,.ts,.tsx,.js,.jsx,.py,.rs,.go,.toml,.yaml,.yml,.sh,.css,.html,.csv,.sql,.xml"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
          <Button
            size="icon"
            variant="ghost"
            className="text-codex-faint hover:text-codex-dim absolute bottom-1.5 left-1.5 size-8"
            onClick={handleAttachClick}
            disabled={loading}
            title={t("composer.attach")}
          >
            <Paperclip className="size-4" />
          </Button>
          {streaming ? (
            <>
              {(input.trim() ||
                attachments.length > 0 ||
                textAttachments.length > 0) && (
                <Button
                  size="icon"
                  className="bg-codex-text text-codex-bg absolute right-11 bottom-1.5 size-8 hover:opacity-90"
                  onClick={() => handleSend()}
                  title="Send as steering message"
                >
                  <Send className="size-4" />
                </Button>
              )}
              <Button
                size="icon"
                variant="secondary"
                className="bg-codex-panel-2 text-codex-dim absolute right-1.5 bottom-1.5 size-8 hover:bg-codex-panel-3"
                onClick={onStop}
                title="Stop generating"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            </>
          ) : (
            <Button
              size="icon"
              className="bg-codex-text text-codex-bg absolute right-1.5 bottom-1.5 size-8 hover:opacity-90"
              onClick={() => handleSend()}
              disabled={
                !input.trim() &&
                attachments.length === 0 &&
                textAttachments.length === 0
              }
              title="Send"
            >
              <Send className="size-4" />
            </Button>
          )}
        </div>
        {/* Status line — Codex desktop composer footer */}
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="text-codex-faint hidden items-center gap-2 text-[11px] md:flex">
            {streaming ? (
              <>
                <span className="animate-pulse">{t("composer.running")}</span>
                <span>{t("composer.enterSteers")}</span>
                <span>·</span>
                <span>{t("composer.altEnterQueues")}</span>
              </>
            ) : (
              <>
                <span>{t("composer.enterSend")}</span>
                <span>·</span>
                <span>{t("composer.shiftEnter")}</span>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
