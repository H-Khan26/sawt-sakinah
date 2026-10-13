/** A tool field's label in Jost 12 capitals, tracked like the sliders' own labels. */
export function FieldLabel({ children }: { children: string }) {
  return <span className="text-xs uppercase tracking-[0.16em] text-text-tertiary">{children}</span>;
}
