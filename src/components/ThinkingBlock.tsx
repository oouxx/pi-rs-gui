import { useState } from "react"
import { ChevronDown, ChevronRight, Brain } from "lucide-react"

interface ThinkingBlockProps {
  thinking?: string
}

export default function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div className="my-2">
      <button
        className="text-muted-foreground hover:text-foreground flex items-center gap-1.5 text-xs transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <Brain className="size-3" />
        <span className="font-medium">Thinking</span>
        {!thinking && (
          <span className="inline-flex gap-0.5">
            <span className="bg-muted-foreground/60 size-1 animate-pulse rounded-full" />
            <span className="bg-muted-foreground/60 size-1 animate-pulse rounded-full" style={{ animationDelay: "0.2s" }} />
            <span className="bg-muted-foreground/60 size-1 animate-pulse rounded-full" style={{ animationDelay: "0.4s" }} />
          </span>
        )}
      </button>
      {expanded && thinking && (
        <div className="text-muted-foreground mt-1 border-l-2 border-amber-500/30 pl-4 text-xs italic leading-relaxed">
          {thinking}
        </div>
      )}
    </div>
  )
}
