/**
 * Release notice under the header. The backend runs the daily release check and already
 * honours the "check for updates" and dismissed-version preferences, so this only renders
 * `update_available`. Links open in the system browser (the desktop window hands off
 * `target="_blank"` links). Dismissing stores the version so the banner stays hidden for it.
 */
import { useDismissUpdate, useUpdateStatus } from "@/api/hooks";
import { cn } from "@/lib/cn";
import { X } from "lucide-react";

export const RELEASES_URL = "https://github.com/H-Khan26/sawt-sakinah/releases";

/** The release link to show: the backend's URL when it is https, else the releases page. */
export function releaseUrl(url: string | null | undefined): string {
  return url?.startsWith("https://") ? url : RELEASES_URL;
}

const LINK_CLASS =
  "font-medium text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus rounded";

/** `className` adds to the strip's own classes (e.g. a full border where it stands alone). */
export function UpdateBanner({ className }: { className?: string }) {
  const { data } = useUpdateStatus();
  const dismiss = useDismissUpdate();
  const latest = data?.latest;
  if (!data?.update_available || !latest) return null;

  return (
    <aside
      aria-label="Update available"
      className={cn(
        "flex shrink-0 items-center justify-center gap-3 border-b border-border bg-background-secondary px-4 py-2 text-sm text-text",
        className,
      )}
    >
      <span>
        Version {latest} is available.{" "}
        <a href={releaseUrl(data.url)} target="_blank" rel="noreferrer" className={LINK_CLASS}>
          Get the update
        </a>
      </span>
      <button
        type="button"
        onClick={() => dismiss.mutate(latest)}
        aria-label={`Dismiss the notice for version ${latest}`}
        className="rounded p-1 text-text-tertiary hover:bg-background-tertiary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        <X size={16} />
      </button>
    </aside>
  );
}

/** "Check for updates" link for failures a newer release may fix (e.g. a site changed). */
export function CheckForUpdatesLink() {
  const { data } = useUpdateStatus();
  return (
    <a href={releaseUrl(data?.url)} target="_blank" rel="noreferrer" className={LINK_CLASS}>
      Check for updates
    </a>
  );
}

/** Whether a failure message asks the user to update the app. */
export function mentionsUpdate(message: string | null | undefined): boolean {
  return Boolean(message && /\bupdat/i.test(message));
}
