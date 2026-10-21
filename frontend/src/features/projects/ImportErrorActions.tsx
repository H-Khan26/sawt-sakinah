import { OpenSettingsButton } from "@/features/settings/OpenSettingsButton";
import { CheckForUpdatesLink, mentionsUpdate } from "@/features/updates/UpdateBanner";
import { cn } from "@/lib/cn";
import type { ErrorAction } from "@/types/api";

/**
 * The ways out of a refused or failed import that its `error_action` offers: Settings at the
 * sign-in cookies or the downloader update, or the app's release page (also when the message
 * asks for an update). Trying again is up to the caller. Renders nothing when none applies.
 */
export function ImportErrorActions({
  action,
  message,
  className,
}: {
  action: ErrorAction | null | undefined;
  message: string | null | undefined;
  className?: string;
}) {
  const appUpdate = action === "update_app" || mentionsUpdate(message);
  if (action !== "cookies" && action !== "update_downloader" && !appUpdate) return null;
  return (
    <div className={cn("flex flex-wrap items-center gap-3", className)}>
      {action === "cookies" && (
        <OpenSettingsButton section="cookies">Sign-in cookies</OpenSettingsButton>
      )}
      {action === "update_downloader" && (
        <OpenSettingsButton section="downloader">Update the downloader</OpenSettingsButton>
      )}
      {appUpdate && <CheckForUpdatesLink />}
    </div>
  );
}
