import type { JobRecord } from "@/types/api";

/** Editor view states from docs/frontend/01-layout-and-pages.md. */
export type EditorViewState = "idle" | "extracting" | "analyzing" | "exporting" | "ready" | "error";

const SETTLED: ReadonlySet<string> = new Set(["succeeded", "failed"]);

/** True once a job has reached a terminal state (so polling can stop). */
export const isJobSettled = (job: JobRecord | undefined): boolean =>
  job !== undefined && SETTLED.has(job.state);

/**
 * Map the currently-tracked job onto an editor view state. `undefined` (no active job)
 * is `idle`; callers typically treat `idle` as `ready` once the project has loaded.
 */
export function jobToViewState(job: JobRecord | undefined): EditorViewState {
  if (!job) return "idle";
  if (job.state === "failed") return "error";
  if (job.state === "succeeded") return "ready";
  switch (job.kind) {
    case "extract":
      return "extracting";
    case "detect_silence":
    case "detect_surahs":
      return "analyzing";
    case "export":
      return "exporting";
    default:
      return "idle";
  }
}
