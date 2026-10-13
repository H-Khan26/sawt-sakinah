import { Button, Tooltip, type TooltipSide } from "@/components/ui";
import { useTheme } from "@/theme/theme";
import { Moon, Sun } from "lucide-react";

/**
 * Button on the dome ground that flips between day and night. It stores an explicit theme, so
 * from "system" it switches to the opposite of the theme currently shown.
 */
export function ThemeSwitch({
  tooltipSide = "bottom",
  className,
}: {
  tooltipSide?: TooltipSide;
  className?: string;
}) {
  const { resolvedTheme, setTheme } = useTheme();
  const next = resolvedTheme === "day" ? "night" : "day";
  const label = next === "night" ? "Switch to night" : "Switch to day";

  return (
    <Tooltip content={label} side={tooltipSide}>
      <Button
        size="icon"
        variant="dome"
        onClick={() => setTheme(next)}
        aria-label={label}
        className={className}
      >
        {next === "night" ? (
          <Moon size={18} strokeWidth={1.6} />
        ) : (
          <Sun size={18} strokeWidth={1.6} />
        )}
      </Button>
    </Tooltip>
  );
}
