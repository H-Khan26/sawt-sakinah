import { useProjects } from "@/api/hooks";
import { ArchToggleIcon, ListIcon, Niche } from "@/components/ornament";
import { Alert, Button, Input, SegmentedControl, WaveformLoader } from "@/components/ui";
import { DeleteDialog } from "@/features/projects/DeleteDialog";
import { FihristList } from "@/features/projects/FihristList";
import { ImportAnywhere } from "@/features/projects/ImportAnywhere";
import { NewRecordingSheet } from "@/features/projects/NewRecordingSheet";
import { NicheCard } from "@/features/projects/NicheCard";
import { RenameDialog } from "@/features/projects/RenameDialog";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { LibraryView, ProjectSummary } from "@/types/api";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

type Dialog = { kind: "rename" | "delete"; project: ProjectSummary } | null;

/** The search field joins the heading row from this many recordings on. */
const SEARCH_FROM = 12;

const VIEW_OPTIONS = [
  { value: "icons", label: <ArchToggleIcon />, ariaLabel: "Icon view" },
  { value: "list", label: <ListIcon />, ariaLabel: "List view" },
] as const satisfies readonly { value: LibraryView; label: JSX.Element; ariaLabel: string }[];

/**
 * The library, set on the qibla wall (the shell draws the wall's light and lattice): a
 * heading row (title and count, search from 12 recordings, view toggle, New recording) and the
 * recordings, most recently edited first (server-sorted), as an arcade of niches or a fihrist
 * list. Files dropped and YouTube links pasted anywhere on the page import straight away. With
 * `newSheet` (the `/new` route) the New recording sheet is open over it and closes to `/`.
 */
export function ProjectLibraryPage({ newSheet = false }: { newSheet?: boolean }) {
  const navigate = useNavigate();
  const { data: projects, isPending, isError, error } = useProjects();
  const libraryView = useViewPrefs((s) => s.libraryView);
  const setLibraryView = useViewPrefs((s) => s.setLibraryView);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [query, setQuery] = useState("");

  const all = projects ?? [];
  const searchable = all.length >= SEARCH_FROM;
  const needle = searchable ? query.trim().toLowerCase() : "";
  const shown = useMemo(
    () => (needle ? all.filter((p) => p.name.toLowerCase().includes(needle)) : all),
    [all, needle],
  );
  const numbers = useMemo(() => new Map(all.map((p, i) => [p.id, i + 1])), [all]);
  const currentId = all.find((p) => !p.unreadable)?.id;
  const hasRecordings = all.length > 0;

  const openNew = () => navigate("/new");
  const rename = (project: ProjectSummary) => setDialog({ kind: "rename", project });
  const remove = (project: ProjectSummary) => setDialog({ kind: "delete", project });

  return (
    <div className="relative">
      <div className="relative mx-auto w-full max-w-[1100px] px-6 pb-12 sm:px-10">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <h1 className="font-display text-[30px] leading-tight text-text">
            Your recordings
            {projects && (
              <span className="ml-2.5 align-middle font-sans text-[13px] tabular-nums text-text-tertiary">
                {all.length}
              </span>
            )}
          </h1>
          {hasRecordings && (
            <div className="flex flex-wrap items-center gap-2">
              {searchable && (
                <div className="w-56">
                  <Input
                    type="search"
                    aria-label="Search recordings"
                    placeholder="Search recordings"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="h-[34px] bg-surface text-sm [&::-webkit-search-cancel-button]:appearance-none"
                  />
                </div>
              )}
              <SegmentedControl
                label="Library view"
                options={VIEW_OPTIONS}
                value={libraryView}
                onChange={setLibraryView}
              />
              <Button size="sm" onClick={openNew} className="h-[34px]">
                <Plus size={16} />
                New recording
              </Button>
            </div>
          )}
        </div>

        {isPending && (
          <div className="flex min-h-64 items-center justify-center">
            <WaveformLoader size={32} label="Loading recordings" className="text-accent" />
          </div>
        )}

        {isError && (
          <Alert variant="error" title="Couldn't load your recordings">
            {error.message}
          </Alert>
        )}

        {projects && !hasRecordings && (
          <div className="flex flex-col items-center gap-5 pt-4">
            <div className="relative aspect-[3/4] w-[200px]">
              <Niche className="absolute inset-0" />
              <div className="absolute inset-x-[10%] bottom-[10%] flex flex-col items-center gap-2 text-center">
                <span aria-hidden="true" className="block h-px w-4 bg-[var(--niche-inner)]" />
                <p className="font-display text-lg leading-tight text-text">No recordings yet</p>
                <p className="font-sans text-xs text-text-tertiary">
                  Paste a YouTube link or drop a file anywhere
                </p>
              </div>
            </div>
            <Button onClick={openNew}>
              <Plus size={18} />
              New recording
            </Button>
          </div>
        )}

        {hasRecordings && shown.length === 0 && (
          <p className="py-10 text-center font-sans text-text-secondary">
            No recordings match “{query.trim()}”.
          </p>
        )}

        {shown.length > 0 &&
          (libraryView === "list" ? (
            <FihristList
              projects={shown}
              numberOf={(p) => numbers.get(p.id) ?? 0}
              currentId={currentId}
              onRename={rename}
              onDelete={remove}
            />
          ) : (
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(156px,1fr))] gap-x-4 gap-y-[22px]">
              {shown.map((project) => (
                <li key={project.id}>
                  <NicheCard
                    project={project}
                    current={project.id === currentId}
                    onRename={() => rename(project)}
                    onDelete={() => remove(project)}
                  />
                </li>
              ))}
            </ul>
          ))}
      </div>

      <ImportAnywhere paused={dialog !== null} />
      {newSheet && <NewRecordingSheet onClose={() => navigate("/")} />}

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
