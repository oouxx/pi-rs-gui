import { useCallback, useEffect, useMemo, useState } from "react";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  BookOpen,
  ExternalLink,
  Eye,
  FileCode,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { useChatContext } from "@/hooks/ChatProvider";
import {
  getActiveSessionCwd,
  listPromptTemplates,
  listSkills,
  openFile,
  readTextFile,
} from "@/api/commands";
import type { PromptTemplateInfo } from "@/api/types";

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
  const { activeSessionId, activeSessionCwd } = useChatContext();
  const { toast } = useToast();
  const [view, setView] = useState<"skills" | "prompts">("skills");
  const [activeCat, setActiveCat] = useState<CatId>("all");
  const [search, setSearch] = useState("");
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<PromptTemplateInfo[]>([]);
  const [promptsLoading, setPromptsLoading] = useState(false);
  const [promptsError, setPromptsError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{
    title: string;
    path: string;
    content: string;
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const cwd = activeSessionCwd ?? (await getActiveSessionCwd());
      const items = await listSkills(cwd);
      setSkills((items ?? []) as Skill[]);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [activeSessionCwd]);

  // Follow the selected session: workspace skills depend on its cwd.
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

  const refreshPrompts = useCallback(async () => {
    setPromptsLoading(true);
    try {
      setPrompts((await listPromptTemplates()) ?? []);
      setPromptsError(null);
    } catch (e) {
      setPromptsError(e instanceof Error ? e.message : String(e));
    } finally {
      setPromptsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === "prompts") refreshPrompts();
  }, [view, refreshPrompts, activeSessionId]);

  const filteredPrompts = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return prompts;
    return prompts.filter(
      (prompt) =>
        prompt.name.toLowerCase().includes(query) ||
        prompt.description.toLowerCase().includes(query) ||
        prompt.filePath.toLowerCase().includes(query),
    );
  }, [prompts, search]);

  const openPreview = useCallback(
    async (title: string, path: string) => {
      setPreview({ title, path, content: "" });
      setPreviewLoading(true);
      setPreviewError(null);
      try {
        const cwd = activeSessionCwd ?? (await getActiveSessionCwd());
        const content = await readTextFile(path, cwd);
        setPreview((prev) => (prev ? { ...prev, content } : prev));
      } catch (e) {
        setPreviewError(e instanceof Error ? e.message : String(e));
      } finally {
        setPreviewLoading(false);
      }
    },
    [activeSessionCwd],
  );

  const openFileInEditor = useCallback(
    async (path: string) => {
      try {
        await openFile(path);
      } catch (e) {
        toast({
          variant: "error",
          title: "Failed to open file",
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [toast],
  );

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex items-center gap-3 border-b px-4 py-1.5">
        <SidebarTrigger className="shrink-0" />
        <div className="text-foreground text-sm font-medium">
          {view === "skills" ? "Skills" : "Prompts"}
        </div>
        <div className="border-hairline ml-auto flex items-center gap-0.5 rounded-md border p-0.5">
          {(["skills", "prompts"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setView(item);
                setSearch("");
              }}
              className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                view === item
                  ? "bg-accent/10 text-accent font-medium"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {item === "skills" ? "Skills" : "Prompts"}
            </button>
          ))}
        </div>
      </div>

      {/* Two-panel body */}
      <div className="flex min-h-0 flex-1">
        {/* Left — categories */}
        {view === "skills" && (
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
        )}

        {/* Right — content */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="border-hairline flex items-center gap-3 border-b px-4 py-2">
            <div className="relative max-w-sm flex-1">
              <Search className="text-muted-foreground absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder={
                  view === "skills" ? "Search skills..." : "Search prompts..."
                }
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="h-8 pl-8 text-xs"
              />
            </div>
            {view === "skills" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={refresh}
                disabled={loading}
              >
                <RefreshCw
                  className={`size-3.5 ${loading ? "animate-spin" : ""}`}
                />
                <span>Refresh</span>
              </Button>
            ) : (
              <Button size="sm" variant="outline" onClick={refreshPrompts}>
                <RefreshCw className="size-3.5" />
                <span>Refresh</span>
              </Button>
            )}
          </div>

          {/* List / empty state */}
          <div className="flex-1 overflow-y-auto p-4">
            {view === "prompts" ? (
              promptsLoading ? (
                <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
                  Loading prompts...
                </div>
              ) : promptsError ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <div className="text-destructive text-xs">{promptsError}</div>
                  <Button size="sm" variant="outline" onClick={refreshPrompts}>
                    Retry
                  </Button>
                </div>
              ) : filteredPrompts.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <div className="bg-muted/30 mx-auto mb-4 flex size-16 items-center justify-center rounded-full">
                      <FileCode className="text-muted-foreground size-8" />
                    </div>
                    <h3 className="text-foreground mb-1 text-sm font-medium">
                      No prompt templates found
                    </h3>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      Prompts are Markdown files in the agent or project prompt
                      directories. Add more through the Prompt paths setting.
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {filteredPrompts.map((prompt) => (
                    <div
                      key={prompt.filePath}
                      onClick={() =>
                        openPreview(`/${prompt.name}`, prompt.filePath)
                      }
                      className="border-hairline bg-card hover:bg-accent/5 flex cursor-pointer flex-col gap-1 rounded-lg border p-3"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-foreground font-mono text-sm font-medium">
                          /{prompt.name}
                        </span>
                        <span className="bg-muted text-foreground/70 rounded-full px-2 py-0.5 text-[10px] uppercase">
                          {prompt.source}
                        </span>
                        {prompt.append && (
                          <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] text-blue-600 dark:text-blue-400">
                            append
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openPreview(`/${prompt.name}`, prompt.filePath);
                            }}
                            className="text-muted-foreground hover:text-foreground"
                            title="Preview"
                          >
                            <Eye className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openFileInEditor(prompt.filePath);
                            }}
                            className="text-muted-foreground hover:text-foreground"
                            title="Open in editor"
                          >
                            <ExternalLink className="size-3.5" />
                          </button>
                        </div>
                      </div>
                      {prompt.argumentHint && (
                        <span className="text-muted-foreground font-mono text-[10px]">
                          {prompt.argumentHint}
                        </span>
                      )}
                      <p className="text-muted-foreground text-xs leading-relaxed">
                        {prompt.description}
                      </p>
                      <p className="text-muted-foreground/70 font-mono text-[10px]">
                        {prompt.filePath}
                      </p>
                    </div>
                  ))}
                </div>
              )
            ) : loading ? (
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
                    tools. Add SKILL.md under the agent or project skills
                    directory.
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {filtered.map((s) => (
                  <div
                    key={s.filePath}
                    onClick={() => openPreview(s.name, s.filePath)}
                    className="border-hairline bg-card hover:bg-accent/5 flex cursor-pointer flex-col gap-1 rounded-lg border p-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-foreground font-mono text-sm font-medium">
                        {s.name}
                      </span>
                      <span className="bg-muted text-foreground/70 rounded-full px-2 py-0.5 text-[10px] uppercase">
                        {SCOPE_LABEL[s.scope] ?? s.scope}
                      </span>
                      {s.disableModelInvocation && (
                        <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-600 dark:text-amber-400">
                          manual only
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openPreview(s.name, s.filePath);
                          }}
                          className="text-muted-foreground hover:text-foreground"
                          title="Preview"
                        >
                          <Eye className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openFileInEditor(s.filePath);
                          }}
                          className="text-muted-foreground hover:text-foreground"
                          title="Open in editor"
                        >
                          <ExternalLink className="size-3.5" />
                        </button>
                      </div>
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

      <Dialog
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) {
            setPreview(null);
            setPreviewError(null);
          }
        }}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{preview?.title}</DialogTitle>
            <DialogDescription className="font-mono text-[11px] break-all">
              {preview?.path}
            </DialogDescription>
          </DialogHeader>
          {previewLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          ) : previewError ? (
            <div className="text-destructive text-xs break-words">
              {previewError}
            </div>
          ) : (
            <pre className="border-hairline bg-muted/30 max-h-[60vh] overflow-auto rounded-lg border p-3 font-mono text-[11px] whitespace-pre-wrap">
              {preview?.content}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
