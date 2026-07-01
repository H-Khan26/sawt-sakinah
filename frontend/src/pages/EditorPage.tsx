import { ApiError } from "@/api/client";
import { useCreateProject, useJob, useProject } from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { Alert, EmptyState, LoadingSpinner } from "@/components/ui";
import type { JobRecord } from "@/types/api";
import { useLocation, useNavigate, useParams } from "react-router-dom";

/** Router state carried from the landing page (and across retries). */
export interface EditorLocationState {
  /** The extraction job to poll on entry. */
  jobId?: string;
  /** The originally-submitted URL, so a failed extraction can be retried. */
  url?: string;
}

/** Friendly title per backend extraction failure (`error_type` = exception class name). */
const ERROR_TITLES: Record<string, string> = {
  InvalidInputError: "That link couldn't be used",
  PrivateVideoError: "This video is private",
  AgeRestrictedError: "This video is age-restricted",
  VideoUnavailableError: "This video isn't available",
  LiveStreamError: "Live streams can't be processed",
  RegionLockedError: "This video is region-locked",
  ExtractionError: "Extraction failed",
};

function extractionErrorTitle(job: JobRecord | undefined): string {
  const type = job?.error_type ?? "";
  return ERROR_TITLES[type] ?? "Extraction failed";
}

/**
 * Editor entry. Drives the pre-editor view state off the extraction job + project
 * presence. The waveform and editing panels (Phases 4-6) replace the "ready" placeholder.
 *
 * - With a tracked `jobId` (arrived from the landing page): poll it, show progress, and
 *   only fetch the project once it has succeeded (GET /projects 404s until then).
 * - Without router state (refresh / deep link): fetch the project directly; a 404 means
 *   extraction is still running or the project doesn't exist -> empty state.
 */
export function EditorPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { jobId, url } = (location.state as EditorLocationState | null) ?? {};

  const job = useJob(jobId, { invalidateProject: true });
  const jobState = job.data?.state;

  // Only hit /projects once we know it exists: no tracked job (deep link) or job succeeded.
  const canFetchProject = !jobId || jobState === "succeeded";
  const project = useProject(canFetchProject ? projectId : undefined);

  const retry = useCreateProject();
  const onRetry = () => {
    if (!url) {
      navigate("/");
      return;
    }
    retry.mutate(
      { url },
      {
        onSuccess: ({ project_id, job_id }) => {
          const state: EditorLocationState = { jobId: job_id, url };
          navigate(`/p/${project_id}`, { replace: true, state });
        },
      },
    );
  };

  // --- extraction failed -----------------------------------------------------
  if (jobId && jobState === "failed") {
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 p-8">
        <Alert
          variant="error"
          title={extractionErrorTitle(job.data)}
          action={{
            label: url ? "Try again" : "Back to start",
            onClick: onRetry,
            loading: retry.isPending,
          }}
        >
          {job.data?.error ?? "Something went wrong while extracting the audio."}
        </Alert>
      </div>
    );
  }

  // --- extracting ------------------------------------------------------------
  if (jobId && jobState !== "succeeded") {
    return (
      <div className="flex min-h-full items-center justify-center p-8">
        <JobProgress job={job.data} title="Extracting audio…" />
      </div>
    );
  }

  // --- loading the project ---------------------------------------------------
  if (project.isLoading || project.isPending) {
    return (
      <div className="flex min-h-full items-center justify-center p-8">
        <LoadingSpinner size={28} label="Loading project" />
      </div>
    );
  }

  // --- project fetch failed --------------------------------------------------
  if (project.isError) {
    if (!jobId && project.error instanceof ApiError && project.error.status === 404) {
      return (
        <EmptyState
          title="Nothing here yet"
          description="This project's extraction is still in progress, or the project doesn't exist. Start again from a link."
          action={{ label: "Back to start", onClick: () => navigate("/") }}
        />
      );
    }
    return (
      <div className="mx-auto flex max-w-lg flex-col gap-4 p-8">
        <Alert variant="error" title="Couldn't load the project">
          {project.error.message}
        </Alert>
      </div>
    );
  }

  // --- ready (placeholder until Phase 4) -------------------------------------
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 p-8">
      <h1 className="font-serif text-2xl text-accent">{project.data.audio_source.title}</h1>
      <p className="text-text-tertiary">
        Waveform and editing panels load here (Phases 4-6). Project {projectId}.
      </p>
    </div>
  );
}
