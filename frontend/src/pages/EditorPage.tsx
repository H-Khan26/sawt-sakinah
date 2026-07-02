import { ApiError } from "@/api/client";
import { useCreateProject, useJob, useProject } from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { Alert, EmptyState, LoadingSpinner, WorkbenchPanel } from "@/components/ui";
import { CutPanel } from "@/features/cuts/CutPanel";
import { useCutSkip } from "@/features/cuts/useCutSkip";
import { useEditHotkeys } from "@/features/cuts/useEditHotkeys";
import { useEditRegions } from "@/features/cuts/useEditRegions";
import { ExportButton } from "@/features/export/ExportButton";
import { MarkerLayer } from "@/features/markers/MarkerLayer";
import { MarkersPanel } from "@/features/markers/MarkersPanel";
import { SilencePanel } from "@/features/silence/SilencePanel";
import { TransportBar } from "@/features/transport/TransportBar";
import { useTransportHotkeys } from "@/features/transport/useTransportHotkeys";
import { WaveformProvider } from "@/features/waveform/WaveformContext";
import { WaveformView } from "@/features/waveform/WaveformView";
import type { JobRecord, ProjectView } from "@/types/api";
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

  // --- ready -----------------------------------------------------------------
  return <EditorWorkspace project={project.data} />;
}

/**
 * The editor proper, mounted once the project is loaded. `WaveformProvider` owns the
 * wavesurfer instance and exposes it (via context) to the transport, the region layer
 * (silence + manual cuts + pending selection), and the marker layer, which slot in around
 * `WaveformView`.
 */
function EditorWorkspace({ project }: { project: ProjectView }) {
  return (
    <WaveformProvider projectId={project.id}>
      <EditorBody project={project} />
    </WaveformProvider>
  );
}

function EditorBody({ project }: { project: ProjectView }) {
  const ops = project.edl.operations;
  useTransportHotkeys();
  // Single owner of the Regions plugin; cut hotkeys; live playback-skip over cut spans.
  useEditRegions(project.silences, ops);
  useEditHotkeys(project.id, ops);
  useCutSkip(ops);
  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <WorkbenchPanel>
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <h1 className="font-serif text-2xl text-accent">{project.audio_source.title}</h1>
          <ExportButton project={project} />
        </div>
        <WaveformView overlay={<MarkerLayer markers={project.markers} />} />
        <TransportBar project={project} />
        <CutPanel project={project} />
        <SilencePanel project={project} />
        <MarkersPanel project={project} />
      </WorkbenchPanel>
    </div>
  );
}
