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
      <div className="border-hairline bg-muted/50 my-3 overflow-hidden rounded-xl border">
        <div className="border-hairline text-subtle-foreground flex h-8 items-center justify-between border-b pl-3.5 pr-2 text-[10px] tracking-[0.12em] uppercase">
          <span className="inline-flex items-center gap-1.5 font-mono">
            {state.failed && <AlertCircle className="size-3.5" />}
            mermaid
          </span>
          <button
            type="button"
            className="hover:bg-background/70 hover:text-foreground inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[10px] tracking-normal normal-case transition-colors"
            onClick={() => setShowSource(!showSource)}
          >
            <Image className="size-3.5" />
            {t("chat.mermaidDiagram")}
          </button>
        </div>
        <pre className="overflow-x-auto px-3.5 py-3 font-mono text-[12.5px] leading-[1.7]">
          <code>{code}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="border-hairline bg-muted/30 group/mermaid relative my-3 overflow-hidden rounded-xl border">
      <button
        type="button"
        className="text-subtle-foreground hover:bg-background/70 hover:text-foreground absolute top-2 right-2 z-10 rounded-md p-1 opacity-0 transition-opacity group-hover/mermaid:opacity-100 focus-visible:opacity-100"
        onClick={() => setShowSource(true)}
        title={t("chat.mermaidSource")}
        aria-label={t("chat.mermaidSource")}
      >
        <Code2 className="size-3.5" />
      </button>
      {state.svg ? (
        <div
          className="mermaid-diagram flex justify-center overflow-x-auto p-4"
          dangerouslySetInnerHTML={{ __html: state.svg }}
        />
      ) : (
        <div className="text-subtle-foreground p-3.5 font-mono text-[12.5px]">{code}</div>
      )}
    </div>
  );
}
