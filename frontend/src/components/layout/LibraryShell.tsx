import { CetvelRule } from "@/components/ornament/CetvelRule";
import { LatinName, Logo } from "@/components/ornament/Logo";
import { SettingsButton } from "@/features/settings/SettingsButton";
import { ThemeSwitch } from "@/features/settings/ThemeSwitch";
import { UpdateBanner } from "@/features/updates/UpdateBanner";
import type { ReactNode } from "react";

/**
 * Library and new-recording layout: a header on the dome ground holding only the centred logo
 * and its Latin caption, closed by the cetvel rule, with the theme switch and settings in the
 * top-right corner. The {@link UpdateBanner} sits under it and the main area scrolls.
 */
export function LibraryShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <header className="relative shrink-0 bg-dome">
        <div className="flex h-[136px] flex-col items-center justify-center gap-2.5 px-4">
          <Logo lockup="horizontal" tone="gold" className="h-[60px] w-auto" />
          <LatinName className="text-[13px] text-dome-on" />
        </div>
        <div className="absolute right-3 top-3 flex items-center gap-2">
          <ThemeSwitch />
          <SettingsButton />
        </div>
        <CetvelRule className="bg-dome-2" />
      </header>
      <UpdateBanner />
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
