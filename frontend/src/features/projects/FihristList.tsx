import { CetvelFrame, RubElHizb } from "@/components/ornament";
import { cn } from "@/lib/cn";
import { formatLength, formatRelativeTime } from "@/lib/format";
import type { ProjectSummary } from "@/types/api";
import { useNavigate } from "react-router-dom";
import { ProjectMenu } from "./ProjectMenu";

/** Shared by the header and every row so the columns line up. */
const COLUMNS =
  "grid grid-cols-[2.5rem_minmax(0,1fr)_5.5rem_8rem_1.75rem] items-center gap-x-4 px-4";

export interface FihristListProps {
  /** The recordings to show, in order. */
  projects: readonly ProjectSummary[];
  /** The 1-based number of a recording in the whole library (stable while searching). */
  numberOf: (project: ProjectSummary) => number;
  /** The most recently edited recording, marked with a filled star and a tinted row. */
  currentId?: string;
  onRename: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
}

/**
 * The library's list view, set like a fihrist (a Mushaf's table of contents) on a ruled page:
 * each row is numbered with a Rub el Hizb star, and a dotted leader runs from the title to its
 * length, followed by when it was last edited. Rows open the editor; the ⋯ menu sits at the end.
 */
export function FihristList({
  projects,
  numberOf,
  currentId,
  onRename,
  onDelete,
}: FihristListProps) {
  return (
    <div className="bg-surface p-3 shadow-lg">
      <CetvelFrame innerClassName="px-2 py-4 sm:px-6 sm:py-6">
        <div
          aria-hidden="true"
          className={cn(
            COLUMNS,
            "border-b border-gold/60 pb-3 font-sans text-xs uppercase tracking-[0.16em] text-text-tertiary",
          )}
        >
          <span>No.</span>
          <span>Recording</span>
          <span className="text-right">Length</span>
          <span>Edited</span>
          <span />
        </div>
        <ol>
          {projects.map((project) => (
            <li key={project.id} className="border-b border-border last:border-b-0">
              <FihristRow
                project={project}
                number={numberOf(project)}
                current={project.id === currentId}
                onRename={() => onRename(project)}
                onDelete={() => onDelete(project)}
              />
            </li>
          ))}
        </ol>
      </CetvelFrame>
    </div>
  );
}

function FihristRow({
  project,
  number,
  current,
  onRename,
  onDelete,
}: {
  project: ProjectSummary;
  number: number;
  current: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  const navigate = useNavigate();
  const unreadable = project.unreadable;
  const open = () => navigate(`/p/${project.id}`);
  const length = formatLength(project.duration_sec);
  const edited = formatRelativeTime(project.updated_at);

  return (
    // The row holds the ⋯ button and nested buttons are invalid HTML, so the clickable row is a
    // div with role="button".
    <div
      role={unreadable ? undefined : "button"}
      tabIndex={unreadable ? undefined : 0}
      aria-label={unreadable ? undefined : `${number}. ${project.name}, ${length}, ${edited}`}
      onClick={unreadable ? undefined : open}
      onKeyDown={(e) => {
        if (unreadable || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        COLUMNS,
        "group py-3 transition-colors duration-fast",
        current && "bg-accent-soft",
        !unreadable &&
          "cursor-pointer hover:bg-accent-soft focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus",
      )}
    >
      <RubElHizb numeral={number} filled={current} size={30} />

      <div className="flex min-w-0 items-baseline">
        <span
          className={cn(
            "truncate font-display text-[22px] leading-tight",
            unreadable ? "text-text-tertiary" : "text-text",
          )}
          title={project.name}
        >
          {project.name}
        </span>
        <span
          aria-hidden="true"
          className="mx-3 min-w-8 flex-1 border-b border-dotted border-text-tertiary/70"
        />
      </div>

      {unreadable ? (
        <span
          className="col-span-2 truncate font-sans text-sm text-text-tertiary"
          title={unreadable}
        >
          {unreadable}
        </span>
      ) : (
        <>
          <span className="text-right font-sans text-[15px] tabular-nums text-text">{length}</span>
          <span className="font-sans text-sm text-text-secondary first-letter:uppercase">
            {edited}
          </span>
        </>
      )}

      <ProjectMenu
        name={project.name}
        unreadable={Boolean(unreadable)}
        onRename={onRename}
        onDelete={onDelete}
        className="relative"
      />
    </div>
  );
}
