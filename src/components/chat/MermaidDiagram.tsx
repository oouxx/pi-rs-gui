import { useEffect, useRef, useState } from "react";
import { AlertCircle, Code2, Image } from "lucide-react";
import { useI18n } from "@/i18n";

type RenderState = { svg: string; failed: boolean };

let counter = 0;

export default function MermaidDiagram({ code }: { code: string }) {
  const { t } = useI18n();
  const [state, setState] = useState<RenderState>({ svg: "", failed: false });
  const [showSource, setShowSource] = useState(false);
  const codeRef = useRef(code);
  codeRef.current = code;

  useEffect(() => {
    let alive = true;
    const id = `mermaid-${++counter}`;
    void (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme:
            document.documentElement.dataset.theme === "dark"
              ? "dark"
              : "neutral",
          fontFamily: "inherit",
        });
        const { svg } = await mermaid.render(id, codeRef.current);
        if (alive) setState({ svg, failed: false });
      } catch {
        if (alive) setState({ svg: "", failed: true });
      }
    })();
    return () => {
      alive = false;
    };
  }, [code]);

  if (showSource || state.failed) {
    return (
      <div className="border-border bg-muted my-2 overflow-hidden rounded-lg border">
        <div className="border-border text-subtle-foreground flex items-center justify-between border-b px-3 py-1.5 text-[11px]">
          <span className="inline-flex items-center gap-1.5">
            {state.failed && <AlertCircle className="size-3.5" />}
            mermaid
          </span>
          <button
            type="button"
            className="hover:text-foreground inline-flex items-center gap-1 transition-colors"
            onClick={() => setShowSource(!showSource)}
          >
            <Image className="size-3.5" />
            {t("chat.mermaidDiagram")}
          </button>
        </div>
        <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="border-border bg-muted group/mermaid relative my-2 overflow-hidden rounded-lg border">
      <button
        type="button"
        className="text-subtle-foreground hover:text-foreground absolute top-2 right-2 z-10 rounded p-1 opacity-0 transition-opacity group-hover/mermaid:opacity-100"
        onClick={() => setShowSource(true)}
        title={t("chat.mermaidSource")}
        aria-label={t("chat.mermaidSource")}
      >
        <Code2 className="size-3.5" />
      </button>
      {state.svg ? (
        <div
          className="mermaid-diagram flex justify-center overflow-x-auto p-3"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : (
        <div className="text-subtle-foreground p-3 font-mono text-xs">{code}</div>
      )}
    </div>
  );
}
