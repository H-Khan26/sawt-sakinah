/** A lower-band column's heading (Cut, Surahs) in the display face. */
export function ColumnHeading({ children }: { children: string }) {
  return <h2 className="font-display text-[22px] leading-none text-text">{children}</h2>;
}
