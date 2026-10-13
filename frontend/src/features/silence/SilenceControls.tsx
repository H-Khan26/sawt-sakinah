/**
 * Silence detection: the detector mode, the mode's tuning sliders, and the detect action.
 * `useSilenceDetection` holds the state and runs the jobs; `SilenceControls` renders the
 * detector and slider fields, and the panel places the detect button beside its summary.
 *
 * Two modes, each mapping to a backend detector:
 * - Voice activity (`detector: "vad"`): Silero speech probabilities. "Speech threshold" is
 *   `speech_threshold` (0..1 probability cutoff; higher is stricter about what counts as speech,
 *   so more audio is treated as silence). The first run computes the speech map server-side;
 *   later runs reuse it (`has_speech_map`) and are cheap.
 * - Energy (`detector: "ffmpeg"`): the ffmpeg `silencedetect` level gate. "Silence threshold" is
 *   `threshold_db`.
 * "Minimum gap" is `min_silence_duration` in both modes. Only the fields relevant to the active
 * mode are sent; the backend fills its own defaults for the rest.
 *
 * Defaults mirror the backend config (threshold -40 dB, speech threshold 0.5, min gap 3.0 s).
 * Once an initial detection exists, changing a slider debounces (~400 ms) a re-detect; the job
 * poll invalidates the project so the new silences refetch and the regions re-reconcile.
 * Switching mode alone never auto-detects: it changes what the sliders mean, so the user confirms
 * with the button. The chosen mode is stored with the app preferences via `useViewPrefs`.
 *
 * The server may silently substitute the energy gate for a VAD request (no onnxruntime, no
 * working copy). The job still succeeds, so the substitution is surfaced from the job result
 * (`fallback`) as an inline warning rather than as a failure.
 */
import { useDetectSilence, useJob } from "@/api/hooks";
import { SegmentedControl, Slider } from "@/components/ui";
import { FieldLabel } from "@/features/editor/FieldLabel";
import { useViewPrefs } from "@/stores/viewPrefs";
import type { JobRecord, SilenceDetector, SilenceJobResult, SilenceParams } from "@/types/api";
import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD = { min: -60, max: -20, step: 1, default: -40 };
const SENSITIVITY = { min: 0.1, max: 0.9, step: 0.05, default: 0.5 };
const MIN_GAP = { min: 0.2, max: 10, step: 0.1, default: 3.0 };
const DEBOUNCE_MS = 400;

const MODES: { value: SilenceDetector; label: string }[] = [
  { value: "vad", label: "Voice activity" },
  { value: "ffmpeg", label: "Energy" },
];

interface SliderValues {
  threshold: number;
  sensitivity: number;
  minGap: number;
}

/** Request body for a mode: only the knobs that detector reads. */
function buildParams(mode: SilenceDetector, v: SliderValues): SilenceParams {
  return mode === "vad"
    ? { detector: "vad", speech_threshold: v.sensitivity, min_silence_duration: v.minGap }
    : { detector: "ffmpeg", threshold_db: v.threshold, min_silence_duration: v.minGap };
}

/**
 * Read a silence job's result. `JobRecord.result` is an untyped per-kind dict, so the fields
 * are checked at runtime instead of cast; anything malformed reads as "no result".
 */
function silenceResult(job: JobRecord | undefined): SilenceJobResult | undefined {
  const r = job?.result;
  if (!r || (r.detector !== "vad" && r.detector !== "ffmpeg")) return undefined;
  return {
    detector: r.detector,
    fallback: typeof r.fallback === "string" ? r.fallback : undefined,
    silences: typeof r.silences === "number" ? r.silences : 0,
  };
}

export interface SilenceDetection {
  mode: SilenceDetector;
  changeMode: (next: SilenceDetector) => void;
  threshold: number;
  setThreshold: (v: number) => void;
  sensitivity: number;
  setSensitivity: (v: number) => void;
  minGap: number;
  setMinGap: (v: number) => void;
  /** Run detection now with the current mode and values. */
  detectNow: () => void;
  /** A detection request or job is in flight. */
  detecting: boolean;
  /** The last detection job failed. */
  failed: boolean;
  /** The server used the energy gate in place of the requested VAD. */
  fellBack: boolean;
  /** The next VAD run computes this recording's speech map first. */
  showFirstRunHint: boolean;
}

export function useSilenceDetection({
  projectId,
  hasDetected,
  hasSpeechMap,
}: {
  projectId: string;
  hasDetected: boolean;
  /** Whether the backend already holds this recording's speech map (VAD re-detects are instant). */
  hasSpeechMap: boolean;
}): SilenceDetection {
  const mode = useViewPrefs((s) => s.silenceDetector);
  const setMode = useViewPrefs((s) => s.setSilenceDetector);
  const [threshold, setThreshold] = useState(THRESHOLD.default);
  const [sensitivity, setSensitivity] = useState(SENSITIVITY.default);
  const [minGap, setMinGap] = useState(MIN_GAP.default);
  const [jobId, setJobId] = useState<string | undefined>(undefined);

  const detect = useDetectSilence(projectId);
  const { mutate: detectSilence } = detect;
  const job = useJob(jobId, { invalidateProject: true });
  const detecting =
    detect.isPending || job.data?.state === "pending" || job.data?.state === "running";

  // `mutate` is referentially stable, so this only changes with `projectId`.
  const runDetect = useCallback(
    (params: SilenceParams) => {
      detectSilence(params, { onSuccess: (r) => setJobId(r.job_id) });
    },
    [detectSilence],
  );

  // Debounced auto re-detect keyed on slider values only: skipped before the first run and on
  // mode switches (mode is read through a ref so it is not a dependency). The effect compares
  // against the last values it saw rather than using a mount flag: React StrictMode runs
  // effects twice on mount in development, which would flip a mount flag and fire a detect on
  // every editor open, silently replacing the saved silences.
  const lastValues = useRef<SliderValues>({ threshold, sensitivity, minGap });
  const timer = useRef<number | null>(null);
  const hasDetectedRef = useRef(hasDetected);
  hasDetectedRef.current = hasDetected;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  useEffect(() => {
    const prev = lastValues.current;
    if (
      prev.threshold === threshold &&
      prev.sensitivity === sensitivity &&
      prev.minGap === minGap
    ) {
      return;
    }
    lastValues.current = { threshold, sensitivity, minGap };
    if (!hasDetectedRef.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => runDetect(buildParams(modeRef.current, { threshold, sensitivity, minGap })),
      DEBOUNCE_MS,
    );
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [runDetect, threshold, sensitivity, minGap]);

  // A mode click within the debounce window must not fire the pending re-detect: the timer
  // would read the new mode through `modeRef` and auto-run a detector the user never confirmed.
  const changeMode = (next: SilenceDetector) => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setMode(next);
  };

  const detectNow = () => runDetect(buildParams(mode, { threshold, sensitivity, minGap }));
  const fellBack = job.data?.state === "succeeded" && Boolean(silenceResult(job.data)?.fallback);
  // The fallback notice already tells the user the VAD is unavailable; promising a first-run
  // speech analysis alongside it would contradict that.
  const showFirstRunHint = mode === "vad" && !hasSpeechMap && !fellBack;

  return {
    mode,
    changeMode,
    threshold,
    setThreshold,
    sensitivity,
    setSensitivity,
    minGap,
    setMinGap,
    detectNow,
    detecting,
    failed: job.data?.state === "failed",
    fellBack,
    showFirstRunHint,
  };
}

/** The detector switch and the active mode's two sliders, laid out as one wrapping row. */
export function SilenceControls({ detection }: { detection: SilenceDetection }) {
  const d = detection;
  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
      <div className="flex flex-col gap-1.5">
        <FieldLabel>Detector</FieldLabel>
        <SegmentedControl
          label="Detector"
          options={MODES}
          value={d.mode}
          onChange={d.changeMode}
          disabled={d.detecting}
        />
      </div>
      {d.mode === "vad" ? (
        <Slider
          label="Speech threshold"
          min={SENSITIVITY.min}
          max={SENSITIVITY.max}
          step={SENSITIVITY.step}
          value={d.sensitivity}
          onChange={d.setSensitivity}
          format={(v) => v.toFixed(2)}
          disabled={d.detecting}
          className="min-w-[160px] flex-1 pb-1.5"
        />
      ) : (
        <Slider
          label="Silence threshold"
          min={THRESHOLD.min}
          max={THRESHOLD.max}
          step={THRESHOLD.step}
          value={d.threshold}
          onChange={d.setThreshold}
          format={(v) => `${v} dB`}
          disabled={d.detecting}
          className="min-w-[160px] flex-1 pb-1.5"
        />
      )}
      <Slider
        label="Minimum gap"
        min={MIN_GAP.min}
        max={MIN_GAP.max}
        step={MIN_GAP.step}
        value={d.minGap}
        onChange={d.setMinGap}
        format={(v) => `${v.toFixed(1)} s`}
        disabled={d.detecting}
        className="min-w-[160px] flex-1 pb-1.5"
      />
    </div>
  );
}
