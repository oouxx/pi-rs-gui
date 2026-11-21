import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Send,
  Folder,
  X,
  Paperclip,
  Square,
  FileText,
  Image as ImageIcon,
  TerminalSquare,
} from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";

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
  listSlashCommands,
  type ComposerFile,
  type ComposerImage,
  type FileCompletion,
  type QueuedMessage,
  type StreamingBehavior,
} from "@/api/commands";
import type { ModelOption, SlashCommandInfo } from "@/api/types";
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
  MAX_TEXT_ATTACHMENTS,
  attachmentFromFile,
  attachmentFromPath,
  filesFromTransfer,
  formatSize,
  isImageAttachment,
  releaseAttachment,
  toComposerFile,
  toComposerImage,
  type ComposerAttachment,
} from "@/lib/attachments";

let attachmentSeq = 0;
function newAttachmentId(): string {
  attachmentSeq += 1;
  return `att-${Date.now()}-${attachmentSeq}`;
}

interface ComposerProps {
  sessionId: string | null;
  cwd: string | null;
  loading: boolean;
  streaming: boolean;
  queued: QueuedMessage[];
  /** Whether the session's current model accepts image input (undefined = unknown). */
  supportsImages?: boolean;
  /** Provider limit on images per message, when the model declares one. */
  maxImages?: number;
  onSend: (
    text: string,
    images?: ComposerImage[],
    streamingBehavior?: StreamingBehavior,
    files?: ComposerFile[],
  ) => boolean | void | Promise<boolean | void>;
  onStop: () => void;
  /** Returns true when a builtin slash command was handled locally. */
  onSlashCommand: (text: string) => Promise<boolean>;
  terminalOpen: boolean;
  onToggleTerminal: () => void;
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
  supportsImages,
  maxImages: maxImagesProp,
  onSend,
  onStop,
  onSlashCommand,
  terminalOpen,
  onToggleTerminal,
}: ComposerProps) {
  const { toast } = useToast();
  const { bindings } = useKeybindings();
  const { t } = useI18n();
  const maxImages = Math.max(1, maxImagesProp ?? MAX_ATTACHMENTS);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [showSlash, setShowSlash] = useState(false);
  const [showMention, setShowMention] = useState(false);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionPrefix, setMentionPrefix] = useState("");
  const [mentionQuoted, setMentionQuoted] = useState(false);
  const [mentionStart, setMentionStart] = useState(-1);
  const [mentionFiles, setMentionFiles] = useState<FileCompletion[]>([]);
  const [slashCommands, setSlashCommands] = useState<SlashCommandInfo[]>([]);
  const [showArgMenu, setShowArgMenu] = useState(false);
  const [argStart, setArgStart] = useState(0);
  const [argPrefix, setArgPrefix] = useState("");
  const [modelList, setModelList] = useState<ModelOption[]>([]);

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
    getModels()
      .then((mods) => setModelList(mods.models ?? []))
      .catch((e) => console.error("[composer] model list", e));
  }, []);


  // Focus the slash menu's search field so cmdk handles type-to-filter and
  // arrow navigation (floating picker).
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
  // Files are handed to pi-rs's `read` tool, so an attachment only needs a
  // name — plus a path when the OS gave us one (native dialog / native drag),
  // in which case the bytes never enter the webview. Only pasted bytes are
  // read here, as base64 at send time.
  const addAttachments = useCallback(
    (incoming: ComposerAttachment[]) => {
      if (incoming.length === 0) return;
      const currentImages = attachments.filter(isImageAttachment).length;
      const currentFiles = attachments.length - currentImages;
      const images = incoming.filter(isImageAttachment);
      const files = incoming.filter((a) => !isImageAttachment(a));
      const imageRoom = Math.max(0, maxImages - currentImages);
      const fileRoom = Math.max(0, MAX_TEXT_ATTACHMENTS - currentFiles);
      const pickedImages = images.slice(0, imageRoom);
      const pickedFiles = files.slice(0, fileRoom);
      const dropped = [...images.slice(imageRoom), ...files.slice(fileRoom)];
      if (dropped.length > 0) {
        dropped.forEach(releaseAttachment);
        toast({
          variant: "error",
          title: t("composer.tooManyAttachments"),
          description: t("composer.imageLimitHint", {
            count: Math.max(imageRoom, fileRoom),
          }),
        });
      }
      if (pickedImages.length > 0 && supportsImages === false) {
        // Non-blocking: the user may switch to a vision model before sending.
        toast({
          title: t("composer.modelNoImage"),
          description: t("composer.modelNoImageHint"),
        });
      }
      const picked = [...pickedImages, ...pickedFiles];
      if (picked.length === 0) return;
      setAttachments((prev) => [...prev, ...picked]);
    },
    [attachments, maxImages, supportsImages, t, toast],
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;
      addAttachments(
        list.map((file) => attachmentFromFile(file, newAttachmentId())),
      );
    },
    [addAttachments],
  );

  const addPaths = useCallback(
    (paths: string[]) => {
      const list = paths.filter((path) => path.trim() !== "");
      if (list.length === 0) return;
      addAttachments(
        list.map((path) => attachmentFromPath(path, newAttachmentId())),
      );
    },
    [addAttachments],
  );

  const handleAttachClick = useCallback(async () => {
    // Prefer the native dialog: it hands back absolute paths, so even a 500MB
    // attachment never passes through the webview.
    try {
      const picked = await openDialog({
        multiple: true,
        title: t("composer.attach"),
      });
      if (picked) addPaths(Array.isArray(picked) ? picked : [picked]);
      return;
    } catch {
      // Not running under Tauri (browser dev): fall back to the file input.
    }
    fileInputRef.current?.click();
  }, [addPaths, t]);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files) {
        addFiles(files);
        e.target.value = "";
      }
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = filesFromTransfer(e.dataTransfer);
      if (files.length > 0) addFiles(files);
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      // Plain text pastes fall through to the textarea; only clipboard *files*
      // (screenshots, files copied in Finder or an editor) become attachments.
      const files = filesFromTransfer(e.clipboardData);
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  // Tauri intercepts OS drag & drop, so DOM `onDrop` never fires in the
  // packaged app. The native event carries absolute paths, which is exactly
  // what the attachment pipeline wants: bytes never enter the webview.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        addPaths(event.payload.paths ?? []);
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // Not running under Tauri (browser dev): DOM drop handles it.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addPaths]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id);
      if (target) releaseAttachment(target);
      return prev.filter((a) => a.id !== id);
    });
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

      // Detect `/model <provider/id>` argument completion.
      const argMatch = textBeforeCursor.match(/^\/model\s+([\w./:-]*)$/);
      if (argMatch) {
        setArgPrefix(argMatch[1]);
        setArgStart("/model ".length);
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
    setAttachments((prev) => {
      prev.forEach(releaseAttachment);
      return [];
    });
    saveDraft(sessionId, "");
  }, [sessionId, saveDraft]);

  const handleSend = useCallback(
    async (followUp = false) => {
      const text = input.trim();
      if (!text && attachments.length === 0) return;
      if (text.startsWith("/") && (await onSlashCommand(text))) {
        clearComposer();
        return;
      }
      const all = attachments;
      const draft = input;
      // While a turn runs: Enter steers (delivered at the next boundary),
      // Alt+Enter queues a follow-up (delivered after the run), matching the
      // TUI's Enter / Alt+Enter behavior.
      const behavior: StreamingBehavior | undefined = streaming
        ? followUp
          ? "followUp"
          : "steer"
        : undefined;
      let images: ComposerImage[];
      let files: ComposerFile[];
      try {
        [images, files] = await Promise.all([
          Promise.all(all.filter(isImageAttachment).map(toComposerImage)),
          Promise.all(all.filter((a) => !isImageAttachment(a)).map(toComposerFile)),
        ]);
      } catch {
        toast({ variant: "error", title: t("composer.readAttachmentFailed") });
        return;
      }
      clearComposer();
      const sent = await onSend(
        text,
        images.length > 0 ? images : undefined,
        behavior,
        files.length > 0 ? files : undefined,
      );
      if (sent === false) {
        // The backend rejected the message (an image it cannot decode, a file
        // that vanished): put the prompt and its attachments back.
        setInput(draft);
        prevInputRef.current = draft;
        saveDraft(sessionId, draft);
        setAttachments(all);
      }
    },
    [
      input,
      attachments,
      streaming,
      onSend,
      onSlashCommand,
      clearComposer,
      saveDraft,
      sessionId,
      t,
      toast,
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
  }, [argPrefix, modelList]);

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
    <div className="border-hairline bg-background shrink-0 border-t px-4 pt-2 pb-3">
      <div className="relative mx-auto max-w-[760px]">
        {/* Slash command picker — bottom-anchored above the composer */}
        {showSlash && (
          <div
            ref={slashMenuRef}
            className="border-hairline bg-popover absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border shadow-md"
          >
            <Command className="bg-popover p-0">
              <div className="border-hairline border-b px-3 pt-2 pb-1.5">
                <CommandInput
                  ref={slashInputRef}
                  placeholder={t("composer.searchCommands")}
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
                <CommandEmpty className="text-subtle-foreground py-6 text-center text-sm">
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
                            className="data-selected:bg-secondary data-selected:text-foreground flex items-baseline gap-2 rounded-md px-3 py-2"
                          >
                            <span className="text-foreground font-mono text-sm font-medium">
                              /{cmd.name}
                            </span>
                            {cmd.argumentHint && (
                              <span className="text-subtle-foreground font-mono text-[11px]">
                                {cmd.argumentHint}
                              </span>
                            )}
                            <span className="text-subtle-foreground min-w-0 flex-1 truncate text-left text-xs">
                              {cmd.description}
                            </span>
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    );
                  },
                )}
              </CommandList>
              <div className="border-hairline bg-muted/60 text-subtle-foreground border-t px-3 py-1.5 text-[10.5px]">
                ↑↓ navigate · ↵ select · Esc close
              </div>
            </Command>
          </div>
        )}

        {/* @ mention / file completion popover */}
        {showMention && (
          <div className="border-hairline bg-popover absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border p-1 shadow-md">
            {mentionFiles.length === 0 ? (
              <div className="text-muted-foreground px-3 py-2 font-mono text-xs">
                No files found
              </div>
            ) : (
              mentionFiles.map((f) => (
                <button
                  key={f.path}
                  className="hover:bg-secondary text-muted-foreground flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors"
                  onClick={() => handleMentionSelect(f)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  {f.isDir ? (
                    <Folder className="text-success size-3.5 shrink-0" />
                  ) : (
                    <svg
                      className="text-subtle-foreground size-3 shrink-0"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                    </svg>
                  )}
                  <span className="text-foreground min-w-0 flex-1 truncate">
                    {f.name}
                    {f.isDir ? "/" : ""}
                  </span>
                  <span className="text-subtle-foreground/70 max-w-[50%] truncate text-[10px]">
                    {f.path}
                  </span>
                </button>
              ))
            )}
          </div>
        )}

        {/* /command argument completion popover */}
        {showArgMenu && (
          <div className="border-hairline bg-popover absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-xl border p-1 shadow-md">
            {argItems.length === 0 ? (
              <div className="text-muted-foreground px-3 py-2 font-mono text-xs">
                No matching models
              </div>
            ) : (
              argItems.map((item) => (
                <button
                  key={item.value}
                  className="hover:bg-secondary text-muted-foreground flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors"
                  onClick={() => handleArgSelect(item.value)}
                  onMouseDown={(e) => e.preventDefault()}
                >
                  <span className="text-foreground min-w-0 flex-1 truncate">
                    {item.label}
                  </span>
                  <span className="text-subtle-foreground/70 truncate text-[10px]">
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
            <div className="mb-2 flex flex-wrap items-center gap-1.5">
              {queued.map((q, idx) => (
                <span
                  key={`${q.mode}-${idx}`}
                  className="border-hairline bg-muted/80 text-muted-foreground inline-flex max-w-full items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]"
                  title={q.text}
                >
                  <span className="text-subtle-foreground">
                    {q.mode === "steer"
                      ? t("composer.steer")
                      : t("composer.queued")}
                  </span>
                  <span className="max-w-[240px] truncate">{q.text}</span>
                </span>
              ))}
            </div>
          )}
          {/* Attachment chips: images get a thumbnail when we hold their bytes,
              path-based ones (native dialog / drag) show a file chip. */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-2">
              {attachments.map((attachment) =>
                attachment.kind === "image" ? (
                  <div
                    key={attachment.id}
                    className="border-hairline group/att bg-secondary/60 relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border"
                    title={attachment.path ?? attachment.name}
                  >
                    {attachment.previewUrl ? (
                      <img
                        src={attachment.previewUrl}
                        alt=""
                        className="size-full object-cover"
                      />
                    ) : (
                      <div className="flex flex-col items-center gap-0.5 px-1">
                        <ImageIcon className="text-subtle-foreground size-3.5" />
                        <span className="text-subtle-foreground w-full truncate text-center text-[9px]">
                          {attachment.name}
                        </span>
                      </div>
                    )}
                    <button
                      type="button"
                      className="bg-black/50 text-white absolute top-1 right-1 rounded-md p-0.5 opacity-0 transition-opacity group-hover/att:opacity-100"
                      onClick={() => removeAttachment(attachment.id)}
                      title={t("composer.removeAttachment")}
                      aria-label={t("composer.removeAttachment")}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ) : (
                  <div
                    key={attachment.id}
                    className="border-hairline bg-secondary/60 text-muted-foreground flex max-w-[240px] items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px]"
                    title={attachment.path ?? attachment.name}
                  >
                    <FileText className="text-subtle-foreground size-3 shrink-0" />
                    <span className="truncate">{attachment.name}</span>
                    {attachment.size != null && (
                      <span className="text-subtle-foreground shrink-0 tabular-nums">
                        {formatSize(attachment.size)}
                      </span>
                    )}
                    <button
                      type="button"
                      className="text-subtle-foreground hover:text-foreground shrink-0"
                      onClick={() => removeAttachment(attachment.id)}
                      title={t("composer.removeFile")}
                      aria-label={t("composer.removeFile")}
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ),
              )}
            </div>
          )}
          <div className="border-border bg-card shadow-xs focus-within:border-ring/40 focus-within:ring-ring/10 rounded-2xl border transition-[border-color,box-shadow] duration-200 focus-within:shadow-sm focus-within:ring-4">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={onInputChange}
              onKeyDown={onInputKeyDown}
              onPaste={handlePaste}
              placeholder={t("composer.placeholder")}
              disabled={loading}
              className="placeholder:text-subtle-foreground text-foreground max-h-[180px] min-h-[56px] resize-none rounded-none border-0 bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-[1.65] shadow-none focus-visible:border-transparent focus-visible:ring-0 md:text-[15px]"
              rows={1}
            />
            <div className="flex items-center justify-between gap-2 px-2 pb-2">
              <div className="flex items-center gap-0.5">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className="text-subtle-foreground hover:bg-muted hover:text-foreground"
                  onClick={handleAttachClick}
                  disabled={loading}
                  title={t("composer.attach")} aria-label={t("composer.attach")}
                >
                  <Paperclip className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  className={
                    terminalOpen
                      ? "bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary"
                      : "text-subtle-foreground hover:bg-muted hover:text-foreground"
                  }
                  onClick={onToggleTerminal}
                  title={t("chat.toggleTerminal")}
                  aria-label={t("chat.toggleTerminal")}
                >
                  <TerminalSquare className="size-3.5" />
                </Button>
              </div>
              <div className="flex items-center gap-1">
                {streaming ? (
                  <>
                    {(input.trim() || attachments.length > 0) && (
                      <Button
                        size="icon-sm"
                        className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-full"
                        onClick={() => handleSend()}
                        title={t("composer.sendSteering")} aria-label={t("composer.sendSteering")}
                      >
                        <Send className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="border-border text-foreground hover:bg-accent hover:text-foreground rounded-full border"
                      onClick={onStop}
                      title={t("composer.stopGenerating")} aria-label={t("composer.stopGenerating")}
                    >
                      <Square className="size-3 shrink-0 fill-current" />
                    </Button>
                  </>
                ) : (
                  <Button
                    size="icon-sm"
                    className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-subtle-foreground rounded-full disabled:opacity-100"
                    onClick={() => handleSend()}
                    disabled={!input.trim() && attachments.length === 0}
                    title={t("composer.send")} aria-label={t("composer.send")}
                  >
                    <Send className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleFileChange}
          />
        </div>
        {/* Status line — composer footer */}
        <div className="mt-2 flex h-4 items-center justify-end">
          <span className="text-subtle-foreground hidden items-center gap-1.5 text-[10.5px] md:flex">
            {streaming ? (
              <>
                <span className="animate-pulse">{t("composer.running")}</span>
                <span>{t("composer.enterSteers")}</span>
                <span className="opacity-50">·</span>
                <span>{t("composer.altEnterQueues")}</span>
              </>
            ) : (
              <>
                <span>{t("composer.enterSend")}</span>
                <span className="opacity-50">·</span>
                <span>{t("composer.shiftEnter")}</span>
              </>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
