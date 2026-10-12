import { useProjects } from "@/api/hooks";
import { Alert, EmptyState, WaveformLoader } from "@/components/ui";
import { DeleteDialog } from "@/features/projects/DeleteDialog";
import { ProjectCard } from "@/features/projects/ProjectCard";
import { RenameDialog } from "@/features/projects/RenameDialog";
import type { ProjectSummary } from "@/types/api";
import { Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

type Dialog = { kind: "rename" | "delete"; project: ProjectSummary } | null;

/**
 * The app's entry point: a continuous library of every project, most-recently-edited first
 * (server-sorted). Click a row to open the editor; the kebab menu renames or deletes. The
 * primary "New project" action lives in the library header.
 */
export function ProjectLibraryPage() {
  const navigate = useNavigate();
  const { data: projects, isPending, isError, error } = useProjects();
  const [dialog, setDialog] = useState<Dialog>(null);
  const projectCount = projects?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-[32px] border border-border bg-surface p-6 shadow-xl sm:p-8">
        <div className="mb-8 flex flex-col gap-4 border-b border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.28em] text-text-tertiary">
              Project library
            </p>
            <h1 className="mt-2 font-serif text-3xl text-text sm:text-4xl">Your projects</h1>
            <p className="mt-2 max-w-2xl text-sm text-text-secondary sm:text-base">
              Continue recent work or start a new cleanup session from a calmer, more focused
              workspace.
            </p>
          </div>
          <div className="flex flex-col items-start gap-3 sm:items-end">
            {!isPending && !isError && (
              <div className="rounded-full border border-border bg-background px-4 py-2 text-sm text-text-secondary shadow-sm">
                {projectCount} project{projectCount === 1 ? "" : "s"}
              </div>
            )}
            <button
              type="button"
              onClick={() => navigate("/new")}
              className="inline-flex items-center gap-2 rounded-full bg-accent px-5 py-3 text-sm font-medium text-accent-on shadow-md transition-all duration-fast hover:bg-accent-hover hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus focus-visible:ring-offset-2"
            >
              <Plus size={18} />
              New project
            </button>
          </div>
        </div>

        {isPending && (
          <div className="flex min-h-64 items-center justify-center rounded-[24px] border border-border bg-background-secondary">
            <WaveformLoader size={32} label="Loading projects" className="text-accent" />
          </div>
        )}

        {isError && (
          <Alert variant="error" title="Couldn't load your projects">
            {error.message}
          </Alert>
        )}

        {projects && projects.length === 0 && (
          <div className="rounded-[24px] border border-border bg-background-secondary p-4 sm:p-5">
            <EmptyState
              title="No projects yet"
              description="Start by pasting a YouTube link to a Quran recitation."
              action={{ label: "New project", onClick: () => navigate("/new") }}
            />
          </div>
        )}

        {projects && projects.length > 0 && (
          <div className="rounded-[24px] border border-border bg-background-secondary p-3 shadow-inner sm:p-4">
            <div className="mb-4 flex items-center justify-between gap-3 px-2 pt-1">
              <div>
                <h2 className="font-serif text-xl text-text">Recent projects</h2>
                <p className="text-sm text-text-secondary">
                  Most recently edited first, with status and export details inline.
                </p>
              </div>
            </div>
            <div className="flex flex-col gap-3">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  onRename={() => setDialog({ kind: "rename", project })}
                  onDelete={() => setDialog({ kind: "delete", project })}
                />
              ))}
            </div>
          </div>
        )}
      </section>

      {dialog?.kind === "rename" && (
        <RenameDialog
          projectId={dialog.project.id}
          currentName={dialog.project.name}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog
          projectId={dialog.project.id}
          name={dialog.project.name}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}
