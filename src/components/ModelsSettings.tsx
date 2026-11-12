import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Key, CheckCircle, XCircle } from "lucide-react"
import {
  getProviders, getModels, getModelSettings, listCustomProviders,
  getScopedModels, setScopedModels,
  setProviderApiKey, setDefaultModel as apiSetDefaultModel,
  setDefaultThinkingLevel as apiSetDefaultThinkingLevel,
  type CustomProviderInfo,
} from "../api/commands"
import PickModel from "./PickModel"
import type { ProviderInfo, ModelOption } from "./PickModel"

export default function ModelsSettings() {
  const { toast } = useToast()
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [models, setModels] = useState<ModelOption[]>([])
  const [defaultProvider, setDefaultProvider] = useState("")
  const [defaultModel, setDefaultModel] = useState("")
  const [thinkingLevel, setThinkingLevel] = useState("medium")
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({})
  const [customProviders, setCustomProviders] = useState<CustomProviderInfo[]>([])
  const [scoped, setScoped] = useState<string[]>([])
  const [scopedSearch, setScopedSearch] = useState("")
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [prov, mods, settings, custom] = await Promise.all([
        getProviders(),
        getModels(),
        getModelSettings(),
        listCustomProviders(),
      ])
      setProviders(prov.providers)
      setModels(mods.models)
      setDefaultProvider(settings.settings?.defaultProvider ?? "")
      setDefaultModel(settings.settings?.defaultModelId ?? "")
      setThinkingLevel(settings.settings?.defaultThinkingLevel ?? "medium")
      setCustomProviders(custom)
    } catch (e) { console.error("Failed to load model settings", e) }
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  useEffect(() => {
    getScopedModels()
      .then((result) => setScoped(result.patterns ?? []))
      .catch(() => {})
  }, [])

  const toggleScoped = useCallback(
    async (pattern: string) => {
      const next = scoped.includes(pattern)
        ? scoped.filter((item) => item !== pattern)
        : [...scoped, pattern]
      setScoped(next)
      try {
        const result = await setScopedModels(next)
        setScoped(result.patterns ?? next)
        if (result.applied === false && result.warning) {
          toast({
            title: "Scoped models saved",
            description: result.warning,
            variant: "error",
          })
        }
      } catch (e) {
        toast({
          title: "Failed to save scoped models",
          description: e instanceof Error ? e.message : String(e),
          variant: "error",
        })
      }
    },
    [scoped, toast],
  )

  const scopedModels = useMemo(() => {
    const query = scopedSearch.trim().toLowerCase()
    return models.filter((model) => {
      if (!query) return true
      const pattern = `${model.providerId}/${model.modelId}`
      return `${pattern} ${model.label}`.toLowerCase().includes(query)
    })
  }, [models, scopedSearch])

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
    } catch (e) { console.error("setDefault failed", e) }
  }, [thinkingLevel])

  // Persist a standalone thinking-level change immediately (the General tab
  // already does this via set_general_setting; keep both consistent).
  const setThinking = useCallback(async (level: string) => {
    setThinkingLevel(level)
    try {
      await apiSetDefaultThinkingLevel(level)
    } catch (e) { console.error("setThinkingLevel failed", e) }
  }, [])

  const providerMap = new Map(providers.map((p) => [p.id, p]))

  if (loading) {
    return <div className="text-muted-foreground p-8 text-sm">Loading models...</div>
  }

  return (
    <div className="space-y-8">
      {/* Default model */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-foreground">Default Model</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[240px]">
            <label className="text-muted-foreground mb-1 block text-xs">Search model</label>
            <PickModel
              models={models}
              providers={providers}
              providerId={defaultProvider}
              modelId={defaultModel}
              onSelect={setDefault}
            />
          </div>
          <div className="w-32">
            <label className="text-muted-foreground mb-1 block text-xs">Thinking</label>
            <Select value={thinkingLevel} onValueChange={setThinking}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="low">Low</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
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

      {/* Scoped models — Ctrl/Cmd+P cycling */}
      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">Scoped Models</h3>
        <p className="text-muted-foreground mb-2 text-xs">
          Ctrl/Cmd+P cycles through the selected models (Shift to cycle
          backward). With none selected, all available models are cycled.
        </p>
        <Input
          placeholder="Search models..."
          value={scopedSearch}
          onChange={(e) => setScopedSearch(e.target.value)}
          className="h-8 max-w-sm text-xs"
        />
        <div className="border-hairline mt-2 max-h-56 overflow-y-auto rounded-lg border p-1.5">
          {scopedModels.length === 0 ? (
            <p className="text-muted-foreground p-2 text-xs">No matching models.</p>
          ) : (
            scopedModels.map((model) => {
              const pattern = `${model.providerId}/${model.modelId}`
              return (
                <label
                  key={pattern}
                  className="hover:bg-muted/40 flex cursor-pointer items-center gap-2 rounded px-1.5 py-1"
                >
                  <Checkbox
                    checked={scoped.includes(pattern)}
                    onCheckedChange={() => toggleScoped(pattern)}
                  />
                  <span className="text-xs">{model.label}</span>
                  <span className="text-muted-foreground ml-auto font-mono text-[11px]">
                    {pattern}
                  </span>
                </label>
              )
            })
          )}
        </div>
        <p className="text-muted-foreground mt-1 text-[11px]">
          {scoped.length === 0
            ? "No scoped models — cycling falls back to all available models."
            : `${scoped.length} selected`}
        </p>
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
