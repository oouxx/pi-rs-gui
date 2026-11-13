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
import { useI18n } from "@/i18n"

export default function ModelsSettings() {
  const { toast } = useToast()
  const { t } = useI18n()
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
    } catch (e) {
      toast({
        title: t("models.loadFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "error",
      })
    }
    setLoading(false)
  }, [t, toast])

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
            title: t("models.scopedSaved"),
            description: result.warning,
            variant: "error",
          })
        }
      } catch (e) {
        toast({
          title: t("models.scopedSaveFailed"),
          description: e instanceof Error ? e.message : String(e),
          variant: "error",
        })
      }
    },
    [scoped, toast, t],
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
    } catch (e) {
      toast({
        title: t("models.keySaveFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "error",
      })
    }
  }, [apiKeys, refresh, toast, t])

  const setDefault = useCallback(async (provider: string, model: string) => {
    try {
      await apiSetDefaultModel(provider, model)
      await apiSetDefaultThinkingLevel(thinkingLevel)
      setDefaultProvider(provider)
      setDefaultModel(model)
    } catch (e) {
      toast({
        title: t("models.defaultSaveFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "error",
      })
    }
  }, [thinkingLevel, toast, t])

  // Persist a standalone thinking-level change immediately (the General tab
  // already does this via set_general_setting; keep both consistent).
  const setThinking = useCallback(async (level: string) => {
    setThinkingLevel(level)
    try {
      await apiSetDefaultThinkingLevel(level)
    } catch (e) {
      toast({
        title: t("models.thinkingSaveFailed"),
        description: e instanceof Error ? e.message : String(e),
        variant: "error",
      })
    }
  }, [toast, t])

  const providerMap = new Map(providers.map((p) => [p.id, p]))

  if (loading) {
    return <div className="text-muted-foreground p-8 text-sm">{t("models.loading")}</div>
  }

  return (
    <div className="space-y-8">
      {/* Default model */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-foreground">{t("models.defaultModel")}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[240px]">
            <label className="text-muted-foreground mb-1 block text-xs">{t("models.searchModel")}</label>
            <PickModel
              models={models}
              providers={providers}
              providerId={defaultProvider}
              modelId={defaultModel}
              onSelect={setDefault}
            />
          </div>
          <div className="w-32">
            <label className="text-muted-foreground mb-1 block text-xs">{t("models.thinking")}</label>
            <Select value={thinkingLevel} onValueChange={setThinking}>
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("models.none")}</SelectItem>
                <SelectItem value="low">{t("models.low")}</SelectItem>
                <SelectItem value="medium">{t("models.medium")}</SelectItem>
                <SelectItem value="high">{t("models.high")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        {defaultProvider && defaultModel && (
          <p className="text-muted-foreground mt-2 text-xs">
            {t("models.current")} <span className="font-medium text-foreground">{defaultModel}</span>
            {` ${t("models.via")} `}
            <span className="font-medium text-foreground">{providerMap.get(defaultProvider)?.name ?? defaultProvider}</span>
          </p>
        )}
      </section>

      <Separator />

      {/* Scoped models — Ctrl/Cmd+P cycling */}
      <section>
        <h3 className="mb-1 text-sm font-medium text-foreground">{t("models.scopedTitle")}</h3>
        <p className="text-muted-foreground mb-2 text-xs">
          {t("models.scopedHint")}
        </p>
        <Input
          placeholder={t("models.searchModels")}
          value={scopedSearch}
          onChange={(e) => setScopedSearch(e.target.value)}
          className="h-8 max-w-sm text-xs"
        />
        <div className="border-hairline mt-2 max-h-56 overflow-y-auto rounded-lg border p-1.5">
          {scopedModels.length === 0 ? (
            <p className="text-muted-foreground p-2 text-xs">{t("models.noMatching")}</p>
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
            ? t("models.noneScoped")
            : t("models.selected", { count: scoped.length })}
        </p>
      </section>

      <Separator />

      {/* API Keys */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-foreground">{t("models.apiKeys")}</h3>
        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.id} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-xs text-muted-foreground">{p.name}</span>
              <div className="relative flex-1">
                <Key className="text-muted-foreground absolute top-1/2 left-2 size-3 -translate-y-1/2" />
                <Input
                  type="password"
                  placeholder={p.hasAuth ? t("models.keySet") : t("models.enterKey", { provider: p.id })}
                  value={apiKeys[p.id] ?? ""}
                  onChange={(e) => setApiKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  className="h-8 pl-7 text-xs"
                />
              </div>
              <span className={`flex items-center gap-1 text-xs ${p.hasAuth ? "text-primary" : "text-muted-foreground"}`}>
                {p.hasAuth ? <CheckCircle className="size-3" /> : <XCircle className="size-3" />}
                {p.hasAuth ? t("models.connected") : t("models.noKey")}
              </span>
              <Button size="xs" variant="outline" className="h-7" onClick={() => setApiKey(p.id)} disabled={!apiKeys[p.id]}>
                {t("common.save")}
              </Button>
            </div>
          ))}
        </div>
      </section>

      <Separator />

      {/* Custom providers */}
      <section>
        <h3 className="mb-3 text-sm font-medium text-foreground">{t("models.customProviders")}</h3>
        {customProviders.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("models.noCustomProviders")}</p>
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
