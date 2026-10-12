/**
 * Settings section for the opt-in yt-dlp self-update: the toggle, the yt-dlp in use (bundled
 * or updated), a version waiting for the next launch, and a "Check now" button that runs the
 * backend's `update_ytdlp` job and refreshes the status when it settles.
 */
import { queryKeys } from "@/api/endpoints";
import {
  useCheckYtdlp,
  useJob,
  usePatchPreferences,
  usePreferences,
  useYtdlpStatus,
} from "@/api/hooks";
import { Button } from "@/components/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

function checkMessage(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return null;
  if (result.status === "installed") {
    return `Downloaded yt-dlp ${String(result.latest)}. Restart the app to use it.`;
  }
  if (result.status === "up_to_date") return "The YouTube downloader is up to date.";
  return null;
}

export function YtdlpUpdateSection() {
  const queryClient = useQueryClient();
  const prefs = usePreferences();
  const patch = usePatchPreferences();
  const status = useYtdlpStatus();
  const check = useCheckYtdlp();
  const [jobId, setJobId] = useState<string>();
  const job = useJob(jobId);
  const state = job.data?.state;
  const enabled = prefs.data?.ytdlp_update ?? false;
  const running = check.isPending || state === "pending" || state === "running";

  useEffect(() => {
    if (state === "succeeded" || state === "failed") {
      queryClient.invalidateQueries({ queryKey: queryKeys.ytdlp });
    }
  }, [state, queryClient]);

  const info = status.data;
  const message =
    state === "succeeded"
      ? checkMessage(job.data?.result)
      : state === "failed"
        ? `The check failed: ${job.data?.error ?? "unknown error"}`
        : null;

  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-2 text-sm text-text-secondary">
        <input
          type="checkbox"
          className="accent-accent h-4 w-4 cursor-pointer"
          checked={enabled}
          disabled={!prefs.data}
          onChange={(e) =>
            patch.mutate(
              { ytdlp_update: e.target.checked },
              { onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.ytdlp }) },
            )
          }
        />
        Keep the YouTube downloader up to date
      </label>
      <p className="text-sm text-text-secondary">
        YouTube changes often break the downloader (yt-dlp) before a new app release is out. With
        this on, the app checks PyPI once a day and downloads the newest yt-dlp into its data
        folder, verified against the SHA-256 PyPI publishes. A new version is used from the next
        launch. Turn it off to go back to the copy that came with the app.
      </p>
      {info && (
        <p className="text-sm text-text-secondary">
          yt-dlp {info.version ?? "unknown"}{" "}
          {info.source === "updated" ? "(updated)" : "(came with the app)"}
          {info.pending_version && enabled && (
            <> · {info.pending_version} is downloaded and is used after a restart.</>
          )}
        </p>
      )}
      {info?.fallback && <p className="text-sm text-danger">{info.fallback}</p>}
      {enabled && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="secondary"
            loading={running}
            onClick={() => check.mutate(undefined, { onSuccess: (j) => setJobId(j.id) })}
          >
            Check now
          </Button>
          {message ? (
            <span className={state === "failed" ? "text-sm text-danger" : "text-sm"}>
              {message}
            </span>
          ) : (
            info?.error &&
            !running && (
              <span className="text-sm text-danger">The last check failed: {info.error}</span>
            )
          )}
        </div>
      )}
      {check.isError && (
        <p className="text-sm text-danger">Couldn't start the check: {check.error.message}</p>
      )}
    </div>
  );
}
