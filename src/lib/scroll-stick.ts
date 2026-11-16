export const BOTTOM_THRESHOLD = 8;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export type ScrollSource = "user" | "auto";

export function distanceToBottom(m: ScrollMetrics): number {
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

export function isAtBottom(m: ScrollMetrics): boolean {
  return distanceToBottom(m) <= BOTTOM_THRESHOLD;
}

export function nextStickState(
  current: boolean,
  m: ScrollMetrics,
  source: ScrollSource,
): boolean {
  if (isAtBottom(m)) return true;
  return source === "auto" ? current : false;
}

export function bottomScrollTop(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight);
}
