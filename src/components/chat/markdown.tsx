import { useState } from "react";
import type { Components } from "react-markdown";
import { Copy, Check } from "lucide-react";
import { useI18n } from "@/i18n";

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
          className="bg-muted text-foreground rounded-md px-1.5 py-0.5 font-mono text-[12px]"
          {...props}
        >
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <div className="group/code relative my-2">
      <pre className="text-foreground border-border bg-muted overflow-x-auto rounded-lg border p-3 pr-10 font-mono text-xs leading-relaxed">
        {children}
      </pre>
      <CopyButton
        text={nodeText(children)}
        className="text-subtle-foreground hover:text-muted-foreground absolute top-2 right-2 rounded p-1 opacity-0 transition-opacity group-hover/code:opacity-100"
      />
    </div>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse font-mono text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="text-muted-foreground border-border border-b bg-muted px-3 py-2 text-left font-medium">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="text-muted-foreground border-border border-b px-3 py-2">{children}</td>
  ),
  a: ({ children, href }) => (
    <a
      href={href}
      className="text-primary font-medium hover:underline"
      target="_blank"
      rel="noreferrer"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="my-1 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1 list-decimal space-y-1 pl-5">{children}</ol>,
  h1: ({ children }) => <h1 className="mt-3 mb-1 text-base font-semibold">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 text-sm font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 text-sm font-medium">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-2 mb-1 text-sm font-medium">{children}</h4>,
  h5: ({ children }) => <h5 className="mt-1 text-xs font-medium">{children}</h5>,
  h6: ({ children }) => <h6 className="mt-1 text-xs font-medium">{children}</h6>,
  p: ({ children }) => <p className="my-1.5">{children}</p>,
  hr: () => <hr className="border-border my-3" />,
};
