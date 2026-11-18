import { useEffect, useRef, useState } from "react"
import { ChevronRight, Sparkles } from "lucide-react"
import { AnimatePresence, motion } from "motion/react"
import { useI18n } from "@/i18n"
import { expand, FAST_TRANSITION, PANEL_TRANSITION } from "@/lib/motion"

interface ThinkingBlockProps {
  thinking?: string
  streaming?: boolean
}

export default function ThinkingBlock({ thinking, streaming = false }: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const startedAtRef = useRef(0)
  const { t } = useI18n()

  useEffect(() => {
    if (!streaming) return
    if (!startedAtRef.current) startedAtRef.current = performance.now()
    const timer = setInterval(() => {
      setElapsed(Math.round((performance.now() - startedAtRef.current) / 1000))
    }, 500)
    return () => clearInterval(timer)
  }, [streaming])

  useEffect(() => {
    if (streaming || !startedAtRef.current) return
    setElapsed(Math.round((performance.now() - startedAtRef.current) / 1000))
  }, [streaming])

  return (
    <div className="border-hairline bg-muted/40 my-2 overflow-hidden rounded-xl border">
      <button
        className="text-subtle-foreground hover:text-muted-foreground flex w-full items-center gap-1.5 px-3 py-2 text-left text-[11.5px] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <motion.span
          className="inline-flex"
          animate={{ rotate: expanded ? 90 : 0 }}
          transition={FAST_TRANSITION}
        >
          <ChevronRight className="size-3.5" />
        </motion.span>
        <Sparkles className="text-primary/70 size-3.5" />
        <span className="font-medium">
          {streaming ? t("thinking.thinking") : t("thinking.reasoning")}
        </span>
        {elapsed > 0 && (
          <span className="tabular-nums opacity-70">{elapsed}s</span>
        )}
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
            <div className="text-muted-foreground border-hairline border-t px-3.5 py-2.5 text-[12.5px] leading-[1.75] whitespace-pre-wrap">
              {thinking}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
