/**
 * Pure message-assembly logic for the chat transcript.
 *
 * Mirrors the backend's `build_display_transcript` merge rules:
 * - consecutive assistant steps of a tool-calling run render as one bubble;
 * - tool results are attached to their `toolCall` block;
 * - streaming deltas are applied at a step offset inside the merged bubble.
 *
 * Kept free of React so it can be unit-tested with `bun test`.
 */

import type {
  AgentEventPayload,
  QueuedMessage,
  RawContentBlock,
  TextBlockDto,
  ToolCallBlockDto,
  TranscriptItem,
} from "../api/types";

// ── Frontend block/message shapes ────────────────────────────

export interface ContentBlock {
  type: "text" | "thinking" | "toolCall" | "image";
  text?: string;
  thinking?: string;
  id?: string; // toolCall.id
  name?: string; // toolCall.name
  arguments?: unknown; // toolCall.arguments
  // Image blocks: raw base64 data + mime type
  data?: string;
  mimeType?: string;
  // Frontend-only: execution state (set by tool_execution_* events)
  status?: "running" | "success" | "error";
  result?: string;
  isError?: boolean;
  /** Tool-specific payload (edit diff/patch, …). */
  details?: unknown;
  /** Images the tool returned (read on an image, screenshots, …). */
  images?: ContentBlock[];
}

/** A file a user prompt references (rendered as a chip, not as content). */
export interface MessageAttachment {
  name: string;
  size?: number;
  inlined?: boolean;
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string; // flattened text (backward compat)
  blocks: ContentBlock[]; // structured content blocks
  /** Files the prompt references (the wrapper is stripped from `content`). */
  attachments?: MessageAttachment[];
  createdAt: string;
  errorMessage?: string; // assistant run failure (LLM error, timeout)
  interrupted?: boolean; // user stopped the turn; content is partial
}

export interface StreamDelta {
  event_type: string;
  data: AgentEventPayload["data"];
  /** Block offset of the assistant step within its merged message. */
  offset?: number;
}

// ── Conversion helpers ───────────────────────────────────────

/** Extract text from an assistant message's content blocks. */
export function extractText(content: RawContentBlock[] | undefined): string {
  return (content ?? [])
    .filter((b): b is TextBlockDto => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/** Convert raw ContentBlock[] from the backend to our frontend ContentBlock[]. */
export function toBlocks(raw: RawContentBlock[] | undefined | null): ContentBlock[] {
  if (!raw) return [];
  return raw.map((b): ContentBlock => {
    switch (b.type) {
      case "text":
        return {
          type: "text",
          text: b.text,
          // Frontend-only execution state (present in transcript reloads where
          // the backend merges tool results onto toolCall blocks).
          status: b.status,
          result: b.result,
          isError: b.isError,
        };
      case "thinking":
        return { type: "thinking", thinking: b.thinking };
      case "toolCall":
        return {
          type: "toolCall",
          id: b.id,
          name: b.name,
          arguments: b.arguments,
          status: b.status,
          result: b.result,
          isError: b.isError,
          details: b.details,
          // Inline images the tool returned; kept so a reloaded session still
          // shows the screenshot / image a tool produced.
          images: Array.isArray(b.images)
            ? b.images.map((image) => ({
                type: "image" as const,
                data: image.data,
                mimeType: image.mimeType,
              }))
            : undefined,
        };
      case "image":
        return { type: "image", data: b.data, mimeType: b.mimeType };
      default:
        return { type: "text", text: "" };
    }
  });
}

/** Flatten blocks to a single text string. */
export function blocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("");
}

// ── Streaming deltas ─────────────────────────────────────────

function ensureIndex(blocks: ContentBlock[], idx: number): void {
  while (blocks.length <= idx) {
    blocks.push({ type: "text", text: "" });
  }
}

/** Apply one streaming delta to the last assistant bubble. */
export function applyDelta(prev: DisplayMessage[], d: StreamDelta): DisplayMessage[] {
  if (prev.length === 0) return prev;
  const last = prev[prev.length - 1];
  if (last.role !== "assistant") return prev;
  const { contentIndex, delta } = d.data;
  // Steps of a tool-calling run are merged into one message; each step's
  // deltas are offset by the block index where the step started.
  const idx = (d.offset ?? 0) + (contentIndex ?? 0);
  const blocks = [...last.blocks];

  switch (d.event_type) {
    case "text_delta": {
      if (typeof delta !== "string" || !delta) return prev;
      ensureIndex(blocks, idx);
      const b = blocks[idx];
      blocks[idx] = { type: "text", text: (b?.text ?? "") + delta };
      return [...prev.slice(0, -1), { ...last, blocks, content: blocksToText(blocks) }];
    }
    case "thinking_delta": {
      if (typeof delta !== "string" || !delta) return prev;
      ensureIndex(blocks, idx);
      const b = blocks[idx];
      blocks[idx] = { type: "thinking", thinking: (b?.thinking ?? "") + delta };
      return [...prev.slice(0, -1), { ...last, blocks }];
    }
    case "toolcall_start": {
      const src = (d.data.partial?.content?.[contentIndex ?? 0] ??
        {}) as Partial<ToolCallBlockDto>;
      ensureIndex(blocks, idx);
      blocks[idx] = {
        type: "toolCall",
        id: src.id ?? `tc-${idx}`,
        name: src.name ?? "tool",
        arguments: "",
      };
      return [...prev.slice(0, -1), { ...last, blocks }];
    }
    case "toolcall_delta": {
      if (typeof delta !== "string" || !delta) return prev;
      const b = blocks[idx];
      if (!b || b.type !== "toolCall") return prev;
      const prevArgs =
        typeof b.arguments === "string" ? b.arguments : JSON.stringify(b.arguments ?? "");
      blocks[idx] = { ...b, arguments: prevArgs + delta };
      return [...prev.slice(0, -1), { ...last, blocks }];
    }
    case "toolcall_end": {
      const toolCall = d.data.toolCall;
      if (!toolCall) return prev;
      ensureIndex(blocks, idx);
      blocks[idx] = {
        type: "toolCall",
        id: toolCall.id ?? `tc-${idx}`,
        name: toolCall.name ?? "tool",
        arguments: toolCall.arguments ?? {},
      };
      return [...prev.slice(0, -1), { ...last, blocks }];
    }
    default:
      return prev;
  }
}

export function applyDeltaBatch(
  prev: DisplayMessage[],
  deltas: StreamDelta[],
): DisplayMessage[] {
  let out = prev;
  for (const d of deltas) out = applyDelta(out, d);
  return out;
}

/**
 * Merge a new assistant step into the transcript: append its blocks to the
 * last assistant bubble when it belongs to the same tool-calling run, or start
 * a new bubble (mirrors the backend's transcript merge).
 *
 * Returns the step's block offset so streaming deltas can be applied to the
 * right position inside the merged bubble.
 */
export function appendAssistantStep(
  prev: DisplayMessage[],
  blocks: ContentBlock[],
  text: string,
  errorMessage?: string,
  interrupted?: boolean,
): { messages: DisplayMessage[]; stepOffset: number } {
  if (prev.length > 0) {
    const last = prev[prev.length - 1];
    if (last.role === "assistant") {
      const stepOffset = last.blocks.length;
      return {
        stepOffset,
        messages: [
          ...prev.slice(0, -1),
          {
            ...last,
            blocks: [...last.blocks, ...blocks],
            content: last.content + text,
            errorMessage: errorMessage ?? last.errorMessage,
            interrupted: interrupted ?? last.interrupted,
          },
        ],
      };
    }
  }
  return {
    stepOffset: 0,
    messages: [
      ...prev,
      {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: text,
        blocks,
        createdAt: new Date().toISOString(),
        errorMessage,
        interrupted,
      },
    ],
  };
}

/**
 * True once a tool call carries a real provider id.
 *
 * `toolcall_start` may arrive before the id does and the reducer stamps a
 * synthetic `tc-<index>`; such a block can only be found by name.
 */
function hasRealToolId(block: ContentBlock): boolean {
  return (
    typeof block.id === "string" &&
    block.id.length > 0 &&
    !block.id.startsWith("tc-")
  );
}

function isFinishedTool(block: ContentBlock): boolean {
  return block.status === "success" || block.status === "error";
}

/**
 * Index of the tool-call block a `tool_execution_*` event belongs to.
 *
 * - The id is authoritative.
 * - Otherwise match by **name**, but only against blocks that are still
 *   unresolved and still carry a synthetic id. Matching finished same-name
 *   blocks is what used to flip an earlier `edit` back to "Running" whenever
 *   the next `edit` started, leaving its timer running forever.
 */
export function findToolBlockIndex(
  blocks: readonly ContentBlock[],
  id?: string,
  name?: string,
): number {
  if (id) {
    const byId = blocks.findIndex((b) => b.type === "toolCall" && b.id === id);
    if (byId >= 0) return byId;
  }
  if (!name) return -1;
  return blocks.findIndex(
    (b) =>
      b.type === "toolCall" &&
      b.name === name &&
      !isFinishedTool(b) &&
      !hasRealToolId(b),
  );
}

export interface ToolExecutionEvent {
  /** `start` / `update` / `end` of one tool call. */
  phase: "start" | "update" | "end";
  id?: string;
  name?: string;
  /** `update`: raw partial result, already stringified by the caller. */
  appendResult?: string;
  /** `end`: final result text / error flag / details / inline images. */
  result?: string;
  isError?: boolean;
  details?: unknown;
  images?: ContentBlock[];
}

/**
 * Apply a tool-execution event to the transcript.
 *
 * The block is located with {@link findToolBlockIndex} and, when it was found
 * by name, gets the real id stamped on it — so the matching `end` (which may
 * only know the id) cannot drift onto another block.
 */
export function applyToolExecution(
  prev: DisplayMessage[],
  event: ToolExecutionEvent,
): DisplayMessage[] {
  // The execution events always belong to the step that is currently open, so
  // they target the newest assistant bubble. Scanning back (instead of
  // insisting the tail is an assistant message) keeps a tool result from being
  // dropped when a queued steer was just rendered after that bubble.
  let at = prev.length - 1;
  while (at >= 0 && prev[at].role !== "assistant") at -= 1;
  if (at < 0) return prev;
  const target = prev[at];
  const index = findToolBlockIndex(target.blocks, event.id, event.name);
  if (index < 0) return prev;
  const block = target.blocks[index];
  const next: ContentBlock = { ...block, id: event.id ?? block.id };
  switch (event.phase) {
    case "start":
      next.status = "running";
      break;
    case "update":
      next.result = (block.result ?? "") + (event.appendResult ?? "");
      break;
    case "end":
      next.status = event.isError ? "error" : "success";
      next.result = event.result ?? "";
      next.isError = !!event.isError;
      next.details = event.details;
      // Images the tool returned (read on an image, screenshots, …).
      if (event.images && event.images.length > 0) next.images = event.images;
      break;
  }
  const blocks = [...target.blocks];
  blocks[index] = next;
  const messages = [...prev];
  messages[at] = { ...target, blocks };
  return messages;
}

/**
 * Replace the current assistant step's blocks with the authoritative snapshot
 * from `message_done` / `message_end` (self-healing after streaming deltas).
 * Both events carry the same payload shape, so they share this logic.
 */
export function replaceAssistantStep(
  prev: DisplayMessage[],
  offset: number,
  blocks: ContentBlock[],
  errorMessage?: string,
  interrupted?: boolean,
): DisplayMessage[] {
  if (prev.length === 0) return prev;
  const last = prev[prev.length - 1];
  if (last.role !== "assistant") return prev;
  const merged = [...last.blocks];
  // The snapshot only describes the model's output: keep whatever the tool
  // execution events already learned about those calls, otherwise a late
  // snapshot turns a finished card back into "Pending".
  const carried = blocks.map((block, i) => {
    const before = last.blocks[offset + i];
    if (!before || before.type !== "toolCall" || block.type !== "toolCall") {
      return block;
    }
    if (before.id !== block.id) return block;
    return {
      ...block,
      status: before.status,
      result: before.result,
      isError: before.isError,
      details: before.details,
      images: before.images,
    };
  });
  merged.splice(offset, merged.length - offset, ...carried);
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      blocks: merged,
      content: blocksToText(merged),
      errorMessage: errorMessage ?? last.errorMessage,
      interrupted: interrupted ?? last.interrupted,
    },
  ];
}

// ── Queued (steer / follow-up) delivery ─────────────────────

/**
 * A user message pi-rs just inserted into the context.
 *
 * The GUI only forwards `streamingBehavior`; pi-rs holds the text in its own
 * queue and emits `MessageStart` for it when it is actually inserted (a turn
 * boundary for steer, settle for follow-up). Rendering it here is what makes a
 * delivered steer visible *at the point it landed* instead of only after the
 * whole run's transcript refresh.
 *
 * Returns `null` for the caller's own prompt (`MessageStart` is emitted for it
 * too; it already has an optimistic bubble) — the queued chips are the only
 * signal that this message came out of the queue.
 */
export function deliverQueuedUserMessage(
  prev: DisplayMessage[],
  queued: readonly QueuedMessage[],
  text: string,
  blocks: ContentBlock[],
): { messages: DisplayMessage[]; queued: QueuedMessage[] } | null {
  if (queued.length === 0 || !text.trim()) return null;
  // Exact match first (the common case: steer text is queued verbatim), then
  // fall back to the oldest chip — pi-rs drains in queue order, and prepared
  // prompts (attachments, skill/template expansion) differ from what was typed.
  const exact = queued.findIndex((item) => item.text === text);
  const index = exact >= 0 ? exact : 0;
  const message: DisplayMessage = {
    id: `msg-queued-${Date.now()}`,
    role: "user",
    content: text,
    blocks,
    createdAt: new Date().toISOString(),
  };
  return {
    messages: [...prev, message],
    queued: queued.filter((_, i) => i !== index),
  };
}

// ── Transcript reload ────────────────────────────────────────

/** Convert a backend display transcript to the frontend message list. */
export function transcriptToDisplay(
  transcript: readonly TranscriptItem[],
): DisplayMessage[] {
  return transcript
    .filter((t) => t.kind === "message" || t.role)
    .map((t) => {
      // Prefer structured content blocks from the backend (text/thinking/toolCall
      // with merged tool execution state); fall back to flattened text.
      const rawBlocks = Array.isArray(t.content) ? t.content : null;
      const blocks: ContentBlock[] =
        rawBlocks && rawBlocks.length > 0
          ? toBlocks(rawBlocks)
          : [{ type: "text" as const, text: t.text ?? "" }];
      return {
        id: t.id ?? `msg-${Math.random().toString(36).slice(2, 8)}`,
        role: t.role === "user" ? ("user" as const) : ("assistant" as const),
        content: t.text ?? blocksToText(blocks) ?? "",
        blocks,
        attachments: Array.isArray(t.attachments)
          ? t.attachments.map((file) => ({
              name: file.name,
              size: file.size,
              inlined: file.inlined,
            }))
          : undefined,
        createdAt: t.createdAt ?? "",
        errorMessage:
          typeof t.errorMessage === "string" && t.errorMessage
            ? t.errorMessage
            : undefined,
        interrupted: t.interrupted === true,
      };
    });
}
