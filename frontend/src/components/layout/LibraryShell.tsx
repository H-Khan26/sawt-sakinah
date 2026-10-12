import { Sanctuary } from "@/features/landing/Sanctuary";
import { SettingsButton } from "@/features/settings/SettingsButton";
import { ThemeSwitch } from "@/features/settings/ThemeSwitch";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import type { ReactNode } from "react";

/**
 * Library and new-recording layout: the {@link Sanctuary}. On a cold launch it opens under the
 * dome and descends into the library; otherwise it opens descended, with a header on the dome
 * ground holding only the logo, the lamp ring as its lower edge, and the theme switch and settings
 * in the corner. The {@link UpdateBanner} heads the wall, above the page.
 */
export function LibraryShell({ children }: { children: ReactNode }) {
  return (
    <Sanctuary
      corner={
        <>
          <ThemeSwitch />
          <SettingsButton />
        </>
      }
    >
      <div className="relative mx-auto w-full max-w-[1100px] px-6 sm:px-10">
        <UpdateBanner className="mb-6 rounded border" />
      </div>
      <main className="relative">{children}</main>
    </Sanctuary>
  );
}
