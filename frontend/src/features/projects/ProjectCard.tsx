import { Badge } from "@/components/ui";
import type { BadgeVariant } from "@/components/ui";
import { cn } from "@/lib/cn";
import { formatRelativeTime, formatSourceHost } from "@/lib/format";
import { formatClock } from "@/lib/time";
import type { ProjectStatus, ProjectSummary } from "@/types/api";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

/** The furthest-along stage as a single badge; edited > analyzed > extracted. */
function stageBadge(status: ProjectStatus): { label: string; variant: BadgeVariant } {
  if (status.edited) return { label: "Edited", variant: "accent" };
  if (status.analyzed) return { label: "Analyzed", variant: "accent-secondary" };
  if (status.extracted) return { label: "Extracted", variant: "info" };
  return { label: "Processing", variant: "neutral" };
}

/**
 * One library row. Click (or Enter/Space) opens the editor; the kebab menu renames or deletes.
 * An unreadable project (its file is too new or damaged) shows the reason instead of the
 * source line, does not open, and offers only Delete.
 */
export function ProjectCard({
  project,
  onRename,
  onDelete,
}: {
  project: ProjectSummary;
  onRename: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const stage = stageBadge(project.status);
  const unreadable = project.unreadable;

  // Close the kebab menu on outside click / Esc.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const open = () => navigate(`/p/${project.id}`);

  const runItem = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuOpen(false);
    fn();
  };

  return (
    // The card holds its own kebab button and nested buttons are invalid HTML, so the clickable
    // card is a div with role="button".
    <div
      role={unreadable ? undefined : "button"}
      tabIndex={unreadable ? undefined : 0}
      onClick={unreadable ? undefined : open}
      onKeyDown={(e) => {
        if (!unreadable && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        "group relative flex flex-col gap-4 rounded-[20px] border border-[rgba(224,224,224,0.96)] bg-[rgba(252,251,248,0.96)] p-5 text-left shadow-sm transition-all duration-fast sm:flex-row sm:items-start sm:justify-between sm:gap-6",
        !unreadable &&
          "cursor-pointer hover:border-[rgba(69,3,119,0.24)] hover:bg-[rgba(255,255,255,0.98)] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3 sm:gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium uppercase tracking-[0.24em] text-text-tertiary">
              Project
            </p>
            <h3
              className="mt-1 min-w-0 truncate font-serif text-xl text-text sm:text-[1.7rem]"
              title={project.name}
            >
              {project.name}
            </h3>
          </div>
        </div>

        {unreadable ? (
          <p className="mt-4 text-sm text-text-secondary">{unreadable}</p>
        ) : (
          <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
            <span className="truncate">
              {project.source_kind === "upload"
                ? "Uploaded file"
                : formatSourceHost(project.source_url ?? "")}
            </span>
            <span className="text-text-tertiary">·</span>
            <span>{formatClock(project.duration_sec)}</span>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-2">
          {unreadable ? (
            <Badge variant="danger">Can't open</Badge>
          ) : (
            <Badge variant={stage.variant}>{stage.label}</Badge>
          )}
          {project.export_count > 0 && (
            <span className="rounded-full bg-[rgba(69,3,119,0.06)] px-3 py-1 text-xs text-text-secondary">
              {project.export_count} export{project.export_count === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-4 border-t border-[rgba(224,224,224,0.9)] pt-4 sm:min-w-52 sm:flex-col sm:items-end sm:justify-between sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
        <div className="text-xs uppercase tracking-[0.18em] text-text-tertiary sm:text-right">
          Updated
          <div className="mt-1 text-sm normal-case tracking-normal text-text-secondary">
            {formatRelativeTime(project.updated_at)}
          </div>
        </div>
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            aria-label="Project actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="rounded p-1 text-text-tertiary transition-colors duration-fast hover:bg-[rgba(69,3,119,0.06)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded border border-[rgba(224,224,224,0.96)] bg-[rgba(252,251,248,0.98)] py-1 shadow-lg backdrop-blur-[8px]"
            >
              {!unreadable && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={runItem(onRename)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text hover:bg-background-secondary"
                >
                  <Pencil size={15} /> Rename
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={runItem(onDelete)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-danger hover:bg-background-secondary"
              >
                <Trash2 size={15} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
