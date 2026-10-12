import { cn } from "@/lib/cn";
import type { ElementType, ReactNode } from "react";

export interface CetvelFrameProps {
  /** Element for the outer rule; the inner rule is always a `div`. */
  as?: ElementType;
  className?: string;
  /** Classes for the inner box that holds the children (padding, layout). */
  innerClassName?: string;
  children: ReactNode;
}

/** Cetvel double rule: a 1.5 px and a 0.6 px gold line, 5 px apart, drawn as two nested borders. */
export function CetvelFrame({
  as: Outer = "div",
  className,
  innerClassName,
  children,
}: CetvelFrameProps) {
  return (
    <Outer className={cn("orn-cetvel", className)}>
      <div className={cn("orn-cetvel-inner", innerClassName)}>{children}</div>
    </Outer>
  );
}
