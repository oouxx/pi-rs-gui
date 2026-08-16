import { useCallback, useEffect, useMemo, useState } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Puzzle, Search, TerminalSquare, SlashSquare } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { listExtensions } from "@/api/commands";

interface ExtensionCommand {
  name: string;
  description: string;
}

interface Extension {
  name: string;
  location: "builtin";
  tools: string[];
  commands: ExtensionCommand[];
}

const CATEGORIES = [
  { id: "all", label: "All Extensions" },
  { id: "builtin", label: "Builtin" },
] as const;

type CatId = (typeof CATEGORIES)[number]["id"];

export default function ExtensionsView() {
  const [activeCat, setActiveCat] = useState<CatId>("all");
  const [search, setSearch] = useState("");
  const [extensions, setExtensions] = useState<Extension[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        <div className="text-foreground text-sm font-medium">Extensions</div>
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
                    ? "bg-accent/10 text-accent font-medium"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <span>{cat.label}</span>
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
                placeholder="Search extensions..."
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
                Loading extensions...
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <div className="text-destructive text-xs">{error}</div>
                <Button size="sm" variant="outline" onClick={refresh}>
                  Retry
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-sm text-center">
                  <div className="bg-muted/30 mx-auto mb-4 flex size-16 items-center justify-center rounded-full">
                    <Puzzle className="text-muted-foreground size-8" />
                  </div>
                  <h3 className="text-foreground mb-1 text-sm font-medium">
                    No extensions found
                  </h3>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Extensions are compiled into pi-gui as Rust plugins and are
                    always available to the agent.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {filtered.map((e) => (
                  <div
                    key={e.name}
                    className="border-hairline bg-card hover:bg-accent/5 flex flex-col gap-2 rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-foreground font-mono text-sm font-medium">
                        {e.name}
                      </span>
                      <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] uppercase">
                        {e.location}
                      </span>
                    </div>

                    {e.tools.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        <TerminalSquare className="text-muted-foreground size-3.5" />
                        {e.tools.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-blue-500/10 px-1.5 py-0.5 font-mono text-[10px] text-blue-600 dark:text-blue-400"
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
