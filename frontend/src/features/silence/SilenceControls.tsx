/**
 * Silence-detection controls: threshold + minimum-gap sliders and a detect button.
 * Defaults mirror `CONFIG.silence` on the backend (threshold -40 dB, min gap 1.0 s). Once
 * an initial detection exists, changing a slider debounces (~400 ms) a re-detect; the job
 * poll invalidates the project so the new silences refetch and the regions re-reconcile.
 */
import { useDetectSilence, useJob } from "@/api/hooks";
import { Button, Slider } from "@/components/ui";
import { useCallback, useEffect, useRef, useState } from "react";

const THRESHOLD = { min: -60, max: -20, step: 1, default: -40 };
const MIN_GAP = { min: 0.2, max: 5, step: 0.1, default: 1.0 };
const DEBOUNCE_MS = 400;

export function SilenceControls({
  projectId,
  hasDetected,
}: {
  projectId: string;
  hasDetected: boolean;
}) {
  const [threshold, setThreshold] = useState(THRESHOLD.default);
  const [minGap, setMinGap] = useState(MIN_GAP.default);
  const [jobId, setJobId] = useState<string | undefined>(undefined);

  const detect = useDetectSilence(projectId);
  const { mutate: detectSilence } = detect;
  const job = useJob(jobId, { invalidateProject: true });
  const detecting =
    detect.isPending || job.data?.state === "pending" || job.data?.state === "running";

  // Stable across renders except when the params change; `mutate` is referentially stable.
  const runDetect = useCallback(() => {
    detectSilence(
      { threshold_db: threshold, min_silence_duration: minGap },
      { onSuccess: (r) => setJobId(r.job_id) },
    );
  }, [detectSilence, threshold, minGap]);

  // Debounced auto re-detect when params change — skipped on mount and before the first run.
  const mounted = useRef(false);
  const timer = useRef<number | null>(null);
  const hasDetectedRef = useRef(hasDetected);
  hasDetectedRef.current = hasDetected;
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!hasDetectedRef.current) return;
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(runDetect, DEBOUNCE_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [runDetect]);

  return (
    <div className="flex flex-col gap-4">
      <Slider
        label="Silence threshold"
        min={THRESHOLD.min}
        max={THRESHOLD.max}
        step={THRESHOLD.step}
        value={threshold}
        onChange={setThreshold}
        format={(v) => `${v} dB`}
        disabled={detecting}
      />
      <Slider
        label="Minimum gap"
        min={MIN_GAP.min}
        max={MIN_GAP.max}
        step={MIN_GAP.step}
        value={minGap}
        onChange={setMinGap}
        format={(v) => `${v.toFixed(1)} s`}
        disabled={detecting}
      />
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={runDetect} loading={detecting}>
          {hasDetected ? "Re-detect silence" : "Detect silence"}
        </Button>
        {job.data?.state === "failed" && (
          <span className="text-sm text-danger">Detection failed. Try again.</span>
        )}
      </div>
    </div>
  );
}
