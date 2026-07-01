import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { Button } from "./Button";

export interface EmptyStateProps {
  /** Optional icon/illustration node rendered above the title. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  className?: string;
}

export function EmptyState({ icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn("flex flex-col items-center justify-center gap-3 py-12 text-center", className)}
    >
      {icon && <div className="text-text-tertiary">{icon}</div>}
      <h2 className="font-serif text-xl text-text">{title}</h2>
      {description && <p className="max-w-md text-text-secondary">{description}</p>}
      {action && (
        <div className="mt-1">
          <Button onClick={action.onClick}>{action.label}</Button>
        </div>
      )}
    </div>
  );
}
