import wordmark from "@/assets/logo-wordmark-cream.png";
import { Button, Tooltip } from "@/components/ui";
import { Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";

/**
 * Top banner: the cream Sawt Sakinah wordmark centered on the deep-purple accent field,
 * with a "New" action pinned to the right that returns to the landing page to start a fresh
 * project. "New" is non-destructive — any in-flight project persists server-side — so it
 * navigates without a confirm. The centered wordmark is itself the "go home" affordance.
 */
export function AppHeader() {
  const navigate = useNavigate();
  return (
    <header className="relative flex h-20 shrink-0 items-center justify-center border-b border-accent-hover bg-accent px-4">
      <button
        type="button"
        onClick={() => navigate("/")}
        aria-label="Sawt Sakinah — start a new project"
        className="flex items-center rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-background"
      >
        <img
          src={wordmark}
          alt="صوت السكينة — Sawt Sakinah"
          className="h-14 w-auto select-none"
          draggable={false}
        />
      </button>
      <span className="absolute right-4">
        <Tooltip content="New project" side="bottom">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => navigate("/")}
            aria-label="Start a new project"
            className="w-8 px-0"
          >
            <Plus size={18} />
          </Button>
        </Tooltip>
      </span>
    </header>
  );
}
