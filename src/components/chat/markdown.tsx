import { useState } from "react";
import type { Components } from "react-markdown";
import { Copy, Check } from "lucide-react";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { useI18n } from "@/i18n";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import MermaidDiagram from "@/components/chat/MermaidDiagram";

export const remarkPlugins = [remarkGfm, remarkMath];
export const rehypePlugins = [rehypeKatex];

/** Flatten a React node tree to its text (for code-block copy buttons). */
export function nodeText(node: React.ReactNode): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  const maybe = node as { props?: { children?: React.ReactNode } };
  if (maybe && typeof maybe === "object" && maybe.props?.children !== undefined) {
    return nodeText(maybe.props.children);
  }
  return "";
}

export function CopyButton({
  text,
  className,
  label,
}: {
  text: string;
  className?: string;
  label?: string;
}) {
  const [copied, setCopied] = useState(false);
  const { t } = useI18n();
  return (
    <button
      type="button"
      title={copied ? t("common.copied") : label ?? t("common.copy")}
      aria-label={copied ? t("common.copied") : label ?? t("common.copy")}
      onClick={() => {
        navigator.clipboard?.writeText(text).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      className={
        className ??
        "text-muted-foreground hover:text-foreground rounded p-1 transition-colors"
      }
    >
      {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

function CodeBlock({
  className,
  code,
  children: _children,
  ...props
}: {
  className?: string;
  code: string;
} & React.HTMLAttributes<HTMLElement>) {
  const language = className?.match(/language-([\w+#-]+)/)?.[1];
  const html = useHighlightedCode(code, language);
  if (!html) {
    return (
      <code className={className} {...props}>
        {code}
      </code>
    );
  }
  return (
    <code
      className={`${className ?? ""} md-code`}
      {...props}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function fencedCode(
  node: React.ReactNode,
): { code: string; language?: string } | null {
  if (node == null || typeof node !== "object") return null;
  const props = (
    node as {
      props?: { className?: string; children?: React.ReactNode; code?: unknown };
    }
  ).props;
  if (!props) return null;
  const code =
    typeof props.code === "string" ? props.code : nodeText(props.children);
  if (!code) return null;
  return {
    code,
    language: props.className?.match(/language-([\w+#-]+)/)?.[1],
  };
}

export const mdComponents: Components = {
  code: ({ className, children, ...props }) => {
    // react-markdown v9 does not pass an `inline` prop. A fenced block without
    // a language has no className either, so fall back to a newline check to
    // distinguish block code from inline code. Block code is wrapped by the
    // `pre` component below (no nested <pre> here).
    const text = nodeText(children);
    const isInline = !className && !text.includes("\n");
    if (isInline) {
      return (
        <code
          className="bg-muted/80 text-foreground rounded-[5px] px-1.5 py-[0.12em] font-mono text-[0.88em]"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <CodeBlock className={className} code={text} {...props}>
        {children}
      </CodeBlock>
    );
  },
  pre: ({ children }) => {
    const fenced = fencedCode(children);
    if (fenced?.language === "mermaid" && fenced.code) {
      return <MermaidDiagram code={fenced.code} />;
    }
    return (
      <div className="group/code border-hairline bg-muted/50 my-3 overflow-hidden rounded-xl border">
        <div className="border-hairline flex h-8 items-center justify-between border-b pl-3.5 pr-2">
          <span className="text-subtle-foreground font-mono text-[10px] tracking-[0.12em] uppercase">
            {fenced?.language ?? "code"}
          </span>
          <CopyButton
            text={nodeText(children)}
            className="text-subtle-foreground hover:bg-background/70 hover:text-foreground rounded-md p-1 opacity-0 transition-opacity group-hover/code:opacity-100 focus-visible:opacity-100"
          />
        </div>
        <pre className="text-foreground overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.7]">
          {children}
        </pre>
      </div>
    );
  },
  table: ({ children }) => (
    <div className="border-hairline my-3 overflow-x-auto rounded-xl border">
      <table className="w-full border-collapse text-[12.5px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="text-muted-foreground border-hairline bg-muted/50 border-b px-3 py-2 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-hairline border-b px-3 py-2">{children}</td>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-primary font-medium underline-offset-4 hover:underline"
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1.5 pl-5 marker:text-subtle-foreground">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1.5 pl-5 marker:text-subtle-foreground">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  h1: ({ children }) => (
    <h1 className="mt-6 mb-2 text-[1.25rem] font-semibold tracking-[-0.01em] first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 mb-2 text-[1.08rem] font-semibold tracking-[-0.01em] first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-5 mb-1.5 text-[0.98rem] font-semibold first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="mt-4 mb-1.5 text-[0.94rem] font-medium first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="mt-3 mb-1 text-[0.88rem] font-medium first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="text-subtle-foreground mt-3 mb-1 text-[0.82rem] font-medium tracking-wide uppercase first:mt-0">
      {children}
    </h6>
  ),
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  blockquote: ({ children }) => (
    <blockquote className="border-primary/30 text-muted-foreground my-3 border-l-2 pl-4">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-hairline my-6" />,
};
