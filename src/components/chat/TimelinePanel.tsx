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

const KIND_ICON: Record<string, { icon: React.ReactNode; className: string }> = {
  message: { icon: <MessageSquare className="size-3" />, className: "" },
  model_change: { icon: <Cog className="size-3" />, className: "text-blue-500" },
  thinking_level_change: { icon: <Cog className="size-3" />, className: "text-purple-500" },
  compaction: { icon: <Scissors className="size-3" />, className: "text-amber-500" },
  branch_summary: { icon: <GitBranch className="size-3" />, className: "text-emerald-500" },
  session_info: { icon: <MessageSquare className="size-3" />, className: "text-codex-faint" },
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

  return (
    <div>
      <div
        className={`group flex cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-left text-xs transition-colors ${
          node.current
            ? "bg-codex-green/10 text-codex-green font-medium"
            : "text-codex-faint hover:bg-codex-panel-2 hover:text-codex-dim"
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
              className="hover:bg-codex-panel-3 rounded p-0.5"
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
        <span className="text-codex-dim min-w-0 flex-1 truncate">
          {node.label}
        </span>
        {node.current && (
          <span className="bg-codex-green text-white shrink-0 rounded-full px-1.5 text-[9px]">
            here
          </span>
        )}
        <button
          type="button"
          title="Fork session at this point"
          onClick={(e) => {
            e.stopPropagation();
            onFork(node.id);
          }}
          className="text-codex-faint hover:text-codex-green shrink-0 rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100"
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
      } finally {
        setBusy(false);
      }
    },
    [busy, sessionId, onTreeChange],
  );

  return (
    <div className="border-codex-border bg-white flex w-72 shrink-0 flex-col border-l">
      <div className="border-codex-border flex items-center gap-2 border-b px-3 py-2">
        <GitBranch className="text-codex-faint size-3.5" />
        <span className="text-codex-text flex-1 text-xs font-medium">
          Timeline
        </span>
        <button
          type="button"
          onClick={onClose}
          className="text-codex-faint hover:text-codex-dim rounded p-0.5 transition-colors"
          title="Close timeline"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {tree.length === 0 ? (
          <p className="text-codex-faint px-2 py-4 text-center text-xs">
            No timeline yet
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
        <div className="text-codex-faint mt-2 flex items-center gap-1.5 px-2 text-[10px]">
          <CornerUpLeft className="size-3" />
          Click a node to jump to that branch point
        </div>
      </div>
    </div>
  );
}
