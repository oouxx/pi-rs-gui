import { useState } from "react"
import { ChevronDown, ChevronRight, Sparkles } from "lucide-react"

interface ThinkingBlockProps {
  thinking?: string
}

/** Codex CLI-style reasoning block: dark inset panel, mono label + content. */
export default function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="my-1.5 overflow-hidden rounded-md border border-codex-border bg-codex-inset">
      <button
        className="text-codex-faint hover:text-codex-dim flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left font-mono text-[11px] tracking-wide transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        <Sparkles className="size-3" />
        <span className="font-medium uppercase">reasoning</span>
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
        <div className="text-codex-dim border-t border-codex-border/60 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {thinking}
        </div>
      )}
    </div>
  )
}
