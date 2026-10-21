/**
 * Client-side link check against the sites `GET /app/platforms` lists: is the text a link, is
 * its site supported, and can this install import from it. It mirrors the backend's first
 * stages so the New recording sheet can answer while typing; whether the link is a single post
 * (and everything after) is the backend's call, which a 400 from `POST /projects` reports.
 */
import type { ErrorAction, PlatformInfo } from "@/types/api";

const NOT_A_LINK = "That isn't a link. Paste the address of a post or video.";
// A bare YouTube video id, which the backend also accepts.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export type LinkCheck =
  | {
      ok: true;
      /** The matched site; `null` while the site list is unknown (the backend decides). */
      platform: PlatformInfo | null;
      /** A share link, which the import follows to the post. */
      share: boolean;
    }
  | {
      ok: false;
      reason: "invalid" | "unsupported" | "unavailable";
      message: string;
      /** What fixes an unavailable site, when anything. */
      action?: ErrorAction | null;
    };

/** The pasted text as an http(s) URL, or `null` when it isn't a link. */
function parseLink(text: string): URL | null {
  let candidate = text.trim();
  if (VIDEO_ID.test(candidate)) candidate = `https://www.youtube.com/watch?v=${candidate}`;
  if (!candidate || /\s/.test(candidate)) return null;
  if (!SCHEME.test(candidate)) candidate = `https://${candidate}`;
  try {
    const url = new URL(candidate);
    const host = url.hostname.replace(/\.$/, "");
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !host.includes(".")) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** The site whose hosts include `host` or a parent domain of it. */
function platformForHost(host: string, platforms: PlatformInfo[]): PlatformInfo | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  return platforms.find((p) => p.hosts.some((d) => h === d || h.endsWith(`.${d}`)));
}

function isShareLink(url: string, platform: PlatformInfo): boolean {
  return platform.share_patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(url);
    } catch {
      return false;
    }
  });
}

/** Labels as a sentence list: "YouTube, Instagram, X and Facebook" (or "… or Facebook"). */
export function listLabels(labels: string[], conjunction: "and" | "or" = "and"): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} ${conjunction} ${labels[labels.length - 1]}`;
}

/** Check pasted or typed text before importing it. `platforms` unknown: only the link shape. */
export function checkLink(text: string, platforms: PlatformInfo[] | undefined): LinkCheck {
  const url = parseLink(text);
  if (!url) return { ok: false, reason: "invalid", message: NOT_A_LINK };
  if (!platforms) return { ok: true, platform: null, share: false };
  const platform = platformForHost(url.hostname, platforms);
  if (!platform) {
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    return {
      ok: false,
      reason: "unsupported",
      message: `Links from ${host} aren't supported. You can import from ${listLabels(platforms.map((p) => p.label))}.`,
    };
  }
  if (!platform.available) {
    return {
      ok: false,
      reason: "unavailable",
      message: platform.reason ?? `${platform.label} imports aren't available right now.`,
      action: platform.action,
    };
  }
  return { ok: true, platform, share: isShareLink(url.href, platform) };
}
