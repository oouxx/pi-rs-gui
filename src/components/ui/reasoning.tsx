import React, { useState, useCallback } from "react"
import * as Collapsible from "@radix-ui/react-collapsible"

// ── ReasoningRoot ─────────────────────────────────────

export interface ReasoningRootProps {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  className?: string
  children: React.ReactNode
}

export function ReasoningRoot({
  defaultOpen = false,
  open: controlledOpen,
  onOpenChange: controlledOnOpenChange,
  className = "",
  children,
}: ReasoningRootProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen)
  const isControlled = controlledOpen !== undefined
  const isOpen = isControlled ? controlledOpen : uncontrolledOpen
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!isControlled) setUncontrolledOpen(open)
      controlledOnOpenChange?.(open)
    },
    [isControlled, controlledOnOpenChange]
  )
  return (
    <Collapsible.Root
      open={isOpen}
      onOpenChange={handleOpenChange}
      className={`border-hairline mb-3 w-full rounded-lg border ${className}`}
    >
      {children}
    </Collapsible.Root>
  )
}

// ── ReasoningTrigger ──────────────────────────────────

export function ReasoningTrigger({ active = false }: { active?: boolean }) {
  return (
    <Collapsible.Trigger className="group text-caption text-ink-muted hover:bg-bg-hover flex w-full cursor-pointer items-center gap-2 px-3 py-2 transition-colors">
      {/* Brain icon */}
      <svg
        className="size-4 shrink-0"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 2a7 7 0 0 1 7 7c0 1.5-.5 2.9-1.3 4 .8.6 1.3 1.5 1.3 2.5a3 3 0 0 1-3 3c-.6 0-1.2-.2-1.7-.5A7 7 0 0 1 12 22a7 7 0 0 1-7-7c0-1.5.5-2.9 1.3-4-.8-.6-1.3-1.5-1.3-2.5a3 3 0 0 1 3-3c.6 0 1.2.2 1.7.5A7 7 0 0 1 12 2z" />
      </svg>
      <span className="font-mono">思考过程</span>
      {active && (
        <span
          className="bg-ai inline-block size-1.5 rounded-full"
          style={{ animation: "reasoning-shimmer 1.2s ease-in-out infinite" }}
        />
      )}
      <svg
        className="ml-auto size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </Collapsible.Trigger>
  )
}

// ── ReasoningContent ──────────────────────────────────

export interface ReasoningContentProps {
  className?: string
  children: React.ReactNode
  "aria-busy"?: boolean
}

export function ReasoningContent({ className = "", children, ...props }: ReasoningContentProps) {
  return (
    <Collapsible.Content className={`reasoning-content ${className}`} {...props}>
      {children}
    </Collapsible.Content>
  )
}

// ── ReasoningText ─────────────────────────────────────

export interface ReasoningTextProps {
  className?: string
  children: React.ReactNode
}

export function ReasoningText({ className = "", children }: ReasoningTextProps) {
  return (
    <div className={`relative ${className}`}>
      <div className="text-caption text-ink-muted max-h-48 overflow-y-auto px-3 pt-1 pb-2 leading-relaxed whitespace-pre-wrap">
        {children}
      </div>
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-6"
        style={{
          background: "linear-gradient(to bottom, transparent, rgb(var(--color-bg-rgb)))",
        }}
      />
    </div>
  )
}

// ── ReasoningFade (standalone) ────────────────────────

export function ReasoningFade() {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-0 h-6"
      style={{
        background: "linear-gradient(to bottom, transparent, rgb(var(--color-bg-rgb)))",
      }}
    />
  )
}
