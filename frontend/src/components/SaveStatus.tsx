import { editSaveKey } from "@/api/endpoints";
import { WaveformLoader } from "@/components/ui";
import { useIsMutating, useMutationState, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check } from "lucide-react";
import { useEffect } from "react";

/**
 * Save-state indicator for the editor bar, drawn on the dome ground. The editor's EDL/marker edits PUT synchronously
 * per commit; this surfaces that autosave so the user knows closing is safe:
 *
 * - `Saving…` while any edit-save mutation is in flight,
 * - `Save failed — Retry` when the most recent edit-save ended in error (with a button that
 *   re-fires that exact mutation), auto-retry having already been exhausted,
 * - `All changes saved` otherwise (idle state is fully persisted server-side).
 *
 * It also guards `beforeunload` while a save is genuinely in flight — never when idle, so
 * normal closes stay seamless.
 */
export function SaveStatus({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const key = editSaveKey(projectId);
  const pending = useIsMutating({ mutationKey: key });

  // Reactive view of this project's edit-save mutations, oldest-first.
  const states = useMutationState({
    filters: { mutationKey: key },
    select: (m) => ({ status: m.state.status, submittedAt: m.state.submittedAt }),
  });

  const latest = states.reduce<(typeof states)[number] | null>(
    (acc, s) => (!acc || s.submittedAt > acc.submittedAt ? s : acc),
    null,
  );
  const failed = pending === 0 && latest?.status === "error";

  // Warn before unload only while a write is actually in flight.
  useEffect(() => {
    if (pending === 0) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [pending]);

  const retry = () => {
    const all = queryClient.getMutationCache().getAll();
    const errored = all.filter((m) => {
      const k = m.options.mutationKey;
      return (
        Array.isArray(k) && k[0] === "edit-save" && k[1] === projectId && m.state.status === "error"
      );
    });
    const last = errored.sort((a, b) => a.state.submittedAt - b.state.submittedAt).at(-1);
    if (last) last.execute(last.state.variables);
  };

  if (pending > 0) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-dome-on/80">
        <WaveformLoader size={12} bars={4} />
        Saving…
      </span>
    );
  }

  if (failed) {
    return (
      <span className="flex items-center gap-1.5 text-sm text-dome-on">
        <AlertTriangle size={14} />
        Save failed
        <button
          type="button"
          onClick={retry}
          className="ml-1 rounded underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-dome-on"
        >
          Retry
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5 text-sm text-dome-on/80">
      <Check size={14} />
      All changes saved
    </span>
  );
}
