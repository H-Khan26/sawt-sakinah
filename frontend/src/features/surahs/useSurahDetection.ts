/**
 * Surah matching for one project: runs `POST /detect/surahs` and follows the job to the phase the
 * Surahs column shows. Matching is always started by the user, never on its own.
 *
 * - `needs-model`: the Quran recognition model isn't on disk. The catalog says so; without it, a
 *   409 `ModelNotInstalledError` (or a job that lost the model) does, and refetches the catalog.
 * - `idle`: nothing found yet, and nothing running.
 * - `finding`: the request or job is under way, until the project shows this run's result.
 * - `failed`: the request or job failed for another reason; `error` says why.
 * - `done`: the project holds a surah map (which may have no passages).
 *
 * The job id is kept per project in `surahStore`, so the progress survives leaving the recording
 * and coming back. A run that succeeds turns the Surah view on, so the result shows at once.
 * Running again reuses the saved transcript, so only the matching repeats.
 */
import { queryKeys } from "@/api/endpoints";
import { useDetectSurahs, useJob, useModels } from "@/api/hooks";
import { MODEL_NOT_INSTALLED, isModelNotInstalled } from "@/features/models/useModelDownload";
import { useSurahStore } from "@/stores/surahStore";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { JobRecord, ProjectView, SpeechModel } from "@/types/api";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

export type SurahPhase = "loading" | "needs-model" | "idle" | "finding" | "failed" | "done";

export interface SurahDetection {
  phase: SurahPhase;
  /** The Quran recognition model's catalog entry, once the catalog has loaded. */
  model: SpeechModel | undefined;
  /** Start matching. */
  run: () => void;
  /** The job being followed, for its progress. */
  job: JobRecord | undefined;
  /** Why the last run failed, while `phase` is `failed`. */
  error: string | null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A matching job's progress as a fraction (while transcribing) and a line of text. */
export function surahJobProgress(
  job: JobRecord | undefined,
  formatTime: (seconds: number) => string,
): { fraction: number | null; text: string } {
  const progress = job?.progress ?? {};
  const done = num(progress.done_sec);
  const total = num(progress.total_sec);
  if (progress.stage === "transcribing" && done !== null && total !== null && total > 0) {
    return {
      fraction: Math.min(1, done / total),
      text: `Transcribing · ${formatTime(done)} of ${formatTime(total)}. Then a few seconds of matching.`,
    };
  }
  if (progress.stage === "matching" || job?.state === "succeeded") {
    return { fraction: 1, text: "Matching…" };
  }
  return { fraction: null, text: "Getting ready…" };
}

export function useSurahDetection(project: ProjectView): SurahDetection {
  const projectId = project.id;
  const queryClient = useQueryClient();
  const models = useModels();
  // The catalog holds the one Quran recognition model.
  const model = models.data?.[0];
  const [serverMissingModel, setServerMissingModel] = useState(false);

  const detect = useDetectSurahs(projectId);
  const jobId = useSurahStore((s) => s.jobs[projectId]);
  const setJob = useSurahStore((s) => s.setJob);
  const job = useJob(jobId, { invalidateProject: true });
  const state = job.data?.state;
  const jobMissingModel = state === "failed" && job.data?.error_type === MODEL_NOT_INSTALLED;

  // A job that lost its model mid-flight means the cached catalog is stale.
  useEffect(() => {
    if (jobMissingModel) queryClient.invalidateQueries({ queryKey: queryKeys.models });
  }, [jobMissingModel, queryClient]);

  // The first time this run's success is seen, turn the Surah view on.
  const announced = useRef<string | null>(null);
  useEffect(() => {
    if (state !== "succeeded" || !jobId || announced.current === jobId) return;
    announced.current = jobId;
    const prefs = useViewPrefs.getState();
    if (!prefs.surahView) prefs.setSurahView(true);
  }, [state, jobId]);

  const needsModel = model ? !model.installed : serverMissingModel || jobMissingModel;

  const run = () => {
    detect.mutate(
      { reuse_transcript: true },
      {
        onSuccess: (r) => {
          setServerMissingModel(false);
          setJob(projectId, r.job_id);
        },
        onError: (err) => {
          if (!isModelNotInstalled(err)) return;
          setServerMissingModel(true);
          queryClient.invalidateQueries({ queryKey: queryKeys.models });
        },
      },
    );
  };

  // A succeeded job counts as finding until the refetched project carries its result.
  const matchedAt = project.surahs ? Date.parse(project.surahs.matched_at) : null;
  const awaitingResult =
    state === "succeeded" &&
    job.data !== undefined &&
    (matchedAt === null || matchedAt < Date.parse(job.data.created_at));
  const finding = detect.isPending || state === "pending" || state === "running" || awaitingResult;

  const jobError = state === "failed" && !jobMissingModel ? (job.data?.error ?? null) : null;
  const requestError =
    detect.isError && !isModelNotInstalled(detect.error) ? detect.error.message : null;
  const error = finding ? null : (requestError ?? jobError);

  let phase: SurahPhase;
  if (finding) phase = "finding";
  else if (error) phase = "failed";
  else if (needsModel && !project.surahs) phase = "needs-model";
  else if (project.surahs) phase = "done";
  else if (models.isPending) phase = "loading";
  else phase = "idle";

  return { phase, model, run, job: job.data, error };
}
