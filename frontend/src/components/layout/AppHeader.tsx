import { Button } from "@/components/ui";
import { useNavigate } from "react-router-dom";
import wordmark from "@/assets/logo-wordmark-cream.png";

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
      <Button
        size="sm"
        variant="secondary"
        onClick={() => navigate("/")}
        className="absolute right-4"
      >
        New
      </Button>
    </header>
  );
}
