import { cn } from "@/lib/cn";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import type { MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";

export interface ProjectMenuProps {
  /** Recording name, for the trigger's accessible name. */
  name: string;
  /** Offers only Delete (the recording's file can't be read). */
  unreadable?: boolean;
  onRename: () => void;
  onDelete: () => void;
  /** Where the menu opens relative to the trigger. */
  align?: "center" | "end";
  /** Positions the trigger's wrapper, which must be `relative` or `absolute` (the menu hangs from it). */
  className?: string;
}

/**
 * The ⋯ menu for one recording: Rename and Delete. The trigger shows while its `group` ancestor
 * is hovered or holds focus, and stays while the menu is open. Clicks and keys inside the menu do
 * not reach the row or card around it. Outside click or Esc closes the menu.
 */
export function ProjectMenu({
  name,
  unreadable = false,
  onRename,
  onDelete,
  align = "end",
  className,
}: ProjectMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: globalThis.MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const runItem = (fn: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    fn();
  };

  return (
    // The wrapper only stops clicks and keys from reaching the clickable row or card.
    <div
      ref={rootRef}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        // Stopped here, so the document listener never sees keys from inside the menu.
        e.stopPropagation();
        if (e.key === "Escape" && open) {
          setOpen(false);
          triggerRef.current?.focus();
        }
      }}
      className={cn(
        "transition-opacity duration-fast",
        open ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        className,
      )}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid h-7 w-7 place-items-center rounded-full border border-border bg-surface text-text-secondary shadow-sm transition-colors duration-fast hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(
            "absolute top-full z-20 mt-1 w-40 overflow-hidden rounded border border-border bg-surface py-1 text-left shadow-lg",
            align === "center" ? "left-1/2 -translate-x-1/2" : "right-0",
          )}
        >
          {!unreadable && (
            <button
              type="button"
              role="menuitem"
              onClick={runItem(onRename)}
              className="flex w-full items-center gap-2 px-3 py-2 font-sans text-sm text-text hover:bg-background-secondary focus-visible:bg-background-secondary focus-visible:outline-none"
            >
              <Pencil size={15} /> Rename
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={runItem(onDelete)}
            className="flex w-full items-center gap-2 px-3 py-2 font-sans text-sm text-danger hover:bg-background-secondary focus-visible:bg-background-secondary focus-visible:outline-none"
          >
            <Trash2 size={15} /> Delete
          </button>
        </div>
      )}
    </div>
  );
}
