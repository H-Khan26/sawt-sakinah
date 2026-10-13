import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

export type ToastVariant = "error" | "success" | "warning" | "info";

/** A button shown beside the message (e.g. Undo); clicking it runs `onClick` and dismisses. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastRecord {
  id: number;
  message: ReactNode;
  variant: ToastVariant;
  action?: ToastAction;
}

interface ToastApi {
  toast: (
    message: ReactNode,
    variant?: ToastVariant,
    durationMs?: number,
    action?: ToastAction,
  ) => number;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Access the toast API. Must be rendered inside a {@link ToastProvider}. */
export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
}

const VARIANT_ACCENT: Record<ToastVariant, string> = {
  error: "border-l-danger",
  success: "border-l-success",
  warning: "border-l-warning",
  info: "border-l-accent",
};

const DEFAULT_DURATION = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (
      message: ReactNode,
      variant: ToastVariant = "info",
      durationMs = DEFAULT_DURATION,
      action?: ToastAction,
    ) => {
      const id = nextId.current++;
      setToasts((prev) => [...prev, { id, message, variant, action }]);
      if (durationMs > 0) {
        window.setTimeout(() => dismiss(id), durationMs);
      }
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <output
            key={t.id}
            className={cn(
              "pointer-events-auto flex items-start gap-3 rounded border border-l-4 border-border bg-surface p-3 text-sm text-text shadow-lg",
              VARIANT_ACCENT[t.variant],
            )}
          >
            <div className="flex-1">{t.message}</div>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
                className="rounded font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              >
                {t.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => dismiss(t.id)}
              className="rounded text-text-tertiary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            >
              ×
            </button>
          </output>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
