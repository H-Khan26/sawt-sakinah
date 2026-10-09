/**
 * Thin fetch wrapper. All endpoints are same-origin: in dev the Vite proxy forwards
 * the API prefixes (`/projects`, `/jobs`, `/models`, `/app/`) to the FastAPI service; in the static-served / pywebview build
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
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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

export interface UploadOptions {
  /** Called with the send fraction (0..1) as the browser uploads the body. */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

/**
 * Multipart file upload with progress. `fetch` cannot report upload progress, so this uses
 * `XMLHttpRequest` and mirrors `request`'s error envelope (`{ error, detail }`) so callers
 * get the same typed `ApiError`. Resolves the parsed JSON body (or `undefined` if empty).
 */
export function upload<T>(path: string, file: File, opts: UploadOptions = {}): Promise<T> {
  const { onProgress, signal } = opts;
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ApiError("Upload aborted", 0));
      return;
    }
    const form = new FormData();
    form.append("file", file, file.name);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);

    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort);
    const cleanup = () => signal?.removeEventListener("abort", onAbort);

    const parseBody = (): Partial<ApiErrorBody> | null => {
      try {
        return JSON.parse(xhr.responseText) as Partial<ApiErrorBody>;
      } catch {
        return null;
      }
    };

    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve((parseBody() ?? undefined) as T);
      } else {
        const body = parseBody();
        reject(
          new ApiError(
            body?.detail ?? xhr.statusText ?? "Upload failed",
            xhr.status,
            body?.error ?? null,
          ),
        );
      }
    };
    xhr.onerror = () => {
      cleanup();
      reject(new ApiError("Network error during upload", 0));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new ApiError("Upload aborted", 0));
    };

    xhr.send(form);
  });
}
