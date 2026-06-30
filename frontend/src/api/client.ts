/**
 * Thin fetch wrapper. All endpoints are same-origin: in dev the Vite proxy forwards
 * `/projects` and `/jobs` to the FastAPI service; in the static-served / pywebview build
 * FastAPI serves both the SPA and the API. So requests use relative paths and no base URL.
 */
import type { ApiErrorBody } from "@/types/api";

/** A typed failure from the backend (`{ error, detail }`) or a transport error. */
export class ApiError extends Error {
  readonly status: number;
  /** Pydantic/exception class name from the backend envelope, when present. */
  readonly type: string | null;

  constructor(message: string, status: number, type: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.type = type;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> | null = null;
  try {
    body = (await res.json()) as Partial<ApiErrorBody>;
  } catch {
    // non-JSON error body; fall through to the status text
  }
  const detail = body?.detail ?? res.statusText ?? "Request failed";
  return new ApiError(detail, res.status, body?.error ?? null);
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
}

/** Issue a JSON request and return the parsed body (or `undefined` for 204/empty). */
export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = "GET", body, signal } = opts;
  const res = await fetch(path, {
    method,
    signal,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    throw await parseError(res);
  }

  if (res.status === 204 || res.headers.get("content-length") === "0") {
    return undefined as T;
  }
  return (await res.json()) as T;
}
