/**
 * Tool-result → display payload conversion.
 *
 * pi-rs returns an `AgentToolResult` for every tool call. Its `content` is a
 * list of content blocks: text, plus inline **images** for tools that produce
 * them (the `read` tool on an image file, screenshot/MCP/extension tools). Both
 * the streaming event (`tool_execution_end`) and the reloaded transcript carry
 * the same shape, so the mapping lives here — pure, so it can be unit-tested.
 *
 * Kept free of React/Tauri imports on purpose.
 */

export interface ToolResultImage {
  type: "image";
  /** Raw base64 (no `data:` prefix). */
  data?: string;
  mimeType?: string;
}

export interface ToolResultPayload {
  /** Text blocks joined; falls back to pretty-printed JSON for exotic tools. */
  text: string;
  /** Tool-specific payload (edit diff/patch, subagent results, …). */
  details?: unknown;
  /** Inline images the tool returned, in order. */
  images: ToolResultImage[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** Collect `{type:"image", data, mimeType}` blocks out of a content array. */
export function imagesFromContent(content: unknown): ToolResultImage[] {
  if (!Array.isArray(content)) return [];
  const images: ToolResultImage[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record || record.type !== "image") continue;
    const data = typeof record.data === "string" ? record.data : undefined;
    const mimeType =
      typeof record.mimeType === "string"
        ? record.mimeType
        : typeof record.mime_type === "string"
          ? record.mime_type
          : undefined;
    if (!data && !mimeType) continue;
    images.push({ type: "image", data, mimeType });
  }
  return images;
}

/** Translate an `AgentToolResult` (or a bare string) for the transcript UI. */
export function toolResultPayload(result: unknown): ToolResultPayload {
  if (typeof result === "string") {
    return { text: result, images: [] };
  }
  const record = asRecord(result);
  if (!record) {
    return { text: result == null ? "" : String(result), images: [] };
  }
  const images = imagesFromContent(record.content);
  let text = "";
  if (Array.isArray(record.content)) {
    text = record.content
      .map((block) => {
        const item = asRecord(block);
        return item && item.type === "text" ? String(item.text ?? "") : "";
      })
      .join("");
  }
  if (!text && images.length > 0) {
    // Image-only results (a screenshot tool with no note): describe it instead
    // of dumping the base64 into the card.
    text = "";
  } else if (!text) {
    text = JSON.stringify(result, null, 2);
  }
  return { text, details: record.details, images };
}
