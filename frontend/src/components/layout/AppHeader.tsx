import { Button } from "@/components/ui";
import { useNavigate } from "react-router-dom";

/**
 * Slim top header: wordmark on the left, a "New" action on the right that returns to the
 * landing page to start a fresh project. "New" is non-destructive — any in-flight project
 * persists server-side — so it navigates without a confirm.
 */
export function AppHeader() {
  const navigate = useNavigate();
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-background px-4">
      <button
        type="button"
        onClick={() => navigate("/")}
        className="flex items-baseline gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus"
      >
        <span className="font-serif text-xl text-accent">Sawt Sakinah</span>
        <span className="font-arabic-display text-lg text-accent-secondary" lang="ar" dir="rtl">
          صوت سكينة
        </span>
      </button>
      <Button size="sm" variant="secondary" onClick={() => navigate("/")}>
        New
      </Button>
    </header>
  );
}
