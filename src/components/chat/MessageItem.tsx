import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, FileText } from "lucide-react";
import type { ContentBlock, DisplayMessage } from "@/hooks/message-reducer";
import ToolCallCard from "@/components/ToolCallCard";
import ThinkingBlock from "@/components/ThinkingBlock";
import { CopyButton, mdComponents } from "./markdown";

function imageDataUrl(block: ContentBlock): string {
  if (block.data) {
    return block.data.startsWith("data:")
      ? block.data
      : `data:${block.mimeType || "image/png"};base64,${block.data}`;
  }
  const args = block.arguments as { data?: string } | string | undefined;
  return block.text ?? (typeof args === "object" ? args?.data : undefined) ?? "";
}

/** Split an inlined `<attached_files>` block from the user's prompt text so
 *  the bubble shows compact file chips instead of the raw file contents. */
function parseAttachedFiles(content: string): { text: string; files: string[] } {
  const match = content.match(
    /^([\s\S]*?)\s*<attached_files>\n([\s\S]*?)\n<\/attached_files>\s*$/,
  );
  if (!match) return { text: content, files: [] };
  const files = [...match[2].matchAll(/<file name="([^"]*)">/g)].map(
    (item) => item[1],
  );
  return { text: match[1].trim(), files };
}

/** Render a single content block. Memoized: unchanged block references skip
 *  re-render entirely, so a text_delta only re-renders the affected block.
 *  Text is rendered progressively (real-time markdown, like ChatGPT/Claude). */
const BlockRenderer = memo(function BlockRenderer({
  block,
}: {
  block: ContentBlock;
}) {
  switch (block.type) {
    case "text":
      return block.text ? (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {block.text}
        </ReactMarkdown>
      ) : null;

    case "thinking":
      return <ThinkingBlock thinking={block.thinking} />;

    case "toolCall":
      return (
        <ToolCallCard
          name={block.name ?? "tool"}
          args={block.arguments}
          status={block.status}
          result={block.result}
          isError={block.isError}
          details={block.details}
        />
      );

    case "image":
      return (
        <div className="my-2">
          <img
            src={imageDataUrl(block)}
            alt=""
            className="border-codex-border max-h-64 rounded-md border"
          />
        </div>
      );

    default:
      return null;
  }
});

/** A single transcript message. Memoized: during streaming only the last
 *  assistant message's props change (new blocks), so all other messages skip
 *  re-rendering entirely. */
export const MessageItem = memo(function MessageItem({
  msg,
  streaming,
  isLast,
}: {
  msg: DisplayMessage;
  streaming: boolean;
  isLast: boolean;
}) {
  const isLastAi = msg.role === "assistant" && isLast;
  const userContent =
    msg.role === "user" ? parseAttachedFiles(msg.content) : null;
  return (
    <div
      {...(isLast ? { "data-msg-last": "true" } : {})}
      className="group mx-auto w-full max-w-[820px]"
    >
      {msg.role === "user" ? (
        /* Codex desktop: user prompt in a subtle neutral box, full width */
        <div className="border-codex-border bg-codex-panel relative rounded-lg border px-4 py-3 text-[15px] leading-relaxed text-codex-text">
          <CopyButton
            text={msg.content}
            className="text-codex-faint hover:text-codex-dim absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
          />
          <div className="break-words whitespace-pre-wrap">
            {userContent?.text}
          </div>
          {userContent && userContent.files.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {userContent.files.map((name, index) => (
                <span
                  key={`${name}-${index}`}
                  className="border-codex-border bg-codex-inset text-codex-dim inline-flex max-w-[240px] items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]"
                  title={name}
                >
                  <FileText className="text-codex-faint size-3 shrink-0" />
                  <span className="truncate">{name}</span>
                </span>
              ))}
            </div>
          )}
          {msg.blocks
            .filter((b) => b.type === "image")
            .map((b, bi) => (
              <img
                key={`${msg.id}-img${bi}`}
                src={imageDataUrl(b)}
                alt=""
                className="border-codex-border mt-2 max-h-48 rounded-lg border"
              />
            ))}
        </div>
      ) : msg.errorMessage ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive relative flex items-start gap-2 rounded-lg border px-4 py-3 text-sm">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 break-words whitespace-pre-wrap">
            {msg.errorMessage}
          </div>
        </div>
      ) : (
        /* Codex web: assistant answers are plain markdown, no bubble */
        <div className="text-codex-text relative text-[15px] leading-relaxed">
          <CopyButton
            text={msg.content}
            className="text-codex-faint hover:text-codex-dim absolute -top-1 right-1 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
          />
          {msg.blocks.length > 0 ? (
            msg.blocks.map((block, bi) => (
              <BlockRenderer key={`${msg.id}-b${bi}`} block={block} />
            ))
          ) : streaming && isLastAi ? (
            <span className="text-codex-faint inline-block animate-pulse">▍</span>
          ) : null}
        </div>
      )}
    </div>
  );
});
