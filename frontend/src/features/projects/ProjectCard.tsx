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
    // biome-ignore lint/a11y/useSemanticElements: card holds its own kebab button; nested buttons are invalid HTML, so the clickable card is a div with role="button".
    <div
      role="button"
      tabIndex={0}
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className="group relative flex min-h-44 cursor-pointer flex-col gap-3 rounded-[20px] border border-[rgba(224,224,224,0.96)] bg-[rgba(252,251,248,0.96)] p-5 text-left shadow-md transition-all duration-fast hover:-translate-y-0.5 hover:border-[rgba(69,3,119,0.24)] hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 flex-1 truncate font-serif text-lg text-text" title={project.name}>
          {project.name}
        </h3>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            aria-label="Project actions"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="-mr-1 -mt-1 rounded p-1 text-text-tertiary transition-colors duration-fast hover:bg-[rgba(69,3,119,0.06)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            <MoreVertical size={18} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 z-10 mt-1 w-40 overflow-hidden rounded border border-[rgba(224,224,224,0.96)] bg-[rgba(252,251,248,0.98)] py-1 shadow-lg backdrop-blur-[8px]"
            >
              <button
                type="button"
                role="menuitem"
                onClick={runItem(onRename)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text hover:bg-background-secondary"
              >
                <Pencil size={15} /> Rename
              </button>
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

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
        <span className="truncate">{formatSourceHost(project.source_url)}</span>
        <span className="text-text-tertiary">·</span>
        <span>{formatClock(project.duration_sec)}</span>
      </div>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-[rgba(224,224,224,0.9)] pt-3">
        <div className="flex items-center gap-2">
          <Badge variant={stage.variant}>{stage.label}</Badge>
          {project.export_count > 0 && (
            <span className={cn("text-xs text-text-tertiary")}>
              {project.export_count} export{project.export_count === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <span className="text-xs text-text-tertiary">{formatRelativeTime(project.updated_at)}</span>
      </div>
    </div>
  );
}
