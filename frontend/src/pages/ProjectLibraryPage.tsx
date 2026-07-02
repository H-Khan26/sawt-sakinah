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

  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <div className="mb-6 flex items-center justify-between gap-4">
        <h1 className="font-serif text-2xl text-text">Your projects</h1>
      </div>

      {isPending && (
        <div className="flex min-h-64 items-center justify-center">
          <WaveformLoader size={32} label="Loading projects" className="text-accent" />
        </div>
      )}

      {isError && (
        <Alert variant="error" title="Couldn't load your projects">
          {error.message}
        </Alert>
      )}

      {projects && projects.length === 0 && (
        <EmptyState
          title="No projects yet"
          description="Start by pasting a YouTube link to a Quran recitation."
          action={{ label: "New project", onClick: () => navigate("/new") }}
        />
      )}

      {projects && projects.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <button
            type="button"
            onClick={() => navigate("/new")}
            className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-card border-2 border-dashed border-border bg-transparent text-text-secondary transition-colors duration-fast hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
          >
            <Plus size={28} />
            <span className="font-medium">New project</span>
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
      )}

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
