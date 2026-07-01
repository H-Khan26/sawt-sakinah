import type { ReactNode } from "react";
import { AppHeader } from "./AppHeader";

/**
 * Minimal shell: a slim {@link AppHeader} over a full-bleed main region that fills the
 * remaining viewport height. No sidebar — this is a single-document tool.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col">
      <AppHeader />
      <main className="min-h-0 flex-1 overflow-auto">{children}</main>
    </div>
  );
}
