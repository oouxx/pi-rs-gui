import { useMemo, useState, type ReactNode } from "react";
import {
  X,
  GitBranch,
  MessageSquare,
  Scissors,
  Cog,
  Sparkles,
  Info,
  Wrench,
  Undo2,
  ArrowDownToLine,
  CornerUpLeft,
  Loader2,
} from "lucide-react";
import { navigateSessionTree, type SessionTreeNode } from "@/api/commands";
import { useI18n, type TranslationKey } from "@/i18n";
import { useToast } from "@/components/ui/toast";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const KIND_META: Record<string, { icon: ReactNode; color: string }> = {
  message: {
    icon: <MessageSquare className="size-3" />,
    color: "text-muted-foreground",
  },
  compaction: { icon: <Scissors className="size-3" />, color: "text-warning" },
  branch_summary: {
    icon: <GitBranch className="size-3" />,
    color: "text-primary",
  },
  model_change: {
    icon: <Cog className="size-3" />,
    color: "text-muted-foreground",
  },
  thinking_level_change: {
    icon: <Sparkles className="size-3" />,
    color: "text-muted-foreground",
  },
  usage: { icon: <Info className="size-3" />, color: "text-subtle-foreground" },
  context_edit: {
    icon: <Wrench className="size-3" />,
    color: "text-muted-foreground",
  },
};

const DEFAULT_META = {
  icon: <Cog className="size-3" />,
  color: "text-subtle-foreground",
};

const KIND_LABEL_KEY: Partial<Record<string, TranslationKey>> = {
  compaction: "timeline.compaction",
  branch_summary: "timeline.branch",
  model_change: "timeline.model",
  thinking_level_change: "timeline.thinking",
  usage: "timeline.usage",
  context_edit: "timeline.contextEdit",
  custom: "timeline.event",
  custom_message: "timeline.event",
  label: "timeline.label",
  session_info: "timeline.sessionInfo",
};

function isMessageNode(node: SessionTreeNode): boolean {
  return (
    node.kind === "message" &&
    (node.role === "user" || node.role === "assistant")
  );
}

/** Only user/assistant messages and context boundaries are checkpoints. */
function isCheckpoint(node: SessionTreeNode): boolean {
  if (node.kind === "message") return isMessageNode(node);
  return node.kind === "compaction" || node.kind === "branch_summary";
}

function hasVisibleContent(node: SessionTreeNode, showAll: boolean): boolean {
  if (showAll) {
    if (node.kind === "message" && !isMessageNode(node)) return false;
    return true;
  }
  return isCheckpoint(node) || node.children.some((c) => hasVisibleContent(c, showAll));
}

function flatten(nodes: SessionTreeNode[], out: SessionTreeNode[] = []) {
  for (const node of nodes) {
    out.push(node);
    flatten(node.children, out);
  }
  return out;
}

function relativeTime(iso: string, language: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return "";
  const seconds = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (abs < 60) return rtf.format(seconds, "second");
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), "hour");
  return rtf.format(Math.round(seconds / 86400), "day");
}

interface RowProps {
  nodes: SessionTreeNode[];
  depth: number;
  showAll: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onRewind: (node: SessionTreeNode) => void;
  onFork: (id: string) => void;
  language: string;
  t: (key: TranslationKey) => string;
}

function TreeRows({
  nodes,
  depth,
  showAll,
  selectedId,
  onSelect,
  onRewind,
  onFork,
  language,
  t,
}: RowProps) {
  return (
    <>
      {nodes.map((node) => {
        if (!hasVisibleContent(node, showAll)) return null;
        const visible = showAll ? !(node.kind === "message" && !isMessageNode(node)) : isCheckpoint(node);
        const meta = KIND_META[node.kind] ?? DEFAULT_META;
        const label =
          node.kind === "message"
            ? node.role === "user"
              ? t("timeline.you")
              : t("timeline.ai")
            : t(KIND_LABEL_KEY[node.kind] ?? "timeline.event");
        const selected = selectedId === node.id;
        return (
          <div key={node.id}>
            {visible && (
              <div
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => onSelect(node.id)}
                className={`group flex items-start gap-1.5 rounded-md py-1.5 pr-1.5 text-left transition-colors ${
                  selected
                    ? "bg-accent text-accent-foreground"
                    : node.current
                      ? "bg-primary/5"
                      : "hover:bg-muted/60"
                }`}
              >
                <span className={`mt-0.5 shrink-0 ${meta.color}`}>
                  {meta.icon}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] font-medium">{label}</span>
                    {node.current && (
                      <span className="bg-primary/10 text-primary rounded-full px-1.5 py-0.5 text-[9px] font-medium">
                        {t("timeline.current")}
                      </span>
                    )}
                    <span className="text-subtle-foreground ml-auto shrink-0 text-[10px]">
                      {relativeTime(node.timestamp, language)}
                    </span>
                  </div>
                  {node.detail && (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px] break-words whitespace-pre-wrap">
                      {node.detail}
                    </p>
                  )}
                </div>
                <div
                  className={`flex shrink-0 items-center gap-0.5 ${
                    selected
                      ? "opacity-100"
                      : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
                  }`}
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRewind(node);
                    }}
                    title={t("timeline.rewind")}
                    aria-label={t("timeline.rewind")}
                    className="text-subtle-foreground hover:bg-primary/10 hover:text-primary rounded p-1 transition-colors"
                  >
                    <Undo2 className="size-3" />
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onFork(node.id);
                    }}
                    title={t("timeline.fork")}
                    aria-label={t("timeline.fork")}
                    className="text-subtle-foreground hover:bg-primary/10 hover:text-primary rounded p-1 transition-colors"
                  >
                    <GitBranch className="size-3" />
                  </button>
                </div>
              </div>
            )}
            {node.children.length > 0 && (
              <TreeRows
                nodes={node.children}
                depth={visible ? depth + 1 : depth}
                showAll={showAll}
                selectedId={selectedId}
                onSelect={onSelect}
                onRewind={onRewind}
                onFork={onFork}
                language={language}
                t={t}
              />
            )}
          </div>
        );
      })}
    </>
  );
}

export function TimelinePanel({
  tree,
  sessionId,
  onClose,
  onTreeChange,
  onFork,
}: {
  tree: SessionTreeNode[];
  sessionId: string;
  onClose: () => void;
  onTreeChange: (tree: SessionTreeNode[]) => void;
  onFork: (id: string) => void;
}) {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const [showAll, setShowAll] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingRewind, setPendingRewind] = useState<SessionTreeNode | null>(
    null,
  );
  const [busy, setBusy] = useState(false);

  const flat = useMemo(() => flatten(tree), [tree]);
  const current = flat.find((node) => node.current);
  const latestLeaf = useMemo(() => {
    let best: SessionTreeNode | undefined;
    for (const node of flat) {
      if (node.children.length > 0) continue;
      if (!best || Date.parse(node.timestamp) > Date.parse(best.timestamp)) {
        best = node;
      }
    }
    return best;
  }, [flat]);
  const hasVisible = tree.some((node) => hasVisibleContent(node, showAll));

  const navigate = async (node: SessionTreeNode) => {
    if (busy) return;
    setBusy(true);
    try {
      const updated = await navigateSessionTree(sessionId, node.id);
      onTreeChange(updated ?? []);
      setSelectedId(null);
      toast({ variant: "success", title: t("timeline.rewound") });
    } catch (e) {
      console.error("[navigate]", e);
      toast({
        variant: "error",
        title: t("timeline.rewindFailed"),
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
      setPendingRewind(null);
    }
  };

  return (
    <div className="border-border bg-background flex min-h-0 w-80 shrink-0 flex-col border-l">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <GitBranch className="text-subtle-foreground size-3.5" />
        <span className="text-foreground flex-1 text-xs font-medium">
          {t("timeline.title")}
        </span>
        {latestLeaf && current?.id !== latestLeaf.id && (
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => navigate(latestLeaf)}
            title={t("timeline.latest")}
          >
            <ArrowDownToLine className="size-3" />
            {t("timeline.latest")}
          </Button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="text-subtle-foreground hover:text-muted-foreground rounded p-0.5 transition-colors"
          title={t("timeline.close")}
          aria-label={t("timeline.close")}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {hasVisible ? (
          <TreeRows
            nodes={tree}
            depth={0}
            showAll={showAll}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onRewind={setPendingRewind}
            onFork={onFork}
            language={language}
            t={t}
          />
        ) : (
          <p className="text-subtle-foreground px-2 py-4 text-center text-xs">
            {t("timeline.empty")}
          </p>
        )}
        <div className="text-subtle-foreground mt-2 flex items-center gap-1.5 px-2 text-[10px]">
          <CornerUpLeft className="size-3" />
          {t("timeline.hint")}
        </div>
      </div>

      <div className="border-border flex items-center gap-2 border-t px-3 py-2">
        <Checkbox
          id="timeline-show-all"
          checked={showAll}
          onCheckedChange={(checked) => setShowAll(checked === true)}
        />
        <label
          htmlFor="timeline-show-all"
          className="text-muted-foreground text-[11px] select-none"
        >
          {t("timeline.showAll")}
        </label>
      </div>

      <Dialog
        open={!!pendingRewind}
        onOpenChange={(open) => {
          if (!open && !busy) setPendingRewind(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("timeline.rewindTitle")}</DialogTitle>
            <DialogDescription>
              {t("timeline.rewindDescription")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              autoFocus
              disabled={busy}
              onClick={() => setPendingRewind(null)}
            >
              {t("sidebar.cancel")}
            </Button>
            <Button
              disabled={busy}
              onClick={() => pendingRewind && navigate(pendingRewind)}
            >
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              {t("timeline.rewind")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
