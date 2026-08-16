import { useCallback, useEffect, useMemo, useState } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { BookOpen, FolderOpen, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { getActiveSessionCwd, getAgentDir, listSkills, openPath } from "@/api/commands";

interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope: "global" | "workspace" | "custom";
  disableModelInvocation: boolean;
}

const CATEGORIES = [
  { id: "all", label: "All Skills" },
  { id: "global", label: "Global" },
  { id: "workspace", label: "Workspace" },
  { id: "custom", label: "Custom Paths" },
] as const;

type CatId = (typeof CATEGORIES)[number]["id"];

const SCOPE_LABEL: Record<string, string> = {
  global: "Global",
  workspace: "Workspace",
  custom: "Custom",
};

export default function SkillsView() {
  const [activeCat, setActiveCat] = useState<CatId>("all");
  const [search, setSearch] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const cwd = await getActiveSessionCwd();
      const items = await listSkills(cwd);
      setSkills((items ?? []) as Skill[]);
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
    const c: Record<CatId, number> = { all: skills.length, global: 0, workspace: 0, custom: 0 };
    for (const s of skills) {
      if (s.scope in c) c[s.scope as CatId] += 1;
    }
    return c;
  }, [skills]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return skills.filter((s) => {
      if (activeCat !== "all" && s.scope !== activeCat) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.filePath.toLowerCase().includes(q)
      );
    });
  }, [skills, activeCat, search]);

  const openSkillsDir = useCallback(async () => {
    try {
      const agentDir = await getAgentDir();
      await openPath(`${agentDir}/skills`);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="shrink-0" />
        <div className="text-foreground text-sm font-medium">Skills</div>
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
                placeholder="Search skills..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
            <Button size="sm" onClick={openSkillsDir}>
              <FolderOpen className="size-3.5" />
              <span>Open Skills Folder</span>
            </Button>
          </div>

          {/* List / empty state */}
          <div className="flex-1 overflow-y-auto p-4">
            {loading ? (
              <div className="flex h-full items-center justify-center text-muted-foreground text-xs">
                Loading skills...
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
                    <BookOpen className="text-muted-foreground size-8" />
                  </div>
                  <h3 className="text-foreground mb-1 text-sm font-medium">No skills found</h3>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    Skills extend pi-gui's capabilities with custom prompts and
                    tools. Open the skills folder to add one.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {filtered.map((s) => (
                  <div
                    key={s.name}
                    className="border-hairline bg-card hover:bg-accent/5 flex flex-col gap-1 rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-foreground font-mono text-sm font-medium">
                        {s.name}
                      </span>
                      <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] uppercase">
                        {SCOPE_LABEL[s.scope] ?? s.scope}
                      </span>
                      {s.disableModelInvocation && (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                          manual only
                        </span>
                      )}
                    </div>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {s.description}
                    </p>
                    <p className="text-muted-foreground/70 font-mono text-[10px]">
                      {s.filePath}
                    </p>
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
