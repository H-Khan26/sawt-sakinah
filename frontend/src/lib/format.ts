/** Small display formatters for the project library, switcher, settings and ornament numerals. */

/** A download size in decimal units: `850 MB`, `1.6 GB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / 1e6))} MB`;
}

/** {@link formatBytes} for a size given in megabytes (the model catalog's `size_mb`). */
export const formatMegabytes = (mb: number): string => formatBytes(mb * 1e6);

/**
 * A compact relative time like `just now`, `4m ago`, `3h ago`, `2d ago`, falling back to a
 * localized date for anything older than a week. Input is an ISO-8601 string (UTC).
 */
export function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The bare host of a URL (`youtu.be`, `www.youtube.com` -> `youtube.com`), or the raw
 * string if it doesn't parse. Used to show provenance on library cards. */
export function formatSourceHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A number in Arabic-Indic digits (`12` -> `١٢`), for star numerals set in Amiri. */
export function toArabicIndic(n: number): string {
  return String(n).replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
}
