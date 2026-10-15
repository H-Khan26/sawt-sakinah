import { useSaveState } from "@/api/hooks";
import { WaveformLoader } from "@/components/ui";
import { AlertTriangle, Check } from "lucide-react";
import { useEffect } from "react";

/**
 * Save-state indicator beside the editor title. The editor's EDL edits are saved in the
 * background per commit; this surfaces that autosave (`useSaveState`) so the user knows closing
 * is safe:
 *
 * - `Saving…` while an EDL save is queued or in flight,
 * - `Save failed — Retry` while an EDL edit is unsaved, auto-retry having already been
 *   exhausted. Retry re-sends the latest local EDL. An unsaved EDL edit shows here for as long as
 *   it stays unsaved, whatever was saved after it,
 * - `Saved` otherwise (every edit is stored server-side).
 *
 * It also guards `beforeunload` while anything is saving or unsaved — never when everything is
 * saved, so normal closes stay seamless.
 */
export function SaveStatus({ projectId }: { projectId: string }) {
  const { state, retry } = useSaveState(projectId);

  useEffect(() => {
    if (state === "saved") return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state]);

  if (state === "saving") {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-sm text-text-secondary">
        <WaveformLoader size={12} bars={4} />
        Saving…
      </span>
    );
  }

  if (state === "failed") {
    return (
      <span className="flex items-center gap-1.5 whitespace-nowrap text-sm text-danger">
        <AlertTriangle size={14} />
        Save failed
        <button
          type="button"
          onClick={retry}
          className="ml-1 rounded underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
        >
          Retry
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap text-sm text-text-secondary">
      <Check size={14} />
      Saved
    </span>
  );
}
