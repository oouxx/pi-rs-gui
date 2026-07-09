import { useCallback, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Key, CheckCircle, XCircle } from "lucide-react"
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

  const filteredModels = models.filter((m) => m.providerId === defaultProvider)

  if (loading) {
    return <div className="text-muted-foreground p-8 text-sm">Loading models...</div>
  }

  return (
    <div className="space-y-8">
      {/* Default model */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-foreground">Default Model</h3>
        <div className="flex flex-wrap gap-3">
          <div className="flex-1 min-w-[200px]">
            <label className="text-muted-foreground mb-1 block text-xs">Provider</label>
            <Select value={defaultProvider} onValueChange={(v) => {
              setDefaultProvider(v)
              setDefaultModel("")
            }}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder="Select provider" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="flex items-center gap-2">
                      {p.name}
                      {p.hasAuth ? <CheckCircle className="size-3 text-ai" /> : <XCircle className="size-3 text-muted-foreground" />}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex-1 min-w-[200px]">
            <label className="text-muted-foreground mb-1 block text-xs">Model</label>
            <Select value={defaultModel} onValueChange={(v) => setDefaultModel(v)}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue placeholder={defaultProvider ? "Select model" : "Select provider first"} />
              </SelectTrigger>
              <SelectContent>
                {filteredModels.map((m) => (
                  <SelectItem key={m.modelId} value={m.modelId}>{m.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          <div className="flex items-end">
            <Button size="sm" onClick={() => setDefault(defaultProvider, defaultModel)} disabled={!defaultProvider || !defaultModel}>
              Apply
            </Button>
          </div>
        </div>
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
