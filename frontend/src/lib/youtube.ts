/**
 * Loose client-side YouTube URL check. This only guards against obvious typos before we
 * POST — the backend is the authoritative validator (it resolves availability, region
 * locks, live streams, etc.). Accepts youtube.com/watch, youtu.be, and /shorts links with
 * or without protocol/www.
 */
const YT_PATTERN =
  /^(https?:\/\/)?(www\.)?(m\.)?(youtube\.com\/(watch\?[^\s]*v=|shorts\/|live\/|embed\/)|youtu\.be\/)[\w-]+/i;

export function isLikelyYouTubeUrl(value: string): boolean {
  return YT_PATTERN.test(value.trim());
}
