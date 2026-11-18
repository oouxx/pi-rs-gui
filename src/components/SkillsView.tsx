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
import { useI18n } from "@/i18n";
import { useChatContext } from "@/hooks/ChatProvider";
import {
  getActiveSessionCwd,
  listPromptTemplates,
  listSkills,
  openFile,
  readTextFile,
} from "@/api/commands";
import type { PromptTemplateInfo } from "@/api/types";
import { errorText } from "@/lib/errors";

interface Skill {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  scope: "global" | "workspace" | "custom";
  disableModelInvocation: boolean;
}

const CATEGORIES = [
  { id: "all", labelKey: "skills.all" },
  { id: "global", labelKey: "skills.global" },
  { id: "workspace", labelKey: "skills.workspace" },
  { id: "custom", labelKey: "skills.customPaths" },
] as const;

type CatId = (typeof CATEGORIES)[number]["id"];

const SCOPE_LABEL_KEY: Record<string, "skills.global" | "skills.workspace" | "skills.custom"> = {
  global: "skills.global",
  workspace: "skills.workspace",
  custom: "skills.custom",
};

export default function SkillsView() {
  const { activeSessionId, activeSessionCwd } = useChatContext();
  const { toast } = useToast();
  const { t } = useI18n();
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
      setError(errorText(e));
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
      setPromptsError(errorText(e));
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
        setPreviewError(errorText(e));
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
          title: t("skills.failedToOpen"),
          description: errorText(e),
        });
      }
    },
    [toast, t],
  );

  return (
    <div className="flex h-full max-h-screen min-w-0 flex-1 flex-col">
      {/* Top bar */}
      <div className="border-hairline flex h-12 shrink-0 items-center gap-1.5 border-b px-3">
        <SidebarTrigger className="text-subtle-foreground hover:text-foreground -ml-1 size-7 shrink-0" />
        <div className="text-foreground text-[13px] font-medium">
          {t(view === "skills" ? "skills.title" : "skills.promptsTitle")}
        </div>
        <div className="bg-muted/60 ml-auto flex items-center gap-0.5 rounded-lg p-0.5">
          {(["skills", "prompts"] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setView(item);
                setSearch("");
              }}
              className={`h-7 rounded-md px-2.5 text-[11.5px] transition-colors ${
                view === item
                  ? "bg-card text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(item === "skills" ? "skills.title" : "skills.promptsTitle")}
            </button>
          ))}
        </div>
      </div>

      {/* Two-panel body */}
      <div className="flex min-h-0 flex-1">
        {/* Left — categories */}
        {view === "skills" && (
        <div className="border-hairline w-44 shrink-0 border-r p-2">
          <nav className="flex flex-col gap-0.5">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                onClick={() => setActiveCat(cat.id)}
                className={`flex h-8 items-center justify-between rounded-lg px-2 text-left text-[13px] transition-colors ${
                  activeCat === cat.id
                    ? "bg-accent text-accent-foreground font-medium"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }`}
              >
                <span>{t(cat.labelKey)}</span>
                <span className="text-subtle-foreground text-[10.5px] tabular-nums">{counts[cat.id]}</span>
              </button>
            ))}
          </nav>
        </div>
        )}

        {/* Right — content */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Toolbar */}
          <div className="border-hairline flex h-12 shrink-0 items-center gap-2 border-b px-4">
            <div className="relative max-w-sm flex-1">
              <Search className="text-subtle-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
              <Input
                placeholder={t(
                  view === "skills" ? "skills.search" : "skills.searchPrompts",
                )}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="border-hairline bg-background/70 placeholder:text-subtle-foreground h-8 rounded-lg pl-8 text-[12.5px] focus-visible:ring-2 md:text-[12.5px]"
              />
            </div>
            {view === "skills" ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground h-8 rounded-lg px-2.5 text-[12px]"
                onClick={refresh}
                disabled={loading}
              >
                <RefreshCw
                  className={`size-3.5 ${loading ? "animate-spin" : ""}`}
                />
                <span>{t("common.refresh")}</span>
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground h-8 rounded-lg px-2.5 text-[12px]"
                onClick={refreshPrompts}
              >
                <RefreshCw className="size-3.5" />
                <span>{t("common.refresh")}</span>
              </Button>
            )}
          </div>

          {/* List / empty state */}
          <div className="flex-1 overflow-y-auto p-5">
            {view === "prompts" ? (
              promptsLoading ? (
                <div className="text-subtle-foreground flex h-full items-center justify-center text-[12px]">
                  {t("skills.loadingPrompts")}
                </div>
              ) : promptsError ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                  <div className="text-destructive text-[11.5px]">{promptsError}</div>
                  <Button size="sm" variant="outline" onClick={refreshPrompts}>
                    {t("common.retry")}
                  </Button>
                </div>
              ) : filteredPrompts.length === 0 ? (
                <div className="flex h-full items-center justify-center">
                  <div className="max-w-sm text-center">
                    <div className="bg-muted/30 mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-hairline">
                      <FileCode className="text-subtle-foreground size-5" />
                    </div>
                    <h3 className="text-foreground mb-1 text-[13.5px] font-medium">
                      {t("skills.emptyPromptsTitle")}
                    </h3>
                    <p className="text-muted-foreground text-[11.5px] leading-[1.6]">
                      {t("skills.emptyPromptsHint")}
                    </p>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {filteredPrompts.map((prompt) => (
                    <div
                      key={prompt.filePath}
                      onClick={() =>
                        openPreview(`/${prompt.name}`, prompt.filePath)
                      }
                      className="border-hairline bg-card hover:bg-muted/30 flex cursor-pointer flex-col gap-1.5 rounded-xl border p-3.5 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-foreground font-mono text-[13px] font-medium">
                          /{prompt.name}
                        </span>
                        <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-[9.5px] tracking-[0.04em] uppercase">
                          {prompt.source}
                        </span>
                        {prompt.append && (
                          <span className="bg-primary/10 text-primary rounded-md px-1.5 py-0.5 text-[9.5px]">
                            {t("skills.append")}
                          </span>
                        )}
                        <div className="ml-auto flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openPreview(`/${prompt.name}`, prompt.filePath);
                            }}
                            className="text-subtle-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors"
                            title={t("common.preview")} aria-label={t("common.preview")}
                          >
                            <Eye className="size-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              openFileInEditor(prompt.filePath);
                            }}
                            className="text-subtle-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors"
                            title={t("common.openInEditor")} aria-label={t("common.openInEditor")}
                          >
                            <ExternalLink className="size-3.5" />
                          </button>
                        </div>
                      </div>
                      {prompt.argumentHint && (
                        <span className="text-subtle-foreground font-mono text-[10.5px]">
                          {prompt.argumentHint}
                        </span>
                      )}
                      <p className="text-muted-foreground text-[11.5px] leading-[1.6]">
                        {prompt.description}
                      </p>
                      <p className="text-subtle-foreground truncate font-mono text-[10.5px]" title={prompt.filePath}>
                        {prompt.filePath}
                      </p>
                    </div>
                  ))}
                </div>
              )
            ) : loading ? (
              <div className="text-subtle-foreground flex h-full items-center justify-center text-[12px]">
                {t("skills.loading")}
              </div>
            ) : error ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <div className="text-destructive text-[11.5px]">{error}</div>
                <Button size="sm" variant="outline" onClick={refresh}>
                  {t("common.retry")}
                </Button>
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <div className="max-w-sm text-center">
                  <div className="bg-muted/30 mx-auto mb-4 flex size-12 items-center justify-center rounded-xl border border-hairline">
                    <BookOpen className="text-subtle-foreground size-5" />
                  </div>
                  <h3 className="text-foreground mb-1 text-[13.5px] font-medium">
                    {t("skills.emptyTitle")}
                  </h3>
                  <p className="text-muted-foreground text-[11.5px] leading-[1.6]">
                    {t("skills.emptyHint")}
                  </p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-2.5">
                {filtered.map((s) => (
                  <div
                    key={s.filePath}
                    onClick={() => openPreview(s.name, s.filePath)}
                    className="border-hairline bg-card hover:bg-muted/30 flex cursor-pointer flex-col gap-1.5 rounded-xl border p-3.5 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-foreground font-mono text-[13px] font-medium">
                        {s.name}
                      </span>
                      <span className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-[9.5px] tracking-[0.04em] uppercase">
                        {SCOPE_LABEL_KEY[s.scope] ? t(SCOPE_LABEL_KEY[s.scope]) : s.scope}
                      </span>
                      {s.disableModelInvocation && (
                        <span className="bg-warning/10 text-warning rounded-md px-1.5 py-0.5 text-[9.5px]">
                          {t("skills.manualOnly")}
                        </span>
                      )}
                      <div className="ml-auto flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openPreview(s.name, s.filePath);
                          }}
                          className="text-subtle-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors"
                          title={t("common.preview")} aria-label={t("common.preview")}
                        >
                          <Eye className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openFileInEditor(s.filePath);
                          }}
                          className="text-subtle-foreground hover:bg-muted hover:text-foreground rounded-md p-1 transition-colors"
                          title={t("common.openInEditor")} aria-label={t("common.openInEditor")}
                        >
                          <ExternalLink className="size-3.5" />
                        </button>
                      </div>
                    </div>
                    <p className="text-muted-foreground text-[11.5px] leading-[1.6]">
                      {s.description}
                    </p>
                    <p className="text-subtle-foreground truncate font-mono text-[10.5px]" title={s.filePath}>
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
            <div className="text-subtle-foreground flex items-center gap-2 p-6 text-[12px]">
              <Loader2 className="size-4 animate-spin" />
              {t("common.loading")}
            </div>
          ) : previewError ? (
            <div className="text-destructive text-[11.5px] break-words">
              {previewError}
            </div>
          ) : (
            <pre className="border-hairline bg-muted/30 max-h-[60vh] overflow-auto rounded-xl border p-3.5 font-mono text-[11.5px] leading-[1.65] whitespace-pre-wrap">
              {preview?.content}
            </pre>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
