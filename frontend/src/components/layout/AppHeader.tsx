import { useProject } from "@/api/hooks";
import wordmark from "@/assets/logo-wordmark-cream.png";
import { SaveStatus } from "@/components/SaveStatus";
import { Button, Tooltip } from "@/components/ui";
import { ProjectSwitcher } from "@/features/projects/ProjectSwitcher";
import { SettingsButton } from "@/features/settings/SettingsButton";
import { Plus } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";

/** Match `/p/:projectId` and pull out the id, so the header can go context-aware without
 * being mounted inside the route (it lives in `AppShell`, above `Routes`). */
function editorProjectId(pathname: string): string | undefined {
  return pathname.match(/^\/p\/([^/]+)/)?.[1];
}

/**
 * Top banner on the deep-purple accent field. Context-aware:
 * - Library / new-project routes: centered wordmark (the "go home" affordance).
 * - Editor route: wordmark pinned left as home, a collapsible {@link ProjectSwitcher} in the
 *   middle, and a {@link SaveStatus} indicator on the right.
 * The settings gear and the "New" (+) action, which navigates to `/new`, are always present.
 */
export function AppHeader() {
  const navigate = useNavigate();
  const location = useLocation();
  const projectId = editorProjectId(location.pathname);
  const project = useProject(projectId);
  const isEditor = Boolean(projectId);

  const wordmarkButton = (className: string) => (
    <button
      type="button"
      onClick={() => navigate("/")}
      aria-label="Sawt Sakinah — all projects"
      className={`flex items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background ${className}`}
    >
      <img
        src={wordmark}
        alt="صوت السكينة — Sawt Sakinah"
        className="w-auto select-none"
        draggable={false}
      />
    </button>
  );

  return (
    <header className="relative flex h-20 shrink-0 items-center justify-center border-b border-accent-hover bg-accent px-4">
      {isEditor ? (
        <>
          <span className="absolute left-4">{wordmarkButton("[&_img]:h-10")}</span>
          {project.data && (
            <ProjectSwitcher projectId={projectId as string} currentName={project.data.name} />
          )}
          <span className="absolute right-4 flex items-center gap-3">
            <span className="hidden sm:block">
              <SaveStatus projectId={projectId as string} />
            </span>
            <SettingsButton />
            <Tooltip content="New project" side="bottom">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => navigate("/new")}
                aria-label="Start a new project"
                className="h-11 w-11 px-0"
              >
                <Plus size={24} />
              </Button>
            </Tooltip>
          </span>
        </>
      ) : (
        <>
          {wordmarkButton("[&_img]:h-14")}
          <span className="absolute right-4 flex items-center gap-3">
            <SettingsButton />
            <Tooltip content="New project" side="bottom">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => navigate("/new")}
                aria-label="Start a new project"
                className="h-11 w-11 px-0"
              >
                <Plus size={24} />
              </Button>
            </Tooltip>
          </span>
        </>
      )}
    </header>
  );
}
