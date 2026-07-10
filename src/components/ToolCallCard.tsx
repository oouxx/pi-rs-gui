import { useState } from "react"
import { ChevronDown, ChevronRight, Terminal, CheckCircle2, XCircle, Loader2 } from "lucide-react"

interface ToolCallCardProps {
  name: string
  args?: any
  status?: "running" | "success" | "error"
  result?: string
  isError?: boolean
}

export default function ToolCallCard({ name, args, status, result, isError }: ToolCallCardProps) {
  const [showArgs, setShowArgs] = useState(false)
  const [showResult, setShowResult] = useState(false)

  const statusIcon = () => {
    switch (status) {
      case "running":
        return <Loader2 className="size-3.5 animate-spin text-amber-500" />
      case "success":
        return <CheckCircle2 className="size-3.5 text-emerald-500" />
      case "error":
        return <XCircle className="size-3.5 text-red-500" />
      default:
        return <Loader2 className="size-3.5 text-muted-foreground" />
    }
  }

  const argsStr = args ? (typeof args === "string" ? args : JSON.stringify(args, null, 2)) : ""

  return (
    <div className="border-hairline bg-bg-surface my-2 overflow-hidden rounded-lg border text-xs">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <Terminal className="size-3.5 text-muted-foreground" />
        <span className="font-medium text-foreground">{name}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {statusIcon()}
          <span className="text-muted-foreground text-[10px] capitalize">
            {status ?? "pending"}
          </span>
        </div>
      </div>

      {/* Arguments (collapsible) */}
      {argsStr && (
        <div className="border-b border-border/50">
          <button
            className="hover:bg-bg-hover flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors"
            onClick={() => setShowArgs(!showArgs)}
          >
            {showArgs ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <span className="text-muted-foreground font-mono text-[10px]">Arguments</span>
          </button>
          {showArgs && (
            <pre className="bg-bg-hover overflow-x-auto px-3 py-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {argsStr}
            </pre>
          )}
        </div>
      )}

      {/* Result (collapsible) */}
      {result && (
        <div>
          <button
            className={`hover:bg-bg-hover flex w-full items-center gap-1.5 px-3 py-1.5 text-left transition-colors ${
              isError ? "text-red-500" : ""
            }`}
            onClick={() => setShowResult(!showResult)}
          >
            {showResult ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
            <span className="font-mono text-[10px]">
              {isError ? "Error" : "Result"}
            </span>
          </button>
          {showResult && (
            <pre className={`overflow-x-auto px-3 py-2 font-mono text-[10px] leading-relaxed ${
              isError ? "bg-red-950/20 text-red-400" : "bg-bg-hover text-muted-foreground"
            }`}>
              {result}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
