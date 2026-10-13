import { useProjects } from "@/api/hooks";
import { Cartouche } from "@/components/ornament";
import { cn } from "@/lib/cn";
import { Check, ChevronDown, LayoutGrid, Pencil, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RenameDialog } from "./RenameDialog";

/**
 * The editor title and recording switcher in one: the recording name set in the {@link Cartouche}
 * is a button that opens a popover beneath it. The popover lists all recordings (navigate between
 * them), plus rows to start a new recording or return to the library; the current recording's
 * name heads it as the rename entry point. Unreadable recordings are listed but disabled, with
 * the reason as their tooltip.
 *
 * The root sizes to the title (360 px minimum, 60% of the title row at most) so the actions
 * that follow it sit beside the cartouche.
 */
export function ProjectSwitcher({
  projectId,
  currentName,
}: {
  projectId: string;
  currentName: string;
}) {
  const navigate = useNavigate();
  const { data: projects } = useProjects();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
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

  const go = (path: string) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <div className="relative flex min-w-0 max-w-[60%] shrink" ref={rootRef}>
      <Cartouche className="w-full !max-w-none">
        <h1 className="flex min-w-0 max-w-full justify-center">
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            title={currentName}
            onClick={() => setOpen((v) => !v)}
            className="flex min-w-0 max-w-full items-center gap-2 rounded px-1 font-display text-[26px] leading-tight focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[color:var(--cartouche-ink-2)]"
          >
            <span className="truncate">{currentName}</span>
            <ChevronDown
              size={18}
              aria-hidden="true"
              className={cn(
                "shrink-0 text-[color:var(--cartouche-ink-2)] transition-transform",
                open && "rotate-180",
              )}
            />
          </button>
        </h1>
      </Cartouche>

      {open && (
        <div
          role="menu"
          className="absolute left-1/2 top-full z-40 mt-2 w-72 -translate-x-1/2 overflow-hidden rounded-card border border-border bg-surface text-text shadow-xl"
        >
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
            <span
              className="min-w-0 flex-1 truncate font-serif text-sm text-text"
              title={currentName}
            >
              {currentName}
            </span>
            <button
              type="button"
              aria-label="Rename current recording"
              onClick={() => {
                setOpen(false);
                setRenaming(true);
              }}
              className="rounded p-1 text-text-tertiary hover:bg-background-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
            >
              <Pencil size={15} />
            </button>
          </div>

          <div className="max-h-64 overflow-auto py-1">
            {projects?.map((p) => {
              const active = p.id === projectId;
              const unreadable = Boolean(p.unreadable) && !active;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="menuitem"
                  disabled={unreadable}
                  title={unreadable ? (p.unreadable ?? undefined) : undefined}
                  onClick={() => (active ? setOpen(false) : go(`/p/${p.id}`))}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                    unreadable
                      ? "cursor-not-allowed text-text-tertiary"
                      : "hover:bg-background-secondary",
                    active ? "text-accent" : !unreadable && "text-text",
                  )}
                >
                  <Check
                    size={15}
                    className={cn("shrink-0", active ? "opacity-100" : "opacity-0")}
                  />
                  <span className="truncate">{p.name}</span>
                  {unreadable && <span className="ml-auto shrink-0 text-xs">Can't open</span>}
                </button>
              );
            })}
          </div>

          <div className="border-t border-border py-1">
            <button
              type="button"
              role="menuitem"
              onClick={() => go("/new")}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text hover:bg-background-secondary"
            >
              <Plus size={15} /> New recording
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => go("/")}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text hover:bg-background-secondary"
            >
              <LayoutGrid size={15} /> All recordings
            </button>
          </div>
        </div>
      )}

      {renaming && (
        <RenameDialog
          projectId={projectId}
          currentName={currentName}
          onClose={() => setRenaming(false)}
        />
      )}
    </div>
  );
}
