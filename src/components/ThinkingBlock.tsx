import { useState } from "react"
import { ChevronRight, Sparkles } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useI18n } from "@/i18n"
import { expand, FAST_TRANSITION, PANEL_TRANSITION } from "@/lib/motion"

interface ThinkingBlockProps {
  thinking?: string
}

/** Reasoning block: subtle recessed panel. */
export default function ThinkingBlock({ thinking }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const { t } = useI18n()

  return (
    <div className="border-border bg-muted my-2 overflow-hidden rounded-lg border">
      <button
        className="text-subtle-foreground hover:text-muted-foreground flex w-full items-center gap-1.5 px-3 py-2 text-left text-xs transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <motion.span
          className="inline-flex"
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={FAST_TRANSITION}
        >
          <ChevronRight className="size-3.5" />
        </motion.span>
        <Sparkles className="size-3.5" />
        <span className="font-medium">{t("thinking.reasoning")}</span>
        {!thinking && (
          <span className="ml-1 inline-flex gap-0.5">
            <span className="bg-subtle-foreground/70 size-1 animate-pulse rounded-full" />
            <span
              className="bg-subtle-foreground/70 size-1 animate-pulse rounded-full"
              style={{ animationDelay: "0.2s" }}
            />
            <span
              className="bg-subtle-foreground/70 size-1 animate-pulse rounded-full"
              style={{ animationDelay: "0.4s" }}
            />
          </span>
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && thinking && (
          <motion.div
            key="thinking"
            {...expand}
            transition={PANEL_TRANSITION}
            className="overflow-hidden"
          >
            <div className="text-muted-foreground border-border border-t px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
              {thinking}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
