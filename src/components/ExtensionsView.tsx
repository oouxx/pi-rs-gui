import { useCallback, useEffect, useMemo, useState } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Puzzle, Search, TerminalSquare, SlashSquare } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/components/ui/toast";
import { useI18n } from "@/i18n";
import { listExtensions, setExtensionEnabled } from "@/api/commands";

interface ExtensionCommand {
  name: string;
  description: string;
}

interface Extension {
  name: string;
  location: "builtin";
  tools: string[];
  commands: ExtensionCommand[];
  enabled: boolean;
}

const CATEGORIES = [
  { id: "all", labelKey: "extensions.all" },
  { id: "builtin", labelKey: "extensions.builtin" },
] as const;

type CatId = (typeof CATEGORIES)[number]["id"];

export default function ExtensionsView() {
  const { toast } = useToast();
  const { t } = useI18n();
  const [activeCat, setActiveCat] = useState<CatId>("all");
  const [search, setSearch] = useState("");
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const items = await listExtensions();
      setExtensions((items ?? []) as Extension[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const toggleExtension = useCallback(
    async (extension: Extension, enabled: boolean) => {
      setBusy(extension.name);
      try {
        const result = await setExtensionEnabled(extension.name, enabled);
        if (result.applied === false && result.warning) {
          toast({
            title: `${extension.name} ${t(enabled ? "extensions.enabled" : "extensions.disabled")}`,
            description: result.warning,
            variant: "error",
          });
        } else {
          toast({
            title: `${extension.name} ${t(enabled ? "extensions.enabled" : "extensions.disabled")}`,
            variant: "success",
          });
        }
        await refresh();
      } catch (e) {
        toast({
          title: t("extensions.updateFailed"),
          description: e instanceof Error ? e.message : String(e),
          variant: "error",
        });
      } finally {
        setBusy(null);
      }
    },
    [refresh, toast, t],
  );

  const counts = useMemo(() => {
    const c: Record<CatId, number> = {
      all: extensions.length,
      builtin: extensions.filter((e) => e.location === "builtin").length,
    };
    return c;
  }, [extensions]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return extensions.filter((e) => {
      if (activeCat !== "all" && e.location !== activeCat) return false;
      if (!q) return true;
      return (
        e.name.toLowerCase().includes(q) ||
        e.tools.some((t) => t.toLowerCase().includes(q)) ||
        e.commands.some((c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      );
    });
  }, [extensions, activeCat, search]);

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="shrink-0" />
        <div className="text-foreground text-sm font-medium">{t("extensions.title")}</div>
      </div>

      {/* Two-panel body */}
      <div className="flex min-h-0 flex-1">
        {/* Left — categories */}
        <div className="border-hairline w-48 shrink-0 border-r p-3">
          <nav className="flex flex-col gap-1">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCat(cat.id)}
                className={`flex items-center justify-between rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                  activeCat === cat.id
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <span>{t(cat.labelKey)}</span>
                <span className="text-muted-foreground text-xs">{counts[cat.id]}</span>
              </button>
            ))}
          </nav>
        </div>

        {/* Right — content */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="border-hairline flex items-center gap-3 border-b px-4 py-2">
            <div className="relative max-w-sm flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder={t("extensions.search")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          {/* List / empty state */}
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                {t("extensions.loading")}
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <div className="text-destructive text-xs">{error}</div>
                <Button size="sm" variant="outline" onClick={refresh}>
                  {t("common.retry")}
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-sm text-center">
                  <div className="bg-muted/30 mx-auto mb-4 flex size-16 items-center justify-center rounded-full">
                    <Puzzle className="text-muted-foreground size-8" />
                  </div>
                  <h3 className="text-foreground mb-1 text-sm font-medium">
                    {t("extensions.emptyTitle")}
                  </h3>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {t("extensions.emptyHint")}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {filtered.map((e) => (
                  <div
                    key={e.name}
                    className={`border-hairline bg-card hover:bg-accent/5 flex flex-col gap-2 rounded-lg border p-3 ${
                      e.enabled ? "" : "opacity-60"
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={e.enabled}
                        disabled={busy === e.name}
                        onCheckedChange={(checked) =>
                          toggleExtension(e, checked === true)
                        }
                        aria-label={t("extensions.enableAria", { name: e.name })}
                      />
                      <span className="text-foreground font-mono text-sm font-medium">
                        {e.name}
                      </span>
                      <span className="bg-muted text-foreground/70 rounded-full px-2 py-0.5 text-[10px] uppercase">
                        {e.location}
                      </span>
                      <span
                        className={`ml-auto text-[10px] uppercase ${
                          e.enabled
                            ? "text-success"
                            : "text-muted-foreground"
                        }`}
                      >
                        {t(e.enabled ? "extensions.enabled" : "extensions.disabled")}
                      </span>
                    </div>

                    {e.tools.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <TerminalSquare className="text-muted-foreground size-3.5" />
                        {e.tools.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}

                    {e.commands.length > 0 && (
                      <div className="flex flex-col gap-1">
                        {e.commands.map((c) => (
                          <div key={c.name} className="flex items-start gap-1.5">
                            <SlashSquare className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
                            <div className="min-w-0">
                              <span className="text-foreground/90 font-mono text-xs">
                                /{c.name}
                              </span>
                              <span className="text-muted-foreground ml-2 text-xs">
                                {c.description}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
