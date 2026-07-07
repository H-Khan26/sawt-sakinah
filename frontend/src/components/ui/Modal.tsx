import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name for the dialog (used when no visible title element applies). */
  ariaLabel?: string;
  className?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

/**
 * Low-level modal: portal + scrim + focus trap + Esc-to-close. Focuses the first
 * focusable element on open and restores focus to the previously-active element on
 * close. Tab/Shift+Tab cycle within the dialog.
 */
export function Modal({ open, onClose, children, ariaLabel, className }: ModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) {
        e.preventDefault();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    // Focus the first focusable node (or the dialog itself) once mounted.
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    (nodes && nodes.length > 0 ? nodes[0] : dialogRef.current)?.focus();
    return () => restoreRef.current?.focus?.();
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onKeyDown}
    >
      <dialog
        ref={dialogRef}
        open
        aria-modal="true"
        aria-label={ariaLabel}
        className={cn(
          "static m-0 max-h-[90vh] w-full max-w-lg overflow-auto rounded-card border border-border bg-background p-0 text-text shadow-xl focus:outline-none",
          className,
        )}
      >
        {children}
      </dialog>
    </div>,
    document.body,
  );
}

export interface SimpleModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Confirm action; when set, renders a primary button beside Cancel. */
  confirm?: {
    label: string;
    onClick: () => void;
    variant?: "primary" | "danger";
    loading?: boolean;
  };
  cancelLabel?: string;
}

/** Title + body + Cancel/Confirm footer over {@link Modal}. */
export function SimpleModal({
  open,
  onClose,
  title,
  children,
  confirm,
  cancelLabel = "Cancel",
}: SimpleModalProps) {
  return (
    <Modal open={open} onClose={onClose} ariaLabel={typeof title === "string" ? title : undefined}>
      <div className="border-b border-border px-5 py-3 font-serif text-lg">{title}</div>
      <div className="px-5 py-4 text-text-secondary">{children}</div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="secondary" onClick={onClose}>
          {cancelLabel}
        </Button>
        {confirm && (
          <Button
            variant={confirm.variant ?? "primary"}
            loading={confirm.loading}
            onClick={confirm.onClick}
          >
            {confirm.label}
          </Button>
        )}
      </div>
    </Modal>
  );
}
