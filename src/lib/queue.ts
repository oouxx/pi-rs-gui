/**
 * `queue_update` → composer chips.
 *
 * The GUI does not own the steer / follow-up queues: the composer forwards
 * `streamingBehavior` to pi-rs, which holds the message until a turn boundary
 * (steer) or until the run settles (follow-up). pi-rs then emits
 * `AgentSessionEvent::QueueUpdate` with the queue contents, which the backend
 * forwards verbatim — so this event, not local bookkeeping, is what the chips
 * must show. A chip disappears exactly when the agent drains the message.
 *
 * Pure on purpose (no React/Tauri) so it can be unit-tested.
 */
import type { QueuedMessage } from "../api/types";

/** Map a forwarded `queue_update` payload onto composer chips. */
export function queuedFromQueueUpdate(data: unknown): QueuedMessage[] {
  const payload = (data ?? {}) as Record<string, unknown>;
  const chips: QueuedMessage[] = [];
  const push = (items: unknown, mode: QueuedMessage["mode"]) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      if (typeof item === "string" && item.length > 0) {
        chips.push({ text: item, mode });
      }
    }
  };
  // Steering first: it is delivered earlier than any follow-up.
  push(payload.steering, "steer");
  push(payload.follow_up, "followUp");
  return chips;
}

/**
 * Drop the chip for a message pi-rs refused to queue (`queue_error`).
 *
 * Matches on the prompt text, falling back to the newest chip: prepared
 * prompts (attachments, skill/template expansion) do not read like what the
 * user typed.
 */
export function removeQueuedChip(
  queued: readonly QueuedMessage[],
  text?: string,
): QueuedMessage[] {
  if (queued.length === 0) return queued as QueuedMessage[];
  const exact = text ? queued.findIndex((chip) => chip.text === text) : -1;
  const index = exact >= 0 ? exact : queued.length - 1;
  return queued.filter((_, i) => i !== index);
}
