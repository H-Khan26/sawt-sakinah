/** Small display formatters for the library, settings and ornament numerals. */

/** A download size in decimal units: `850 MB`, `1.6 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
}

/** {@link formatBytes} for a size given in megabytes (the model catalog's `size_mb`). */
export const formatMegabytes = (mb: number): string => formatBytes(mb * 1e6);

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DAY_MS = 86_400_000;

/**
 * When a recording was last edited, by calendar day: `today`, `yesterday`, `3 days ago`,
 * `last week`, `2 weeks ago`, then a localized date from four weeks on. Input is an ISO-8601
 * string (UTC); days follow the local calendar.
 */
export function formatRelativeTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(then);
  day.setHours(0, 0, 0, 0);
  const days = Math.max(0, Math.round((today.getTime() - day.getTime()) / DAY_MS));
  if (days < 7) return RELATIVE.format(-days, "day");
  if (days < 28) return RELATIVE.format(-Math.floor(days / 7), "week");
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: then.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/** A recording's length: `24:18` under an hour, `1:12:40` from an hour on. */
export function formatLength(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** A number in Arabic-Indic digits (`12` -> `١٢`), for star numerals set in Amiri. */
export function toArabicIndic(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
}
