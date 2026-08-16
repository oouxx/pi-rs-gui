import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Input } from "@/components/ui/input"
import { Search, Check } from "lucide-react"

export interface ProviderInfo {
  id: string
  name: string
  hasAuth: boolean
}

export interface ModelOption {
  providerId: string
  modelId: string
  label: string
  available: boolean
}

interface PickModelProps {
  models: readonly ModelOption[]
  providers: readonly ProviderInfo[]
  /** Currently selected provider ID */
  providerId?: string
  /** Currently selected model ID */
  modelId?: string
  /** Called when user selects a model */
  onSelect: (providerId: string, modelId: string) => void
  placeholder?: string
}

export default function PickModel({
  models,
  providers,
  providerId,
  modelId,
  onSelect,
  placeholder = "Type to search models...",
}: PickModelProps) {
  const [query, setQuery] = useState("")
  const [show, setShow] = useState(false)
  const [selIdx, setSelIdx] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setShow(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  // Build provider lookup
  const providerMap = useMemo(() => {
    const m = new Map<string, ProviderInfo>()
    for (const p of providers) m.set(p.id, p)
    return m
  }, [providers])

  // Filter models by query
  const results = useMemo(() => {
    if (!query.trim()) return []
    const q = query.toLowerCase()
    return models
      .filter((m) => {
        const prov = providerMap.get(m.providerId)
        return (
          m.label.toLowerCase().includes(q) ||
          m.modelId.toLowerCase().includes(q) ||
          m.providerId.toLowerCase().includes(q) ||
          prov?.name.toLowerCase().includes(q)
        )
      })
      .slice(0, 50)
  }, [models, query, providerMap])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        if (results.length > 0) setSelIdx((i) => Math.min(i + 1, results.length - 1))
      } else if (e.key === "ArrowUp") {
        e.preventDefault()
        setSelIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === "Enter" && results[selIdx]) {
        e.preventDefault()
        const m = results[selIdx]
        onSelect(m.providerId, m.modelId)
        setQuery("")
        setShow(false)
      } else if (e.key === "Escape") {
        setShow(false)
      }
    },
    [results, selIdx, onSelect],
  )

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value)
    setShow(true)
    setSelIdx(0)
  }, [])

  const handleSelect = useCallback(
    (m: ModelOption) => {
      onSelect(m.providerId, m.modelId)
      setQuery("")
      setShow(false)
    },
    [onSelect],
  )

  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={handleChange}
          onFocus={() => query.trim() && setShow(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className="h-8 pl-8 text-xs"
        />
      </div>
      {show && results.length > 0 && (
        <div className="bg-popover border-hairline absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border p-1 shadow-md">
          {results.map((m, i) => {
            const prov = providerMap.get(m.providerId)
            const isSelected = m.providerId === providerId && m.modelId === modelId
            return (
              <button
                key={`${m.providerId}/${m.modelId}`}
                className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors ${
                  i === selIdx ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                }`}
                onClick={() => handleSelect(m)}
                onMouseEnter={() => setSelIdx(i)}
              >
                <span className="flex-1 truncate">
                  <span className="font-medium">{m.label}</span>
                  <span className="text-muted-foreground ml-1.5">
                    {prov?.name ?? m.providerId}
                  </span>
                </span>
                {isSelected && <Check className="size-3 shrink-0 text-ai" />}
              </button>
            )
          })}
        </div>
      )}
      {show && query.trim() && results.length === 0 && (
        <div className="bg-popover border-hairline absolute z-50 mt-1 w-full rounded-lg border p-3 text-center text-xs text-muted-foreground shadow-md">
          No models match "{query}"
        </div>
      )}
    </div>
  )
}
