import { useProjects } from "@/api/hooks";
import { cn } from "@/lib/cn";
import { Check, ChevronDown, LayoutGrid, Pencil, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { RenameDialog } from "./RenameDialog";

/**
 * In-editor project switcher: a collapsed button showing the current project name, expanding
 * to a popover that lists all projects (navigate between them), plus rows to start a new
 * project or return to the library. The current project's name is also the rename entry
 * point. Reads the name from props (the header pulls it from the project cache). Unreadable
 * projects are listed but disabled, with the reason as their tooltip.
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
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex max-w-[16rem] items-center gap-1.5 rounded px-2.5 py-1.5 font-serif text-lg text-background hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background sm:max-w-xs"
      >
        <span className="truncate">{currentName}</span>
        <ChevronDown
          size={18}
          className={cn("shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-1/2 z-40 mt-2 w-72 -translate-x-1/2 overflow-hidden rounded-card border border-border bg-background text-text shadow-xl"
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
              aria-label="Rename current project"
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
              <Plus size={15} /> New project
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => go("/")}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text hover:bg-background-secondary"
            >
              <LayoutGrid size={15} /> All projects
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
