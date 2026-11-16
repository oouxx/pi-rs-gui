import type { SessionTreeNode } from "@/api/types";
import type { DisplayMessage } from "@/hooks/message-reducer";

export interface MessageBox {
  parentKey: string;
  ids: string[];
  index: number;
}

function walk(
  nodes: readonly SessionTreeNode[],
  parentKey: string,
  byParent: Map<string, SessionTreeNode[]>,
) {
  for (const node of nodes) {
    const siblings = byParent.get(parentKey);
    if (siblings) siblings.push(node);
    else byParent.set(parentKey, [node]);
    walk(node.children, node.id, byParent);
  }
}

function messageTimestamp(id: string): number | null {
  if (!id.startsWith("msg-")) return null;
  const value = Number(id.slice(4));
  return Number.isFinite(value) ? value : null;
}

export function buildVersions(
  messages: readonly DisplayMessage[],
  tree: readonly SessionTreeNode[],
): Map<string, MessageBox> {
  const out = new Map<string, MessageBox>();
  if (tree.length === 0) return out;

  const byParent = new Map<string, SessionTreeNode[]>();
  walk(tree, "root", byParent);

  const bySecond = new Map<string, SessionTreeNode[]>();
  for (const node of byParent.values()) {
    for (const item of node) {
      if (item.kind !== "message" || !item.role) continue;
      const key = `${item.role}:${Math.floor(Date.parse(item.timestamp) / 1000)}`;
      const bucket = bySecond.get(key);
      if (bucket) bucket.push(item);
      else bySecond.set(key, [item]);
    }
  }

  for (const message of messages) {
    const timestamp = messageTimestamp(message.id);
    if (timestamp === null) continue;
    const key = `${message.role}:${Math.floor(timestamp / 1000)}`;
    const matches = bySecond.get(key) ?? [];
    if (matches.length !== 1) continue;

    const node = matches[0];
    const parentKey = node.parentId ?? "root";
    const siblings = (byParent.get(parentKey) ?? [])
      .filter((item) => item.kind === "message" && item.role === message.role)
      .map((item) => item.id);
    if (siblings.length < 2) continue;

    out.set(message.id, {
      parentKey,
      ids: siblings,
      index: Math.max(0, siblings.indexOf(node.id)),
    });
  }

  return out;
}
