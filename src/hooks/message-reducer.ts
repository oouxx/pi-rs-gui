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
}

export interface DisplayMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string; // flattened text (backward compat)
  blocks: ContentBlock[]; // structured content blocks
  createdAt: string;
  errorMessage?: string; // assistant run failure (LLM error, timeout)
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
      },
    ],
  };
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
): DisplayMessage[] {
  if (prev.length === 0) return prev;
  const last = prev[prev.length - 1];
  if (last.role !== "assistant") return prev;
  const merged = [...last.blocks];
  merged.splice(offset, merged.length - offset, ...blocks);
  return [
    ...prev.slice(0, -1),
    {
      ...last,
      blocks: merged,
      content: blocksToText(merged),
      errorMessage: errorMessage ?? last.errorMessage,
    },
  ];
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
        createdAt: t.createdAt ?? "",
        errorMessage:
          typeof t.errorMessage === "string" && t.errorMessage
            ? t.errorMessage
            : undefined,
      };
    });
}
