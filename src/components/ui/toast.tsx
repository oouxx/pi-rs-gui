import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useI18n } from "@/i18n";
import { FAST_TRANSITION } from "@/lib/motion";

type ToastVariant = "default" | "success" | "error";

interface ToastItem {
  id: number;
  title?: string;
  description?: string;
  variant: ToastVariant;
}

export interface ToastInput {
  title?: string;
  description?: string;
  variant?: ToastVariant;
}

const ToastContext = createContext<{ toast: (t: ToastInput) => void }>({
  toast: () => {},
});

/** Imperative entry point for non-React callers (Zustand actions). The
 *  provider wires it up while mounted; calls before that are dropped. */
let emitToast: (t: ToastInput) => void = () => {};

export function showToast(t: ToastInput) {
  emitToast(t);
}

export function useToast() {
  return useContext(ToastContext);
}

const variantStyles: Record<ToastVariant, { box: string; icon: ReactNode }> = {
  default: { box: "border-hairline bg-popover text-foreground", icon: null },
  success: {
    box: "border-hairline bg-popover text-foreground",
    icon: <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />,
  },
  error: {
    box: "border-destructive/40 bg-popover text-foreground",
    icon: <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />,
  },
};

/** Minimal toast provider — fixed stack top-right, auto-dismiss. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const toast = useCallback((t: ToastInput) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, variant: t.variant ?? "default", ...t }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((x) => x.id !== id));
    }, 4500);
  }, []);

  useEffect(() => {
    emitToast = toast;
    return () => {
      emitToast = () => {};
    };
  }, [toast]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed top-4 right-4 z-[100] flex w-80 flex-col gap-2">
        <AnimatePresence initial={false}>
          {toasts.map((item) => {
            const s = variantStyles[item.variant];
            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, y: -8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                transition={FAST_TRANSITION}
                className={`pointer-events-auto flex items-start gap-2 rounded-lg border p-3 text-sm shadow-lg ${s.box}`}
                role="status"
              >
                {s.icon}
                <div className="min-w-0 flex-1">
                  {item.title && (
                    <div className="font-medium">{item.title}</div>
                  )}
                  {item.description && (
                    <div className="text-muted-foreground mt-0.5 text-xs break-words">
                      {item.description}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  aria-label={t("common.close")}
                  className="text-muted-foreground hover:text-foreground rounded p-0.5 transition-colors"
                  onClick={() =>
                    setToasts((prev) => prev.filter((x) => x.id !== item.id))
                  }
                >
                  <X className="size-3.5" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
