import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  api,
  downloadBlob,
  getActiveBusinessId,
  getErrorMessage,
  setActiveBusinessId,
} from "../src/lib/api";

type FetchCall = [string, RequestInit];

function fakeResponse(options: {
  status?: number;
  ok?: boolean;
  text?: string;
  json?: unknown;
  blob?: Blob;
  headers?: Record<string, string>;
} = {}) {
  const status = options.status ?? 200;
  const hasJson = options.json !== undefined;
  const resolvedHeaders: Record<string, string> = {
    ...(hasJson ? { "content-type": "application/json" } : {}),
    ...(options.headers ?? {}),
  };
  return {
    status,
    ok: options.ok ?? (status >= 200 && status < 300),
    headers: {
      get: (name: string) => resolvedHeaders[name.toLowerCase()] ?? null,
    },
    text: vi.fn(async () => options.text ?? (hasJson ? JSON.stringify(options.json) : "")),
    json: vi.fn(async () => options.json ?? null),
    blob: vi.fn(async () => options.blob ?? new Blob(["x"])),
  };
}

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

function lastCall(): FetchCall {
  const call = fetchMock.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return call as unknown as FetchCall;
}

describe("business id state", () => {
  afterEachClear();

  it("sets, reads and clears the active business id", () => {
    expect(getActiveBusinessId()).toBeNull();
    setActiveBusinessId("biz-1");
    expect(getActiveBusinessId()).toBe("biz-1");
    setActiveBusinessId(null);
    expect(getActiveBusinessId()).toBeNull();
  });
});

function afterEachClear() {
  beforeEach(() => {
    fetchMock.mockReset();
    setActiveBusinessId(null);
  });
}

describe("ApiError", () => {
  it("carries message, status, detail and code", () => {
    const detail = { code: "bad", detail: "nope" };
    const error = new ApiError("Bad", 400, detail, "VALIDATION");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApiError");
    expect(error.message).toBe("Bad");
    expect(error.status).toBe(400);
    expect(error.detail).toBe(detail);
    expect(error.code).toBe("VALIDATION");
  });

  it("defaults the code to undefined", () => {
    expect(new ApiError("x", 500, null).code).toBeUndefined();
  });
});

describe("api.get / post / patch / delete", () => {
  afterEachClear();

  it("sends a GET with credentials, no-store cache and JSON parsing", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ json: { ok: true } }) as unknown as Response);
    setActiveBusinessId("biz-42");

    const result = await api.get<{ ok: boolean }>("/things");

    expect(result).toEqual({ ok: true });
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/things");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("include");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBeUndefined();
    const headers = init.headers as Headers;
    expect(headers.get("X-Business-ID")).toBe("biz-42");
    expect(headers.get("Content-Type")).toBeNull();
  });

  it("does not send the business id for public endpoints", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ json: {} }) as unknown as Response);
    setActiveBusinessId("biz-42");
    await api.get("/auth/me", { public: true });
    expect((lastCall()[1].headers as Headers).get("X-Business-ID")).toBeNull();
  });

  it("serialises object bodies as JSON with the right content type", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ json: { id: "1" } }) as unknown as Response);
    await api.post("/things", { name: "A" });
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/things");
    expect(init.method).toBe("POST");
    expect(init.body).toBe('{"name":"A"}');
    expect((init.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  it("passes custom headers through and allows overriding defaults", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ json: {} }) as unknown as Response);
    await api.patch("/things/1", { a: 1 }, { headers: { "X-Trace": "abc" } });
    const [, init] = lastCall();
    expect((init.headers as Headers).get("X-Trace")).toBe("abc");
    expect(init.method).toBe("PATCH");
  });

  it("sends DELETE requests without a body", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 204 }) as unknown as Response);
    const result = await api.delete("/things/1");
    expect(result).toBeUndefined();
    expect(lastCall()[1].method).toBe("DELETE");
    expect(lastCall()[1].body).toBeUndefined();
  });

  it("returns undefined on 204 even if the server sent content", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 204, json: { ignored: true } }) as unknown as Response);
    expect(await api.get("/empty")).toBeUndefined();
  });

  it("returns raw text for non-JSON success responses", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ text: "plain text", headers: { "content-type": "text/plain" } }) as unknown as Response,
    );
    expect(await api.get("/text")).toBe("plain text");
  });

  it("passes Blob bodies through untouched without a JSON content type", async () => {
    const blob = new Blob(["bytes"]);
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 204 }) as unknown as Response);
    await api.post("/upload", blob);
    const [, init] = lastCall();
    expect(init.body).toBe(blob);
    expect((init.headers as Headers).get("Content-Type")).toBeNull();
  });

  it("omits the body entirely when it is null or undefined", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 204 }) as unknown as Response);
    await api.post("/no-body", null);
    expect(lastCall()[1].body).toBeUndefined();
  });
});

describe("request errors", () => {
  afterEachClear();

  it("maps network failures to a NETWORK_ERROR ApiError", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(api.get("/x")).rejects.toMatchObject({
      name: "ApiError",
      status: 0,
      code: "NETWORK_ERROR",
      message: "Unable to reach the server. Check your connection and try again.",
    });
  });

  it("uses a plain string error detail as the message", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 400, ok: false, text: '"Bad input"' }) as unknown as Response);
    await expect(api.get("/x")).rejects.toMatchObject({ status: 400, message: "Bad input" });
  });

  it("formats FastAPI validation error arrays with a location", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({
        status: 422,
        ok: false,
        text: JSON.stringify([{ loc: ["body", "amount"], msg: "Invalid value" }]),
      }) as unknown as Response,
    );
    await expect(api.post("/x", {})).rejects.toMatchObject({ status: 422, message: "body.amount: Invalid value" });
  });

  it("formats FastAPI validation error arrays without a location", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 422, ok: false, text: JSON.stringify([{ msg: "Nope" }]) }) as unknown as Response,
    );
    await expect(api.get("/x")).rejects.toMatchObject({ message: "Nope" });
  });

  it("falls back to Invalid value when an array item has no msg", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 422, ok: false, text: JSON.stringify([{ loc: ["query", "q"] }]) }) as unknown as Response,
    );
    await expect(api.get("/x")).rejects.toMatchObject({ message: "query.q: Invalid value" });
  });

  it("extracts detail/message/code from object error payloads", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 403, ok: false, json: { detail: "Forbidden", code: "FORBIDDEN" } }) as unknown as Response,
    );
    await expect(api.get("/x")).rejects.toMatchObject({ status: 403, message: "Forbidden", code: "FORBIDDEN" });

    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 500, ok: false, json: { message: "Server exploded" } }) as unknown as Response,
    );
    await expect(api.get("/y")).rejects.toMatchObject({ message: "Server exploded" });
  });

  it("uses a generic fallback for unrecognised error payloads", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 503, ok: false, json: { unexpected: true } }) as unknown as Response);
    await expect(api.get("/x")).rejects.toMatchObject({ message: "Request failed (503)", code: undefined });
  });

  it("tolerates non-JSON error bodies", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 502, ok: false, text: "<html>bad gateway</html>" }) as unknown as Response,
    );
    await expect(api.get("/x")).rejects.toMatchObject({ status: 502, message: "Request failed (502)" });
  });
});

describe("api.download", () => {
  afterEachClear();

  it("downloads a blob and parses the filename from content-disposition", async () => {
    const blob = new Blob(["pdf"]);
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ blob, headers: { "content-disposition": 'attachment; filename="invoice.pdf"' } }) as unknown as Response,
    );
    setActiveBusinessId("biz-9");
    const result = await api.download("/invoices/1/pdf", "fallback.pdf");
    expect(result.blob).toBe(blob);
    expect(result.filename).toBe("invoice.pdf");
    const [url, init] = lastCall();
    expect(url).toBe("/api/v1/invoices/1/pdf");
    expect(init.method).toBe("GET");
    expect((init.headers as Headers).get("X-Business-ID")).toBe("biz-9");
    expect(init.credentials).toBe("include");
  });

  it("decodes UTF-8 filenames and falls back when no disposition header is present", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ headers: { "content-disposition": "attachment; filename*=UTF-8''report%20%E2%82%AC.pdf" } }) as unknown as Response,
    );
    expect((await api.download("/x", "fallback.csv")).filename).toBe("report €.pdf");

    fetchMock.mockResolvedValueOnce(fakeResponse({}) as unknown as Response);
    expect((await api.download("/y", "fallback.csv")).filename).toBe("fallback.csv");
  });

  it("throws an ApiError with detail from a JSON error response", async () => {
    fetchMock.mockResolvedValueOnce(
      fakeResponse({ status: 404, ok: false, json: { detail: "Not found", code: "MISSING" } }) as unknown as Response,
    );
    await expect(api.download("/missing", "f")).rejects.toMatchObject({
      status: 404,
      message: "Not found",
      code: "MISSING",
    });
  });

  it("throws a fallback ApiError when the error body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse({ status: 500, ok: false, text: "oops" }) as unknown as Response);
    await expect(api.download("/broken", "f")).rejects.toMatchObject({ message: "Download failed (500)" });
  });

  it("throws a fallback ApiError when reading the error body throws", async () => {
    const response = fakeResponse({ status: 502, ok: false });
    response.json.mockRejectedValueOnce(new Error("stream broken"));
    fetchMock.mockResolvedValueOnce(response as unknown as Response);
    await expect(api.download("/broken", "f")).rejects.toMatchObject({ message: "Download failed (502)" });
  });
});

describe("downloadBlob", () => {
  it("creates a temporary anchor, clicks it, removes it and revokes the URL", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:test");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });

    const remove = vi.spyOn(HTMLAnchorElement.prototype, "remove");
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const blob = new Blob(["data"]);

    downloadBlob(blob, "report.csv");

    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(document.querySelector("a[download='report.csv']")).toBeNull();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
    vi.unstubAllGlobals();
  });
});

describe("getErrorMessage", () => {
  it("prefers ApiError messages, then Error messages, then a generic message", () => {
    expect(getErrorMessage(new ApiError("api", 400, null))).toBe("api");
    expect(getErrorMessage(new Error("plain"))).toBe("plain");
    expect(getErrorMessage({ weird: true })).toBe("Something went wrong. Please try again.");
    expect(getErrorMessage("oops")).toBe("Something went wrong. Please try again.");
  });
});
