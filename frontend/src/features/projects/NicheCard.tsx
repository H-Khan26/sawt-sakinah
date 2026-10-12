import { Niche } from "@/components/ornament";
import { cn } from "@/lib/cn";
import { formatLength, formatRelativeTime } from "@/lib/format";
import type { ProjectSummary } from "@/types/api";
import { useNavigate } from "react-router-dom";
import { ProjectMenu } from "./ProjectMenu";

export interface NicheCardProps {
  project: ProjectSummary;
  /** The most recently edited recording: accent niche with a gold waveform. */
  current?: boolean;
  onRename: () => void;
  onDelete: () => void;
}

/**
 * One recording in the library's arcade: a 3:4 mihrab niche with a decorative waveform seeded
 * from the id, and a short gold rule, the title (two lines reserved, set on the bottom one) and
 * `length · date` at its foot. Click, Enter or Space opens the editor; the ⋯ menu sits in the
 * arch's apex. An unreadable recording shows an empty niche with the reason, does not open, and
 * offers only Delete.
 */
export function NicheCard({ project, current = false, onRename, onDelete }: NicheCardProps) {
  const navigate = useNavigate();
  const unreadable = project.unreadable;
  const open = () => navigate(`/p/${project.id}`);
  const meta = `${formatLength(project.duration_sec)} · ${formatRelativeTime(project.updated_at)}`;

  return (
    // The card holds the ⋯ button and nested buttons are invalid HTML, so the clickable card is a
    // div with role="button".
    <div
      role={unreadable ? undefined : "button"}
      tabIndex={unreadable ? undefined : 0}
      aria-label={unreadable ? undefined : `${project.name}, ${meta}`}
      onClick={unreadable ? undefined : open}
      onKeyDown={(e) => {
        if (unreadable || e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      }}
      className={cn(
        "group relative aspect-[3/4] rounded-t-[50%] transition-transform duration-fast",
        current ? "text-[var(--niche-current-ink)]" : "text-text",
        !unreadable &&
          "cursor-pointer hover:-translate-y-0.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-focus",
      )}
    >
      <Niche
        current={current}
        seed={unreadable ? undefined : project.id}
        className="absolute inset-0"
      />

      <div className="absolute inset-x-[7%] bottom-[6%] flex flex-col items-center gap-[3px] text-center">
        <span
          aria-hidden="true"
          className={cn(
            "mb-[5px] block h-px w-4",
            current ? "bg-[var(--niche-current-line)]" : "bg-[var(--niche-inner)]",
          )}
        />
        <div className="flex min-h-[2.4em] w-full items-end justify-center font-display text-[15px] leading-[1.2]">
          <span className="line-clamp-2 break-words" title={project.name}>
            {project.name}
          </span>
        </div>
        {unreadable ? (
          <small
            className="line-clamp-2 font-sans text-[11px] text-text-tertiary"
            title={unreadable}
          >
            {unreadable}
          </small>
        ) : (
          <small
            className={cn(
              "font-sans text-[11px] tabular-nums",
              current ? "text-[var(--niche-current-ink-2)]" : "text-text-tertiary",
            )}
          >
            {meta}
          </small>
        )}
      </div>

      <ProjectMenu
        name={project.name}
        unreadable={Boolean(unreadable)}
        onRename={onRename}
        onDelete={onDelete}
        align="center"
        className="absolute left-1/2 top-[6%] -translate-x-1/2"
      />
    </div>
  );
}
