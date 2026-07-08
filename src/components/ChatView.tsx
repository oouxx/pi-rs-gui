import { useCallback, useEffect, useRef, useState } from "react"
import { Send } from "lucide-react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import type { Components } from "react-markdown"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import { useChat } from "@/hooks/useChat"

const mdComponents: Components = {
  code: ({ className, children, ...props }) => {
    const isInline = !className
    if (isInline) {
      return (
        <code className="bg-bg-hover text-ink rounded px-1 py-0.5 font-mono text-xs" {...props}>
          {children}
        </code>
      )
    }
    return (
      <pre className="rounded-card border-hairline bg-bg-hover text-ink-muted my-2 overflow-x-auto border p-3 font-mono text-xs leading-relaxed">
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    )
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-hairline bg-bg-hover text-ink-muted border-b px-3 py-2 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-hairline text-ink-muted border-b px-3 py-2">{children}</td>
  ),
  a: ({ children, href }) => (
    <a href={href} className="text-ai hover:underline" target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-1 pl-5">{children}</ol>,
  hr: () => <hr className="border-hairline my-3" />,
}

const SLASH_COMMANDS = [
  { id: "search", label: "Search", description: "Search codebase for symbols and files", icon: "🔍" },
  { id: "explain", label: "Explain", description: "Explain selected code in detail", icon: "💡" },
  { id: "refactor", label: "Refactor", description: "Suggest refactoring for selected code", icon: "🔧" },
  { id: "review", label: "Code Review", description: "Review current file for issues", icon: "👁" },
  { id: "test", label: "Write Tests", description: "Generate tests for selected code", icon: "🧪" },
  { id: "fix", label: "Fix", description: "Diagnose and fix issues in the code", icon: "🩹" },
  { id: "doc", label: "Document", description: "Generate documentation for code", icon: "📝" },
  { id: "ask", label: "Ask", description: "General question about the codebase", icon: "💬" },
]

export default function ChatView() {
  const { messages, sendMessage, streaming, loading } = useChat()
  const [input, setInput] = useState("")
  const [showSlash, setShowSlash] = useState(false)
  const [showMention, setShowMention] = useState(false)
  const [mentionQuery, setMentionQuery] = useState("")
  const [mentionFiles, setMentionFiles] = useState<{ path: string }[]>([])
  const [mentionStart, setMentionStart] = useState(-1)
  const msgContainerRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const prevInputRef = useRef("")

  const scrollDown = useCallback(() => {
    requestAnimationFrame(() => {
      if (msgContainerRef.current) {
        msgContainerRef.current.scrollTop = msgContainerRef.current.scrollHeight
      }
    })
  }, [])

  useEffect(() => { scrollDown() }, [messages, scrollDown])

  // Fetch workspace files for @ mention (stub — replace with piApp.listWorkspaceFiles when available)
  useEffect(() => {
    if (!showMention) return
    const api = window.piApp
    if (!api) return
    api.getState().then((state) => {
      const wsId = state.selectedWorkspaceId
      if (!wsId) return
      api.listWorkspaceFiles(wsId, { force: true }).then((files) => {
        setMentionFiles(files.map((f) => ({ path: f })))
      }).catch(() => {})
    }).catch(() => {})
  }, [showMention])

  const insertAtCursor = useCallback((text: string, start?: number, end?: number) => {
    const ta = textareaRef.current
    if (!ta) return
    const s = start ?? ta.selectionStart
    const e = end ?? ta.selectionEnd
    const before = input.slice(0, s)
    const after = input.slice(e)
    const newVal = before + text + after
    setInput(newVal)
    prevInputRef.current = newVal
    // Move cursor after inserted text
    requestAnimationFrame(() => {
      const pos = s + text.length
      ta.setSelectionRange(pos, pos)
      ta.focus()
    })
  }, [input])

  const onInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    const prev = prevInputRef.current
    prevInputRef.current = val
    setInput(val)

    const cursorPos = e.target.selectionStart ?? val.length
    const textBeforeCursor = val.slice(0, cursorPos)

    // Detect @ mention trigger
    const atMatch = textBeforeCursor.match(/@(\w*)$/)
    if (atMatch) {
      setMentionQuery(atMatch[1])
      setMentionStart(atMatch.index!)
      setShowMention(true)
    } else if (showMention) {
      setShowMention(false)
    }

    // Detect / slash trigger — only when `val` starts with `/` and `prev` didn't
    if (val.startsWith("/") && !prev.startsWith("/")) {
      setShowSlash(true)
    } else if (!val.startsWith("/")) {
      setShowSlash(false)
    }
  }, [showMention])

  const handleSend = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput("")
    prevInputRef.current = ""
    await sendMessage(text)
  }, [input, streaming, sendMessage])

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault()
        handleSend()
      }
    },
    [handleSend],
  )

  const handleSlashSelect = useCallback((cmdId: string) => {
    insertAtCursor(`/${cmdId} `)
    setShowSlash(false)
  }, [insertAtCursor])

  const handleMentionSelect = useCallback((filePath: string) => {
    // Replace from @ to the end with the chosen file reference
    const end = mentionStart + mentionQuery.length + 1
    insertAtCursor(`@${filePath} `, mentionStart, end)
    setShowMention(false)
  }, [mentionStart, mentionQuery, insertAtCursor])

  // Filter mention files by query
  const filteredMentions = mentionFiles.filter((f) =>
    f.path.toLowerCase().includes(mentionQuery.toLowerCase()),
  ).slice(0, 15)

  const isEmpty = messages.length === 0

  return (
    <div className="flex size-full flex-col">
      {/* Header */}
      <div className="border-hairline bg-bg-surface flex flex-shrink-0 items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="flex-shrink-0" />
        <div className="text-ink-muted flex flex-shrink-0 items-center gap-1.5 text-xs whitespace-nowrap">
          <span className="font-medium text-foreground">pi-gui</span>
        </div>
      </div>

      {/* Messages or empty state */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={msgContainerRef}
          className="flex flex-1 flex-col gap-5 overflow-y-auto px-6 py-5"
        >
          {isEmpty ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="max-w-[500px] text-center">
                <h2 className="mb-2 text-2xl font-medium text-foreground">
                  AI 编程助手
                </h2>
                <p className="text-muted-foreground mb-6 text-sm leading-relaxed">
                  Start a conversation with your AI coding assistant.
                  Ask questions, request code reviews, or discuss architecture.
                </p>
                <div className="border-hairline bg-bg-surface mx-auto inline-flex flex-col items-start gap-1.5 rounded-lg border px-4 py-3 text-left text-xs text-muted-foreground">
                  <span className="text-foreground text-xs font-medium">Quick tips</span>
                  <span><kbd className="bg-bg-hover rounded px-1 font-mono">/</kbd> Slash commands for specific tasks</span>
                  <span><kbd className="bg-bg-hover rounded px-1 font-mono">@</kbd> Reference files in your workspace</span>
                  <span><kbd className="bg-bg-hover rounded px-1 font-mono">Enter</kbd> Send  ·  <kbd className="bg-bg-hover rounded px-1 font-mono">Shift+Enter</kbd> New line</span>
                </div>
              </div>
            </div>
          ) : (
            messages.map((msg, idx) => {
              const isLastAi = msg.role === "assistant" && idx === messages.length - 1
              return (
                <div
                  key={msg.id}
                  className={`flex max-w-[820px] gap-3 ${msg.role === "user" ? "flex-row-reverse self-end" : ""}`}
                >
                  <span
                    className={`flex size-8 flex-shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                      msg.role === "user" ? "bg-ai text-white" : "bg-bg-hover text-foreground"
                    }`}
                  >
                    {msg.role === "user" ? "U" : "AI"}
                  </span>
                  <div
                    className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${
                      msg.role === "user"
                        ? "bg-ink-dim max-w-[70%] rounded-tr-sm text-foreground"
                        : "border-hairline bg-bg-surface rounded-tl-sm border text-foreground/80"
                    }`}
                  >
                    {msg.role === "assistant" ? (
                      msg.content ? (
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={mdComponents}
                        >
                          {msg.content}
                        </ReactMarkdown>
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
              )
            })
          )}
        </div>

        {/* Slash command dialog */}
        <CommandDialog open={showSlash} onOpenChange={(open) => {
          if (!open) { setShowSlash(false); requestAnimationFrame(() => textareaRef.current?.focus()) }
        }}>
          <Command>
            <CommandInput placeholder="Search commands..." />
            <CommandList>
              <CommandEmpty>No matching commands</CommandEmpty>
              <CommandGroup heading="Commands">
                {SLASH_COMMANDS.map((cmd) => (
                  <CommandItem key={cmd.id} onSelect={() => handleSlashSelect(cmd.id)}>
                    <span className="mr-2">{cmd.icon}</span>
                    <span className="flex-1 truncate font-medium">{cmd.label}</span>
                    <span className="text-muted-foreground ml-auto max-w-[200px] truncate text-[10px]">
                      {cmd.description}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </CommandDialog>

        {/* Composer */}
        <div className="border-hairline bg-bg-surface flex-shrink-0 border-t px-4 py-2">
          <div className="relative mx-auto max-w-[820px]">
            {/* @ mention popover */}
            {showMention && (
              <div className="bg-popover border-hairline absolute bottom-full left-0 right-0 z-50 mb-1 max-h-48 overflow-y-auto rounded-lg border p-1 shadow-md">
                {filteredMentions.length === 0 ? (
                  <div className="text-muted-foreground px-3 py-2 text-xs">No files found</div>
                ) : (
                  filteredMentions.map((f) => (
                    <button
                      key={f.path}
                      className="hover:bg-muted flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors"
                      onClick={() => handleMentionSelect(f.path)}
                      onMouseDown={(e) => e.preventDefault()}
                    >
                      <svg className="text-muted-foreground size-3 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                      <span className="truncate">{f.path}</span>
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
              disabled={streaming || loading}
              className="max-h-[120px] min-h-[44px] resize-none pr-12 text-sm"
              rows={1}
            />
            <Button
              size="icon"
              className="absolute right-1.5 bottom-1.5 size-8"
              onClick={handleSend}
              disabled={streaming || !input.trim()}
            >
              <Send className="size-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
