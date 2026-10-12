import { cn } from "@/lib/cn";

/**
 * The cetvel double rule as a horizontal band: a 1.5 px and a 0.6 px gold line, 5 px apart.
 * The band between them takes `className`'s background (the deeper dome ground under a header).
 */
export function CetvelRule({ className }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "box-content h-[5px] shrink-0 border-b-[0.6px] border-t-[1.5px] border-gold",
        className,
      )}
    />
  );
}
