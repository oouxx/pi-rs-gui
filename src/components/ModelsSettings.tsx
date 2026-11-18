import { errorText } from "@/lib/errors";
import { useCallback, useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { useToast } from "@/components/ui/toast"
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
import ThinkingLevelSelect from "./ThinkingLevelSelect"
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
        description: errorText(e),
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
          description: errorText(e),
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
        description: errorText(e),
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
        description: errorText(e),
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
        description: errorText(e),
        variant: "error",
      })
    }
  }, [toast, t])

  const providerMap = new Map(providers.map((p) => [p.id, p]))

  if (loading) {
    return <div className="text-subtle-foreground py-10 text-[12px]">{t("models.loading")}</div>
  }

  return (
    <div className="space-y-10">
      {/* Default model */}
      <section>
        <h3 className="text-muted-foreground mb-2 text-[10.5px] font-semibold tracking-[0.1em] uppercase">{t("models.defaultModel")}</h3>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[240px]">
            <label className="text-subtle-foreground mb-1.5 block text-[11px] font-medium">{t("models.searchModel")}</label>
            <PickModel
              models={models}
              providers={providers}
              providerId={defaultProvider}
              modelId={defaultModel}
              onSelect={setDefault}
            />
          </div>
          <div className="w-32">
            <label className="text-subtle-foreground mb-1.5 block text-[11px] font-medium">{t("models.thinking")}</label>
            <ThinkingLevelSelect
              value={thinkingLevel}
              onChange={setThinking}
              levels={
                models.find(
                  (m) =>
                    m.providerId === defaultProvider &&
                    m.modelId === defaultModel,
                )?.supportedThinkingLevels
              }
              triggerClassName="h-8 w-full text-xs"
            />
          </div>
        </div>
        {defaultProvider && defaultModel && (
          <p className="text-muted-foreground mt-2 text-[11.5px]">
            {t("models.current")} <span className="font-medium text-foreground">{defaultModel}</span>
            {` ${t("models.via")} `}
            <span className="font-medium text-foreground">{providerMap.get(defaultProvider)?.name ?? defaultProvider}</span>
          </p>
        )}
      </section>

      <Separator className="bg-hairline" />

      {/* Scoped models — Ctrl/Cmd+P cycling */}
      <section>
        <h3 className="text-muted-foreground mb-2 text-[10.5px] font-semibold tracking-[0.1em] uppercase">{t("models.scopedTitle")}</h3>
        <p className="text-muted-foreground mb-3 text-[11.5px] leading-[1.6]">
          {t("models.scopedHint")}
        </p>
        <Input
          placeholder={t("models.searchModels")}
          value={scopedSearch}
          onChange={(e) => setScopedSearch(e.target.value)}
          className="h-8 max-w-sm rounded-lg text-xs"
        />
        <div className="border-hairline bg-card/40 mt-3 max-h-56 overflow-y-auto rounded-xl border p-1.5">
          {scopedModels.length === 0 ? (
            <p className="text-subtle-foreground p-2 text-[11.5px]">{t("models.noMatching")}</p>
          ) : (
            scopedModels.map((model) => {
              const pattern = `${model.providerId}/${model.modelId}`
              return (
                <label
                  key={pattern}
                  className="hover:bg-muted/60 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 transition-colors"
                >
                  <Checkbox
                    checked={scoped.includes(pattern)}
                    onCheckedChange={() => toggleScoped(pattern)}
                  />
                  <span className="text-[12.5px]">{model.label}</span>
                  <span className="text-subtle-foreground ml-auto font-mono text-[10.5px]">
                    {pattern}
                  </span>
                </label>
              )
            })
          )}
        </div>
        <p className="text-subtle-foreground mt-2 text-[11px]">
          {scoped.length === 0
            ? t("models.noneScoped")
            : t("models.selected", { count: scoped.length })}
        </p>
      </section>

      <Separator className="bg-hairline" />

      {/* API Keys */}
      <section>
        <h3 className="text-muted-foreground mb-2 text-[10.5px] font-semibold tracking-[0.1em] uppercase">{t("models.apiKeys")}</h3>
        <div>
          {providers.map((p) => (
            <div key={p.id} className="border-hairline flex items-center gap-3 border-b py-2.5 last:border-b-0">
              <span className="text-muted-foreground w-28 shrink-0 text-[12.5px]">{p.name}</span>
              <div className="relative flex-1">
                <Key className="text-subtle-foreground absolute top-1/2 left-2 size-3 -translate-y-1/2" />
                <Input
                  type="password"
                  placeholder={p.hasAuth ? t("models.keySet") : t("models.enterKey", { provider: p.id })}
                  value={apiKeys[p.id] ?? ""}
                  onChange={(e) => setApiKeys((prev) => ({ ...prev, [p.id]: e.target.value }))}
                  className="h-8 rounded-lg pl-7 text-xs"
                />
              </div>
              <span className={`flex shrink-0 items-center gap-1 text-[11px] ${p.hasAuth ? "text-primary" : "text-subtle-foreground"}`}>
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

      <Separator className="bg-hairline" />

      {/* Custom providers */}
      <section>
        <h3 className="text-muted-foreground mb-2 text-[10.5px] font-semibold tracking-[0.1em] uppercase">{t("models.customProviders")}</h3>
        {customProviders.length === 0 ? (
          <p className="text-subtle-foreground text-[11.5px]">{t("models.noCustomProviders")}</p>
        ) : (
          <div className="space-y-2">
            {customProviders.map((cp, i) => (
              <div key={i} className="border-hairline bg-card flex items-center gap-3 rounded-xl border px-3.5 py-2.5">
                <span className="flex-1 text-[12.5px] font-medium">{cp.name ?? cp.id}</span>
                <span className="text-subtle-foreground truncate font-mono text-[11px]">{cp.baseUrl}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
