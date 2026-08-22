import { useState } from "react"
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react"

interface ThinkingBlockProps {
  thinking?: string
}

/** Codex desktop-style reasoning block: subtle light panel. */
export default function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="border-codex-border bg-codex-inset my-2 overflow-hidden rounded-lg border">
      <button
        className="text-codex-faint hover:text-codex-dim flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="size-3.5" />
        ) : (
          <ChevronRight className="size-3.5" />
        )}
        <Sparkles className="size-3.5" />
        <span className="font-medium">reasoning</span>
        {!thinking && (
          <span className="ml-1 inline-flex gap-0.5">
            <span className="bg-codex-faint/70 size-1 animate-pulse rounded-full" />
            <span
              className="bg-codex-faint/70 size-1 animate-pulse rounded-full"
              style={{ animationDelay: "0.2s" }}
            />
            <span
              className="bg-codex-faint/70 size-1 animate-pulse rounded-full"
              style={{ animationDelay: "0.4s" }}
            />
          </span>
        )}
      </button>
      {expanded && thinking && (
        <div className="text-codex-dim border-codex-border border-t px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
          {thinking}
        </div>
      )}
    </div>
  )
}
