/**
 * Typed API wrapper. Authentication is an httpOnly cookie set by the backend;
 * the browser never sees the JWT and we never persist it in localStorage.
 * Business scoping is sent with X-Business-ID.
 */

const API_BASE = (process.env.NEXT_PUBLIC_API_BASE_URL || "/api/v1").replace(/\/$/, "");

let currentBusinessId: string | null = null;

export function setActiveBusinessId(id: string | null): void {
  currentBusinessId = id;
}

export function getActiveBusinessId(): string | null {
  return currentBusinessId;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly detail: unknown;

  constructor(message: string, status: number, detail: unknown, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

function errorMessage(detail: unknown, fallback: string): { message: string; code?: string } {
  if (typeof detail === "string" && detail) return { message: detail };
  if (Array.isArray(detail)) {
    const first = detail[0];
    if (first && typeof first === "object") {
      const record = first as Record<string, unknown>;
      const loc = Array.isArray(record.loc) ? record.loc.join(".") : "";
      return { message: loc ? `${loc}: ${String(record.msg ?? "Invalid value")}` : String(record.msg ?? fallback) };
    }
  }
  if (detail && typeof detail === "object") {
    const record = detail as Record<string, unknown>;
    const message = typeof record.detail === "string" ? record.detail : typeof record.message === "string" ? record.message : fallback;
    return { message, code: typeof record.code === "string" ? record.code : undefined };
  }
  return { message: fallback };
}

export interface RequestOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** Public endpoints (auth, verify) must not send X-Business-ID. */
  public?: boolean;
}

/** Double-submit CSRF token set by the backend on login/register. */
function csrfToken(): string | null {
  try {
    if (typeof document === "undefined") return null;
    const entry = document.cookie.split("; ").find((item) => item.startsWith("bizflow_csrf="));
    return entry ? decodeURIComponent(entry.slice("bizflow_csrf=".length)) : null;
  } catch {
    return null;
  }
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, public: isPublic, headers: customHeaders, ...rest } = options;
  const headers = new Headers(customHeaders);
  if (body !== undefined && body !== null && !(body instanceof Blob)) {
    headers.set("Content-Type", "application/json");
  }
  if (!isPublic && currentBusinessId) {
    headers.set("X-Business-ID", currentBusinessId);
  }
  const method = (rest.method || "GET").toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const token = csrfToken();
    if (token) headers.set("X-CSRF-Token", token);
  }

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...rest,
      headers,
      credentials: "include",
      cache: "no-store",
      body: body === undefined || body === null ? undefined : body instanceof Blob ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Unable to reach the server. Check your connection and try again.", 0, null, "NETWORK_ERROR");
  }

  if (!response.ok) {
    let detail: unknown = null;
    try {
      const text = await response.text();
      detail = text ? JSON.parse(text) : null;
    } catch {
      detail = null;
    }
    const parsed = errorMessage(detail, `Request failed (${response.status})`);
    throw new ApiError(parsed.message, response.status, detail, parsed.code);
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) return (await response.text()) as T;
  return (await response.json()) as T;
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: "GET" }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: "POST", body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>(path, { ...options, method: "PATCH", body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>(path, { ...options, method: "DELETE" }),

  /** Downloads a binary response (invoice PDF, CSV export) with the same auth headers. */
  async download(path: string, fallbackFilename: string): Promise<{ blob: Blob; filename: string }> {
    const headers = new Headers();
    if (currentBusinessId) headers.set("X-Business-ID", currentBusinessId);
    const response = await fetch(`${API_BASE}${path}`, {
      method: "GET",
      headers,
      credentials: "include",
      cache: "no-store",
    });
    if (!response.ok) {
      let detail: unknown = null;
      try {
        detail = await response.json();
      } catch {
        detail = null;
      }
      const parsed = errorMessage(detail, `Download failed (${response.status})`);
      throw new ApiError(parsed.message, response.status, detail, parsed.code);
    }
    const disposition = response.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const filename = match ? decodeURIComponent(match[1]) : fallbackFilename;
    return { blob: await response.blob(), filename };
  },
};

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}
