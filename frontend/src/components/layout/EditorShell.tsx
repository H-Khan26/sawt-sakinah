import { useProject } from "@/api/hooks";
import { SaveStatus } from "@/components/SaveStatus";
import { CetvelRule } from "@/components/ornament/CetvelRule";
import { Logo } from "@/components/ornament/Logo";
import { ProjectSwitcher } from "@/features/projects/ProjectSwitcher";
import { SettingsButton } from "@/features/settings/SettingsButton";
import { ThemeSwitch } from "@/features/settings/ThemeSwitch";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

/**
 * Editor layout: a slim bar on the dome ground with the logo as the way home, the
 * {@link ProjectSwitcher} in the middle, and the save state, theme switch and settings on the
 * right. The main area scrolls under it.
 */
export function EditorShell({ projectId, children }: { projectId: string; children: ReactNode }) {
  const project = useProject(projectId);

  return (
    <div className="flex h-full flex-col">
      <header className="shrink-0 bg-dome">
        <div className="relative flex h-16 items-center justify-center px-4">
          <Link
            to="/"
            aria-label="Sawt Sakinah — all recordings"
            className="absolute left-4 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dome-on"
          >
            <Logo lockup="horizontal" tone="gold" className="h-11 w-auto" />
          </Link>
          {project.data && (
            <ProjectSwitcher projectId={projectId} currentName={project.data.name} />
          )}
          <div className="absolute right-4 flex items-center gap-2">
            <span className="mr-1 hidden sm:block">
              <SaveStatus projectId={projectId} />
            </span>
            <ThemeSwitch />
            <SettingsButton />
          </div>
        </div>
        <CetvelRule className="bg-dome-2" />
      </header>
      <UpdateBanner />
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
