import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";

type ToastVariant = "default" | "success" | "error";

interface ToastItem {
  id: number;
  title?: string;
  description?: string;
  variant: ToastVariant;
}

interface ToastInput {
  title?: string;
  description?: string;
  variant?: ToastVariant;
}

const ToastContext = createContext<{ toast: (t: ToastInput) => void }>({
  toast: () => {},
});

export function useToast() {
  return useContext(ToastContext);
}

const variantStyles: Record<ToastVariant, { box: string; icon: ReactNode }> = {
  default: { box: "border-hairline bg-popover text-foreground", icon: null },
  success: {
    box: "border-hairline bg-popover text-foreground",
    icon: <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-green-500" />,
  },
  error: {
    box: "border-red-500/40 bg-popover text-foreground",
    icon: <AlertCircle className="mt-0.5 size-4 shrink-0 text-red-500" />,
  },
};

/** Minimal toast provider — fixed stack top-right, auto-dismiss. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((t: ToastInput) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, variant: t.variant ?? "default", ...t }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 4500);
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed top-4 right-4 z-[100] flex w-80 flex-col gap-2">
        {toasts.map((t) => {
          const s = variantStyles[t.variant];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg ${s.box}`}
              role="status"
            >
              {s.icon}
              <div className="min-w-0 flex-1">
                {t.title && (
                  <div className="font-medium">{t.title}</div>
                )}
                {t.description && (
                  <div className="text-muted-foreground mt-0.5 text-xs break-words">
                    {t.description}
                  </div>
                )}
              </div>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
                onClick={() =>
                  setToasts((prev) => prev.filter((x) => x.id !== t.id))
                }
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
