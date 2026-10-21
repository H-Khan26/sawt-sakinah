import { ApiError } from "@/api/client";
import { useCreateProject, useJob, usePlatforms, useProject } from "@/api/hooks";
import { JobProgress } from "@/components/JobProgress";
import { SaveStatus } from "@/components/SaveStatus";
import { Alert, EmptyState, WaveformLoader, useToast } from "@/components/ui";
import { SeamLayer } from "@/features/cuts/SeamLayer";
import { useEditHotkeys } from "@/features/cuts/useEditHotkeys";
import { useEditRegions } from "@/features/cuts/useEditRegions";
import { LowerBand } from "@/features/editor/LowerBand";
import { RuledPage } from "@/features/editor/RuledPage";
import { ExportButton } from "@/features/export/ExportButton";
import { ImportErrorActions } from "@/features/projects/ImportErrorActions";
import { ProjectSwitcher } from "@/features/projects/ProjectSwitcher";
import { SurahBand, SurahOverviewTints, SurahTints } from "@/features/surahs/SurahBand";
import { useSurahHotkeys } from "@/features/surahs/useSurahView";
import { TransportBar } from "@/features/transport/TransportBar";
import { useTransportHotkeys } from "@/features/transport/useTransportHotkeys";
import { PlayheadDiamond } from "@/features/waveform/PlayheadDiamond";
import { WaveformProvider } from "@/features/waveform/WaveformContext";
import { WaveformOverview } from "@/features/waveform/WaveformOverview";
import { WaveformView } from "@/features/waveform/WaveformView";
import { useEditStore } from "@/stores/editStore";
import { useSurahStore } from "@/stores/surahStore";
import type { JobRecord, PlatformInfo, ProjectView } from "@/types/api";
import { useEffect } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";

/** Router state carried from the landing page (and across retries). */
export interface EditorLocationState {
  /** The extraction job to poll on entry. */
  jobId?: string;
  /** The originally-submitted URL, so a failed extraction can be retried. */
  url?: string;
}

/** The site an import failed on, for titles: its label (`null` when unknown) and item. */
interface FailedSite {
  label: string | null;
  item: string;
}

/** Friendly title per backend import failure (`error_type` = exception class name). */
const ERROR_TITLES: Record<string, (site: FailedSite) => string> = {
  InvalidInputError: () => "That link couldn't be used",
  UnsupportedPlatformError: () => "That site isn't supported",
  UnsupportedLinkError: () => "That link can't be imported",
  PlatformUnavailableError: ({ label }) => `${label ?? "This site"} imports aren't available`,
  PrivateVideoError: ({ item }) => `This ${item} is private`,
  AgeRestrictedError: ({ item }) => `This ${item} is age-restricted`,
  LoginRequiredError: ({ label }) => `${label ?? "The site"} wants you to sign in`,
  VideoUnavailableError: ({ item }) => `This ${item} isn't available`,
  LiveStreamError: () => "Live streams can't be imported",
  RegionLockedError: ({ item }) => `This ${item} is region-locked`,
  NoAudioStreamError: () => "There's no audio to import",
  DrmProtectedError: ({ item }) => `This ${item} is copy-protected`,
  FileTooLargeError: () => "That's too long or too large to import",
  UnsupportedMediaError: () => "That file can't be imported",
  RateLimitedError: ({ label }) => `${label ?? "The site"} is limiting requests`,
  NetworkError: ({ label }) => `Couldn't reach ${label ?? "the site"}`,
  ExtractorOutdatedError: () => "The downloader needs an update",
  YouTubeBotCheckError: () => "YouTube refused the download",
  CookiesError: () => "Couldn't read your sign-in cookies",
  JobCancelledError: () => "The import was stopped",
  ExtractionError: () => "The import failed",
};

function extractionErrorTitle(job: JobRecord | undefined, platform?: PlatformInfo): string {
  const title = ERROR_TITLES[job?.error_type ?? ""] ?? ERROR_TITLES.ExtractionError;
  return title({ label: platform?.label ?? null, item: platform?.item ?? "video" });
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
  const platforms = usePlatforms();
  const failedOn = platforms.data?.find((p) => p.id === job.data?.platform);

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
          title={extractionErrorTitle(job.data, failedOn)}
          action={{
            label: url ? "Try again" : "Back to start",
            onClick: onRetry,
            loading: retry.isPending,
          }}
        >
          {job.data?.error ?? "Something went wrong while extracting the audio."}
          <ImportErrorActions
            action={job.data?.error_action}
            message={job.data?.error}
            className="mt-3"
          />
          {retry.isError && (
            <>
              <p className="mt-2 text-danger">{retry.error.message}</p>
              <ImportErrorActions
                action={retry.error instanceof ApiError ? retry.error.action : null}
                message={retry.error.message}
                className="mt-3"
              />
            </>
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
        <WaveformLoader size={32} label="Loading recording" className="text-accent" />
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
 * layer (silence + cut ranges + pending selection), the surah band and tints and the seam layer,
 * which slot in around `WaveformView`.
 */
function EditorWorkspace({ project }: { project: ProjectView }) {
  return (
    <WaveformProvider project={project}>
      <EditorBody project={project} />
    </WaveformProvider>
  );
}

/**
 * A warning toast while a link import whose audio is silent is open (a reel whose music was
 * removed, say). The recording stays editable; the toast stays until dismissed or the editor
 * moves on.
 */
function useSilentNotice(project: ProjectView) {
  const { toast, dismiss } = useToast();
  const platforms = usePlatforms();
  const source = project.audio_source;
  const platform = platforms.data?.find((p) => p.id === source.source_kind);
  const message = platform
    ? `This ${platform.label} ${platform.item}'s audio is silent. Its sound may have been removed.`
    : "This recording's audio is silent. Its sound may have been removed.";
  // Waits for the site list, so the toast isn't swapped for a more specific one a moment later.
  const settled = !platforms.isPending;
  useEffect(() => {
    if (!source.is_silent || !settled) return;
    const id = toast(message, "warning", 0);
    return () => dismiss(id);
  }, [source.is_silent, settled, message, toast, dismiss]);
}

/**
 * The ruled page, top to bottom: the title cartouche with the save state and Export, the
 * overview, the waveform with the surah band in its margin, the transport, then the tools and the
 * Surahs column.
 * When the page is fixed to the window the last row takes the remaining height.
 */
function EditorBody({ project }: { project: ProjectView }) {
  const resetEdits = useEditStore((s) => s.reset);
  const resetSurahs = useSurahStore((s) => s.reset);
  // The selections and undo history belong to one project: reset them when it changes or the
  // editor closes. Refetches of the same project keep them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: project.id is the reset trigger
  useEffect(() => resetEdits, [project.id, resetEdits]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: project.id is the reset trigger
  useEffect(() => resetSurahs, [project.id, resetSurahs]);

  useSilentNotice(project);
  useTransportHotkeys();
  useSurahHotkeys(project);
  // Single owner of the Regions plugin; cut hotkeys. Live playback-skip over cut spans lives in
  // the waveform engine (it owns the playback element), so no hook is mounted here for it.
  useEditRegions(project);
  useEditHotkeys(project.id);
  return (
    <RuledPage className="grid grid-cols-[minmax(0,1fr)] content-start gap-y-4 px-8 pb-5 pt-6 group-[.is-fit]/page:grid-rows-[auto_auto_auto_auto_minmax(0,1fr)]">
      <div className="flex min-w-0 items-center justify-center gap-6">
        <ProjectSwitcher projectId={project.id} currentName={project.name} />
        <SaveStatus projectId={project.id} />
        <ExportButton project={project} />
      </div>
      <WaveformOverview overlay={<SurahOverviewTints project={project} />} />
      <WaveformView
        underlay={<SurahTints project={project} />}
        overlay={
          <>
            <SurahBand project={project} />
            <SeamLayer projectId={project.id} />
            <PlayheadDiamond />
          </>
        }
      />
      <TransportBar project={project} />
      <LowerBand project={project} />
    </RuledPage>
  );
}
