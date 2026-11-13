import { useCallback, useState } from "react";
import {
  X,
  GitBranch,
  ChevronRight,
  ChevronDown,
  CornerUpLeft,
  MessageSquare,
  Cog,
  Scissors,
} from "lucide-react";
import { navigateSessionTree, type SessionTreeNode } from "@/api/commands";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/ui/toast";

const KIND_ICON: Record<string, { icon: React.ReactNode; className: string }> = {
  message: { icon: <MessageSquare className="size-3" />, className: "" },
  model_change: { icon: <Cog className="size-3" />, className: "text-primary" },
  thinking_level_change: { icon: <Cog className="size-3" />, className: "text-muted-foreground" },
  compaction: { icon: <Scissors className="size-3" />, className: "text-warning" },
  branch_summary: { icon: <GitBranch className="size-3" />, className: "text-success" },
  session_info: { icon: <MessageSquare className="size-3" />, className: "text-subtle-foreground" },
};

function TreeNode({
  node,
  depth,
  onNavigate,
  onFork,
  collapsed,
  onToggle,
}: {
  node: SessionTreeNode;
  depth: number;
  onNavigate: (id: string) => void;
  onFork: (id: string) => void;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const meta = KIND_ICON[node.kind] ?? KIND_ICON.session_info;
  const { t } = useI18n();

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors ${
          node.current
            ? "bg-success/10 text-success font-medium"
            : "text-subtle-foreground hover:bg-secondary hover:text-muted-foreground"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        onClick={() => onNavigate(node.id)}
      >
        <span className="flex w-3 shrink-0 justify-center">
          {hasChildren ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggle(node.id);
              }}
              className="hover:bg-accent rounded p-0.5"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
            </button>
          ) : (
            <span className="size-3" />
          )}
        </span>
        <span className={`shrink-0 ${meta.className}`}>{meta.icon}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate">
          {node.label}
        </span>
        {node.current && (
          <span className="bg-primary text-primary-foreground shrink-0 rounded-full px-1.5 text-[9px]">
            {t("timeline.here")}
          </span>
        )}
        <button
          type="button"
          title={t("timeline.forkHere")} aria-label={t("timeline.forkHere")}
          onClick={(e) => {
            e.stopPropagation();
            onFork(node.id);
          }}
          className="text-subtle-foreground hover:text-success shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <GitBranch className="size-3" />
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <div>
          {node.children.map((c) => (
            <TreeNode
              key={c.id}
              node={c}
              depth={depth + 1}
              onNavigate={onNavigate}
              onFork={onFork}
              collapsed={collapsed}
              onToggle={onToggle}
            />
          ))}
        </div>
      )}
    </div>
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
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const { t } = useI18n();
  const { toast } = useToast();

  const toggle = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const navigate = useCallback(
    async (entryId: string) => {
      if (busy) return;
      setBusy(true);
      try {
        const updated = await navigateSessionTree(sessionId, entryId);
        onTreeChange(updated ?? []);
      } catch (e) {
        console.error("[navigate]", e);
        toast({
          variant: "error",
          title: t("timeline.title"),
          description: e instanceof Error ? e.message : String(e),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId, onTreeChange, t, toast],
  );

  return (
    <div className="border-border bg-background flex min-h-0 w-72 shrink-0 flex-col border-l">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <GitBranch className="text-subtle-foreground size-3.5" />
        <span className="text-foreground flex-1 text-xs font-medium">
          {t("timeline.title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-subtle-foreground hover:text-muted-foreground rounded p-0.5 transition-colors"
          title={t("timeline.close")} aria-label={t("timeline.close")}
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tree.length === 0 ? (
          <p className="text-subtle-foreground px-2 py-4 text-center text-xs">
            {t("timeline.empty")}
          </p>
        ) : (
          tree.map((n) => (
            <TreeNode
              key={n.id}
              node={n}
              depth={0}
              onNavigate={navigate}
              onFork={onFork}
              collapsed={collapsed}
              onToggle={toggle}
            />
          ))
        )}
        <div className="text-subtle-foreground mt-2 flex items-center gap-1.5 px-2 text-[10px]">
          <CornerUpLeft className="size-3" />
          {t("timeline.hint")}
        </div>
      </div>
    </div>
  );
}
