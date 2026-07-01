import { cn } from "@/lib/cn";
import type { ReactNode } from "react";
import { useId, useRef, useState } from "react";

export interface TabItem {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  /** Controlled active tab id. Omit for uncontrolled (defaults to `defaultId` or first). */
  value?: string;
  defaultId?: string;
  onValueChange?: (id: string) => void;
  className?: string;
}

/**
 * Accessible tabs with roving focus: ArrowLeft/Right (and Home/End) move between tabs,
 * following the WAI-ARIA tablist pattern. Works controlled or uncontrolled.
 */
export function Tabs({ items, value, defaultId, onValueChange, className }: TabsProps) {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultId ?? items[0]?.id);
  const active = value ?? internal;
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (id: string) => {
    if (value === undefined) setInternal(id);
    onValueChange?.(id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = items.findIndex((t) => t.id === active);
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % items.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    const nextId = items[next].id;
    select(nextId);
    tabRefs.current[nextId]?.focus();
  };

  return (
    <div className={className}>
      <div role="tablist" className="flex gap-1 border-b border-border" onKeyDown={onKeyDown}>
        {items.map((tab) => {
          const selected = tab.id === active;
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[tab.id] = el;
              }}
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${baseId}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => select(tab.id)}
              className={cn(
                "-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus",
                selected
                  ? "border-accent text-accent"
                  : "border-transparent text-text-secondary hover:text-text",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {items.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${baseId}-panel-${tab.id}`}
          aria-labelledby={`${baseId}-tab-${tab.id}`}
          hidden={tab.id !== active}
          className="pt-4"
        >
          {tab.id === active && tab.content}
        </div>
      ))}
    </div>
  );
}
