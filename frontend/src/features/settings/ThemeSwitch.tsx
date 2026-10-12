import { Button, Tooltip } from "@/components/ui";
import { useTheme } from "@/theme/theme";
import { Moon, Sun } from "lucide-react";

/**
 * Header button that flips between day and night. It stores an explicit theme, so from
 * "system" it switches to the opposite of the theme currently shown.
 */
export function ThemeSwitch() {
  const { resolvedTheme, setTheme } = useTheme();
  const next = resolvedTheme === "day" ? "night" : "day";
  const label = next === "night" ? "Switch to night" : "Switch to day";

  return (
    <Tooltip content={label} side="bottom">
      <Button
        size="sm"
        variant="dome"
        onClick={() => setTheme(next)}
        aria-label={label}
        className="h-[34px] w-[34px] px-0"
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
