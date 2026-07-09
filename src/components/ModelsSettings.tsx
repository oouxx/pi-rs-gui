import { useCallback, useEffect, useState } from "react"
import { Separator } from "@/components/ui/separator"
import { listCustomProviders } from "../api/commands"

export default function ModelsSettings() {
  const [customProviders, setCustomProviders] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const custom = await listCustomProviders()
      setCustomProviders(custom as any[])
    } catch (e) { console.error("Failed to load model settings", e) }
    setLoading(false)
  }, [])

  useEffect(() => { refresh() }, [refresh])

  if (loading) {
    return <div className="text-muted-foreground p-8 text-sm">Loading models...</div>
  }

  return (
    <div className="space-y-8">
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
      <Separator />
      <p className="text-muted-foreground text-xs">
        Model and provider configuration is managed by the backend (pi-rs).
      </p>
    </div>
  )
}
