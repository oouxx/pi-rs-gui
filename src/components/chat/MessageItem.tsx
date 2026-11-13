import { memo } from "react";
import { motion } from "motion/react";
import { PANEL_TRANSITION } from "@/lib/motion";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, FileText, GitBranch } from "lucide-react";
import { useI18n } from "@/i18n";
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
            className="border-border max-h-64 rounded-md border"
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
/** Fork-at-message action (hidden until hover, like the copy button). */
function ForkButton({
  msg,
  onForkHere,
  className,
}: {
  msg: DisplayMessage;
  onForkHere?: (msg: DisplayMessage) => void;
  className: string;
}) {
  const { t } = useI18n();
  if (!onForkHere || msg.id.startsWith("msg-opt-")) return null;
  return (
    <button
      type="button"
      onClick={() => onForkHere(msg)}
      title={t("chat.forkFromHere")}
      aria-label={t("chat.forkFromHere")}
      className={className}
    >
      <GitBranch className="size-3.5" />
    </button>
  );
}

export const MessageItem = memo(function MessageItem({
  msg,
  streaming,
  isLast,
  onForkHere,
}: {
  msg: DisplayMessage;
  streaming: boolean;
  isLast: boolean;
  onForkHere?: (msg: DisplayMessage) => void;
}) {
  const isLastAi = msg.role === "assistant" && isLast;
  const userContent =
    msg.role === "user" ? parseAttachedFiles(msg.content) : null;
  return (
    <motion.div
      {...(isLast ? { "data-msg-last": "true" } : {})}
      className="group mx-auto w-full max-w-[820px]"
      // Only the newest message animates in; replayed transcripts mount all
      // messages at once and should not fade in as a block.
      initial={isLast ? { opacity: 0, y: 6 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={PANEL_TRANSITION}
    >
      {msg.role === "user" ? (
        /* User prompt in a subtle neutral box, full width */
        <div className="border-border bg-card relative rounded-lg border px-4 py-3 text-[15px] leading-relaxed text-foreground">
          <ForkButton
            msg={msg}
            onForkHere={onForkHere}
            className="text-subtle-foreground hover:text-muted-foreground absolute top-2 right-9 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          />
          <CopyButton
            text={msg.content}
            className="text-subtle-foreground hover:text-muted-foreground absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
          />
          <div className="break-words whitespace-pre-wrap">
            {userContent?.text}
          </div>
          {userContent && userContent.files.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {userContent.files.map((name, index) => (
                <span
                  key={`${name}-${index}`}
                  className="border-border bg-muted text-muted-foreground inline-flex max-w-[240px] items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]"
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
                className="border-border mt-2 max-h-48 rounded-lg border"
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
        /* Assistant answers are plain markdown, no bubble */
        <div className="text-foreground relative text-[15px] leading-relaxed">
          <ForkButton
            msg={msg}
            onForkHere={onForkHere}
            className="text-subtle-foreground hover:text-muted-foreground absolute -top-1 right-8 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          />
          <CopyButton
            text={msg.content}
            className="text-subtle-foreground hover:text-muted-foreground absolute -top-1 right-1 rounded p-1 opacity-0 transition-opacity group-hover:opacity-100"
          />
          {msg.blocks.length > 0 ? (
            msg.blocks.map((block, bi) => (
              <BlockRenderer key={`${msg.id}-b${bi}`} block={block} />
            ))
          ) : streaming && isLastAi ? (
            <span className="text-subtle-foreground inline-block animate-pulse">▍</span>
          ) : null}
        </div>
      )}
    </motion.div>
  );
});
