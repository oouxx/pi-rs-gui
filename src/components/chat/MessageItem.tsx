import { memo } from "react";
import { motion } from "motion/react";
import { PANEL_TRANSITION } from "@/lib/motion";
import ReactMarkdown from "react-markdown";
import { AlertCircle, FileText } from "lucide-react";
import { useI18n } from "@/i18n";
import { useThrottledText } from "@/hooks/use-throttled-text";
import type { ContentBlock, DisplayMessage } from "@/hooks/message-reducer";
import ToolCallCard from "@/components/ToolCallCard";
import ThinkingBlock from "@/components/ThinkingBlock";
import { CopyButton, mdComponents, rehypePlugins, remarkPlugins } from "./markdown";

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
  streaming,
}: {
  block: ContentBlock;
  streaming: boolean;
}) {
  const text = useThrottledText(
    block.type === "text" ? (block.text ?? "") : "",
    streaming && block.type === "text",
  );

  switch (block.type) {
    case "text":
      return text ? (
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={mdComponents}
        >
          {text}
        </ReactMarkdown>
      ) : null;

    case "thinking":
      return <ThinkingBlock thinking={block.thinking} streaming={streaming} />;

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
            className="border-hairline max-h-64 rounded-lg border"
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
  const { t } = useI18n();
  const isLastAi = msg.role === "assistant" && isLast;
  const userContent =
    msg.role === "user" ? parseAttachedFiles(msg.content) : null;
  return (
    <motion.div
      className="group mx-auto w-full max-w-[760px]"
      // Only the newest message animates in; replayed transcripts mount all
      // messages at once and should not fade in as a block.
      initial={isLast ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={PANEL_TRANSITION}
    >
      {msg.role === "user" ? (
        /* User prompt in a subtle neutral box, full width */
        <div className="border-hairline bg-secondary/60 text-foreground relative rounded-2xl border px-4 py-3 text-[15px] leading-[1.7]">
          <CopyButton
            text={msg.content}
            className="text-subtle-foreground hover:bg-background/70 hover:text-foreground absolute top-2 right-2 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100"
          />
          <div className="break-words whitespace-pre-wrap">
            {userContent?.text}
          </div>
          {userContent && userContent.files.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {userContent.files.map((name, index) => (
                <span
                  key={`${name}-${index}`}
                  className="border-hairline bg-background/60 text-muted-foreground inline-flex max-w-[240px] items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]"
                  title={name}
                >
                  <FileText className="text-subtle-foreground size-3 shrink-0" />
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
                className="border-hairline mt-2 max-h-48 rounded-lg border"
              />
            ))}
        </div>
      ) : msg.errorMessage ? (
        <div className="border-destructive/25 bg-destructive/[0.06] text-destructive relative flex items-start gap-2 rounded-xl border px-4 py-3 text-[13.5px] leading-relaxed">
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
          <div className="min-w-0 break-words whitespace-pre-wrap">
            {msg.errorMessage}
          </div>
        </div>
      ) : (
        /* Assistant answers are plain markdown, no bubble */
        <div className="text-foreground relative text-[15px] leading-[1.75]">
          <CopyButton
            text={msg.content}
            className="text-subtle-foreground hover:bg-muted hover:text-foreground absolute -top-1 right-1 rounded-md p-1 opacity-0 transition-opacity group-hover:opacity-100"
          />
          {msg.blocks.length > 0 ? (
            msg.blocks.map((block, bi) => (
              <BlockRenderer
                key={`${msg.id}-b${bi}`}
                block={block}
                streaming={streaming && isLastAi && bi === msg.blocks.length - 1}
              />
            ))
          ) : streaming && isLastAi ? (
            <span className="bg-primary ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse rounded-full align-middle" />
          ) : null}
          {msg.interrupted && (
            <div className="text-subtle-foreground mt-1.5 text-[12px]">
              {t("chat.stopped")}
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
});
