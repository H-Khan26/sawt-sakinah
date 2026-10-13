import { ApiError } from "@/api/client";
import { useCreateProject, useJob, useProject } from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { SaveStatus } from "@/components/SaveStatus";
import { Alert, EmptyState, WaveformLoader } from "@/components/ui";
import { CutPanel } from "@/features/cuts/CutPanel";
import { useEditHotkeys } from "@/features/cuts/useEditHotkeys";
import { useEditRegions } from "@/features/cuts/useEditRegions";
import { RuledPage } from "@/features/editor/RuledPage";
import { ExportButton } from "@/features/export/ExportButton";
import { MarkerLayer } from "@/features/markers/MarkerLayer";
import { MarkersPanel } from "@/features/markers/MarkersPanel";
import { ProjectSwitcher } from "@/features/projects/ProjectSwitcher";
import { OpenSettingsButton } from "@/features/settings/OpenSettingsButton";
import { SilencePanel } from "@/features/silence/SilencePanel";
import { TransportBar } from "@/features/transport/TransportBar";
import { useTransportHotkeys } from "@/features/transport/useTransportHotkeys";
import { CheckForUpdatesLink, mentionsUpdate } from "@/features/updates/UpdateBanner";
import { PlayheadDiamond } from "@/features/waveform/PlayheadDiamond";
import { WaveformProvider } from "@/features/waveform/WaveformContext";
import { WaveformOverview } from "@/features/waveform/WaveformOverview";
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
  YouTubeBotCheckError: "YouTube refused the download",
  CookiesError: "Couldn't read your YouTube cookies",
  JobCancelledError: "The import was stopped",
  ExtractionError: "Extraction failed",
};

/** Failures the YouTube cookies setting can fix; the alert offers a way to Settings. */
const SETTINGS_FIXABLE = new Set(["YouTubeBotCheckError", "CookiesError"]);

function extractionErrorTitle(job: JobRecord | undefined): string {
  const type = job?.error_type ?? "";
  return ERROR_TITLES[type] ?? "Extraction failed";
}

/**
 * Editor entry. Drives the pre-editor view state off the extraction job + project
 * presence; every state renders on the ruled page, the pre-ready ones centred on it.
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
      navigate("/new");
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
      <RuledPage centered>
        <Alert
          variant="error"
          className="w-full max-w-lg"
          title={extractionErrorTitle(job.data)}
          action={{
            label: url ? "Try again" : "Back to start",
            onClick: onRetry,
            loading: retry.isPending,
          }}
        >
          {job.data?.error ?? "Something went wrong while extracting the audio."}
          {mentionsUpdate(job.data?.error) && (
            <p className="mt-2">
              <CheckForUpdatesLink />
            </p>
          )}
          {SETTINGS_FIXABLE.has(job.data?.error_type ?? "") && (
            <div className="mt-3">
              <OpenSettingsButton />
            </div>
          )}
        </Alert>
      </RuledPage>
    );
  }

  // --- extracting ------------------------------------------------------------
  if (jobId && jobState !== "succeeded") {
    return (
      <RuledPage centered>
        <JobProgress job={job.data} title="Extracting audio…" />
      </RuledPage>
    );
  }

  // --- loading the project ---------------------------------------------------
  if (project.isLoading || project.isPending) {
    return (
      <RuledPage centered>
        <WaveformLoader size={32} label="Loading project" className="text-accent" />
      </RuledPage>
    );
  }

  // --- project fetch failed --------------------------------------------------
  if (project.isError) {
    if (!jobId && project.error instanceof ApiError && project.error.status === 404) {
      return (
        <RuledPage centered>
          <EmptyState
            title="Nothing here yet"
            description="This recording's extraction is still in progress, or the recording doesn't exist."
            action={{ label: "Back to library", onClick: () => navigate("/") }}
          />
        </RuledPage>
      );
    }
    return (
      <RuledPage centered>
        <Alert variant="error" title="Couldn't load the recording" className="w-full max-w-lg">
          {project.error.message}
        </Alert>
      </RuledPage>
    );
  }

  // --- ready -----------------------------------------------------------------
  return <EditorWorkspace project={project.data} />;
}

/**
 * The editor proper, mounted once the project is loaded. `WaveformProvider` owns the
 * wavesurfer instance and exposes it (via context) to the overview, the transport, the region
 * layer (silence + manual cuts + pending selection), and the marker layer, which slot in around
 * `WaveformView`.
 */
function EditorWorkspace({ project }: { project: ProjectView }) {
  return (
    <WaveformProvider project={project}>
      <EditorBody project={project} />
    </WaveformProvider>
  );
}

/**
 * The ruled page, top to bottom: the title cartouche with the save state and Export, the
 * overview, the waveform with its marginal notes, the transport, then the tools.
 */
function EditorBody({ project }: { project: ProjectView }) {
  const ops = project.edl.operations;
  useTransportHotkeys();
  // Single owner of the Regions plugin; cut hotkeys. Live playback-skip over cut spans lives in
  // the waveform engine (it owns the playback element), so no hook is mounted here for it.
  useEditRegions(project.silences, ops);
  useEditHotkeys(project.id, ops);
  return (
    <RuledPage className="grid grid-cols-[minmax(0,1fr)] content-start gap-y-4 px-8 pb-5 pt-6">
      <div className="flex min-w-0 items-center justify-center gap-6">
        <ProjectSwitcher projectId={project.id} currentName={project.name} />
        <SaveStatus projectId={project.id} />
        <ExportButton project={project} />
      </div>
      <WaveformOverview />
      <WaveformView
        overlay={
          <>
            <MarkerLayer markers={project.markers} structure={project.structure} />
            <PlayheadDiamond />
          </>
        }
      />
      <TransportBar project={project} />
      <CutPanel project={project} />
      <SilencePanel project={project} />
      <MarkersPanel project={project} />
    </RuledPage>
  );
}
