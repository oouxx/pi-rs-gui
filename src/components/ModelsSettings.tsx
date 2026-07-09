import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Search, Key, CheckCircle, XCircle, Check } from "lucide-react"
import {
  getProviders, getModels, getModelSettings, listCustomProviders,
  setProviderApiKey, setDefaultModel as apiSetDefaultModel,
  setDefaultThinkingLevel as apiSetDefaultThinkingLevel,
} from "../api/commands"

interface Provider { id: string; name: string; hasAuth: boolean }
interface ModelInfo { providerId: string; modelId: string; label: string; available: boolean }

export default function ModelsSettings() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [models, setModels] = useState<ModelInfo[]>([])
  const [defaultProvider, setDefaultProvider] = useState("")
  const [defaultModel, setDefaultModel] = useState("")
  const [thinkingLevel, setThinkingLevel] = useState("normal")
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [customProviders, setCustomProviders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // Search state
  const [searchQuery, setSearchQuery] = useState("")
  const [showResults, setShowResults] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const searchRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [prov, mods, settings, custom] = await Promise.all([
        getProviders(),
        getModels(),
        getModelSettings(),
        listCustomProviders(),
      ])
      setProviders(prov.providers as Provider[])
      setModels(mods.models as ModelInfo[])
      setDefaultProvider(settings.settings?.defaultProvider ?? "")
      setDefaultModel(settings.settings?.defaultModelId ?? "")
      setThinkingLevel(settings.settings?.defaultThinkingLevel ?? "normal")
      setCustomProviders(custom as any[])
    } catch (e) { console.error("Failed to load model settings", e) }
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  // Close search results on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowResults(false)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  const setApiKey = useCallback(async (providerId: string) => {
    const key = apiKeys[providerId]
    if (!key) return
    try {
      await setProviderApiKey(providerId, key)
      refresh()
    } catch (e) { console.error("setApiKey failed", e) }
  }, [apiKeys, refresh])

  const setDefault = useCallback(async (provider: string, model: string) => {
    try {
      await apiSetDefaultModel(provider, model)
      await apiSetDefaultThinkingLevel(thinkingLevel)
      setDefaultProvider(provider)
      setDefaultModel(model)
      setSearchQuery("")
      setShowResults(false)
    } catch (e) { console.error("setDefault failed", e) }
  }, [thinkingLevel])

  // Build provider lookup
  const providerMap = useMemo(() => {
    const m = new Map<string, Provider>()
    for (const p of providers) m.set(p.id, p)
    return m
  }, [providers])

  // Filter models by search query
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return []
    const q = searchQuery.toLowerCase()
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
  }, [models, searchQuery, providerMap])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, searchResults.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === "Enter" && searchResults[selectedIndex]) {
      e.preventDefault()
      const m = searchResults[selectedIndex]
      setDefault(m.providerId, m.modelId)
    } else if (e.key === "Escape") {
      setShowResults(false)
    }
  }, [searchResults, selectedIndex, setDefault])

  const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value)
    setShowResults(true)
    setSelectedIndex(0)
  }, [])

  if (loading) {
    return <div className="text-muted-foreground p-8 text-sm">Loading models...</div>
  }

  return (
    <div className="space-y-8">
      {/* Default model — search-based */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-foreground">Default Model</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="relative flex-1 min-w-[240px]" ref={searchRef}>
            <label className="text-muted-foreground mb-1 block text-xs">Search model</label>
            <div className="relative">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                value={searchQuery}
                onChange={handleSearchChange}
                onFocus={() => searchQuery.trim() && setShowResults(true)}
                onKeyDown={handleSearchKeyDown}
                placeholder="Type to search models..."
                className="h-8 pl-8 text-xs"
              />
            </div>
            {showResults && searchResults.length > 0 && (
              <div className="bg-popover border-hairline absolute z-50 mt-1 max-h-60 w-full overflow-y-auto rounded-lg border p-1 shadow-md">
                {searchResults.map((m, i) => {
                  const prov = providerMap.get(m.providerId)
                  const isSelected = m.providerId === defaultProvider && m.modelId === defaultModel
                  return (
                    <button
                      key={`${m.providerId}/${m.modelId}`}
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-xs transition-colors ${
                        i === selectedIndex ? "bg-accent text-accent-foreground" : "hover:bg-muted"
                      }`}
                      onClick={() => setDefault(m.providerId, m.modelId)}
                      onMouseEnter={() => setSelectedIndex(i)}
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
            {showResults && searchQuery.trim() && searchResults.length === 0 && (
              <div className="bg-popover border-hairline absolute z-50 mt-1 w-full rounded-lg border p-3 text-center text-xs text-muted-foreground shadow-md">
                No models match "{searchQuery}"
              </div>
            )}
          </div>
          <div className="w-32">
            <label className="text-muted-foreground mb-1 block text-xs">Thinking</label>
            <Select value={thinkingLevel} onValueChange={setThinkingLevel}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="normal">Normal</SelectItem>
                <SelectItem value="high">High</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {defaultProvider && defaultModel && (
          <p className="text-muted-foreground mt-2 text-xs">
            Current: <span className="font-medium text-foreground">{defaultModel}</span>
            {" via "}
            <span className="font-medium text-foreground">{providerMap.get(defaultProvider)?.name ?? defaultProvider}</span>
          </p>
        )}
      </section>

      <Separator />

      {/* API Keys */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-foreground">API Keys</h3>
        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">{p.name}</span>
              <div className="relative flex-1">
                <Key className="text-muted-foreground absolute top-1/2 left-2 size-3 -translate-y-1/2" />
                <Input
                  type="password"
                  placeholder={p.hasAuth ? "Key set" : `Enter ${p.id} API key...`}
                  value={apiKeys[p.id] ?? ""}
                  onChange={(e) => setApiKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <span className={`flex items-center gap-1 text-xs ${p.hasAuth ? "text-ai" : "text-muted-foreground"}`}>
                {p.hasAuth ? <CheckCircle className="size-3" /> : <XCircle className="size-3" />}
                {p.hasAuth ? "Connected" : "No key"}
              </span>
              <Button size="xs" variant="outline" className="h-7" onClick={() => setApiKey(p.id)} disabled={!apiKeys[p.id]}>
                Save
              </Button>
            </div>
          ))}
        </div>
      </section>

      <Separator />

      {/* Custom providers */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-foreground">Custom Providers</h3>
        {customProviders.length === 0 ? (
          <p className="text-muted-foreground text-xs">No custom providers configured.</p>
        ) : (
          <div className="space-y-2">
            {customProviders.map((cp, i) => (
              <div key={i} className="border-hairline flex items-center gap-2 rounded-lg border px-3 py-2">
                <span className="flex-1 text-xs font-medium">{cp.name ?? cp.id}</span>
                <span className="text-muted-foreground text-xs">{cp.baseUrl}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
