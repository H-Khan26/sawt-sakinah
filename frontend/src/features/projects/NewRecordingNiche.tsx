import { Niche } from "@/components/ornament";
import { cn } from "@/lib/cn";
import { Plus } from "lucide-react";
import { NICHE_FOOT, NICHE_META, NICHE_RULE, NICHE_TILE, NICHE_TITLE } from "./NicheCard";

/**
 * The arcade's closing niche: a faded empty mihrab with a + in the arch and "New recording" at
 * its foot, set like a `NicheCard` so it completes the row. Opens the New recording sheet.
 */
export function NewRecordingNiche({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        NICHE_TILE,
        "block w-full text-text-secondary transition duration-fast hover:-translate-y-0.5 hover:text-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-border-focus",
      )}
    >
      <Niche className="absolute inset-0 opacity-60 transition-opacity duration-fast group-hover:opacity-100 group-focus-visible:opacity-100" />
      <span className="absolute inset-0 flex items-center justify-center">
        <Plus aria-hidden="true" strokeWidth={1.5} className="size-[18cqw]" />
      </span>
      <span className={NICHE_FOOT}>
        <span aria-hidden="true" className={cn(NICHE_RULE, "bg-[var(--niche-inner)]")} />
        <span className={NICHE_TITLE}>New recording</span>
        <small className={cn(NICHE_META, "text-text-tertiary")}>Link or file</small>
      </span>
    </button>
  );
}
