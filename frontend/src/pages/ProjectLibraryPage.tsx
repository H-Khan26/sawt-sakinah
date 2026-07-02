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
 * The app's entry point: a grid of every project, most-recently-edited first (server-sorted).
 * Click a card to open the editor; the kebab menu renames or deletes. A prominent "New
 * project" tile leads to `/new`.
 */
export function ProjectLibraryPage() {
  const navigate = useNavigate();
  const { data: projects, isPending, isError, error } = useProjects();
  const [dialog, setDialog] = useState<Dialog>(null);
  const projectCount = projects?.length ?? 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <section className="rounded-[32px] border border-[rgba(224,224,224,0.92)] bg-[rgba(252,251,248,0.88)] p-6 shadow-xl backdrop-blur-[8px] sm:p-8">
        <div className="mb-8 flex flex-col gap-4 border-b border-[rgba(224,224,224,0.92)] pb-6 sm:flex-row sm:items-end sm:justify-between">
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
          {!isPending && !isError && (
            <div className="rounded-full border border-[rgba(69,3,119,0.12)] bg-[rgba(255,255,255,0.72)] px-4 py-2 text-sm text-text-secondary shadow-sm">
              {projectCount} project{projectCount === 1 ? "" : "s"}
            </div>
          )}
        </div>

        {isPending && (
          <div className="flex min-h-64 items-center justify-center rounded-[24px] border border-[rgba(224,224,224,0.92)] bg-[rgba(255,255,255,0.62)]">
            <WaveformLoader size={32} label="Loading projects" className="text-accent" />
          </div>
        )}

        {isError && (
          <Alert variant="error" title="Couldn't load your projects">
            {error.message}
          </Alert>
        )}

        {projects && projects.length === 0 && (
          <div className="rounded-[24px] border border-[rgba(224,224,224,0.92)] bg-[rgba(255,255,255,0.62)] p-4 sm:p-5">
            <EmptyState
              title="No projects yet"
              description="Start by pasting a YouTube link to a Quran recitation."
              action={{ label: "New project", onClick: () => navigate("/new") }}
            />
          </div>
        )}

        {projects && projects.length > 0 && (
          <div className="rounded-[24px] border border-[rgba(224,224,224,0.92)] bg-[rgba(255,255,255,0.56)] p-4 shadow-inner sm:p-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              <button
                type="button"
                onClick={() => navigate("/new")}
                className="group flex min-h-44 flex-col items-center justify-center gap-3 rounded-[20px] border border-dashed border-[rgba(69,3,119,0.28)] bg-[rgba(69,3,119,0.05)] px-6 text-text-secondary shadow-sm transition-all duration-fast hover:border-accent hover:bg-[rgba(69,3,119,0.09)] hover:text-accent hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
              >
                <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[rgba(255,255,255,0.85)] text-accent shadow-sm transition-transform duration-fast group-hover:scale-105">
                  <Plus size={28} />
                </span>
                <span className="font-serif text-2xl text-text">New project</span>
                <span className="max-w-52 text-center text-sm leading-6 text-text-secondary">
                  Paste a recitation link and start editing without leaving the library.
                </span>
              </button>

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
