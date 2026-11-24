import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRouter } from "next/navigation";
import { Providers, useAuth } from "../src/app/providers";
import { getActiveBusinessId } from "../src/lib/api";

vi.mock("next/navigation", () => ({ useRouter: vi.fn() }));

const push = vi.fn();
const refreshRouter = vi.fn();
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(json: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(json),
    json: async () => json,
    blob: async () => new Blob(["x"]),
  };
}

const businesses = [
  { id: "b1", name: "Acme Ltd", role: "owner" },
  { id: "b2", name: "Beta Inc" },
];
const memberships = [{ business: { id: "b2", name: "Beta Inc" }, role: "finance_manager" }];

function Harness() {
  const auth = useAuth();
  return (
    <div>
      <span data-testid="user">{auth.user?.email ?? "none"}</span>
      <span data-testid="business-count">{auth.businesses.length}</span>
      <span data-testid="active">{auth.activeBusinessId ?? "none"}</span>
      <span data-testid="active-name">{auth.activeBusiness?.name ?? "none"}</span>
      <span data-testid="role">{auth.role ?? "none"}</span>
      <span data-testid="ready">{String(auth.ready)}</span>
      <span data-testid="loading">{String(auth.loading)}</span>
      <span data-testid="error">{auth.error ?? "none"}</span>
      <span data-testid="can-admin">{String(auth.can("admin"))}</span>
      <span data-testid="can-owner">{String(auth.can("owner"))}</span>
      <button onClick={() => auth.selectBusiness("b2")}>select b2</button>
      <button onClick={() => void auth.logout()}>logout</button>
      <button onClick={() => void auth.refresh()}>refresh</button>
      <button onClick={() => auth.can("owner", "admin")}>check roles</button>
    </div>
  );
}

function mockAuthEndpoints() {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/auth/me")) return jsonResponse({ user: { id: "u1", email: "alex@acme.com" }, memberships });
    if (url.includes("/businesses")) return jsonResponse(businesses);
    if (url.includes("/auth/logout")) return jsonResponse({ ok: true });
    return jsonResponse({});
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  localStorage.clear();
  vi.mocked(useRouter).mockReturnValue({ push, refresh: refreshRouter, replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
});

describe("Providers / useAuth", () => {
  it("throws when useAuth is used outside Providers", () => {
    expect(() => render(<Harness />)).toThrow("useAuth must be used inside Providers");
  });

  it("loads the session, selects the first business and exposes role helpers", async () => {
    mockAuthEndpoints();
    render(<Providers><Harness /></Providers>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    expect(screen.getByTestId("user")).toHaveTextContent("alex@acme.com");
    expect(screen.getByTestId("business-count")).toHaveTextContent("2");
    expect(screen.getByTestId("active")).toHaveTextContent("b1");
    expect(screen.getByTestId("active-name")).toHaveTextContent("Acme Ltd");
    expect(screen.getByTestId("role")).toHaveTextContent("owner");
    expect(screen.getByTestId("can-owner")).toHaveTextContent("true");
    expect(screen.getByTestId("can-admin")).toHaveTextContent("false");
    expect(getActiveBusinessId()).toBe("b1");
  });

  it("uses a saved business id when it is still valid", async () => {
    localStorage.setItem("bizflow.active_business_id", "b2");
    mockAuthEndpoints();
    render(<Providers><Harness /></Providers>);
    await waitFor(() => expect(screen.getByTestId("active")).toHaveTextContent("b2"));
    expect(screen.getByTestId("role")).toHaveTextContent("finance_manager");
    expect(screen.getByTestId("can-admin")).toHaveTextContent("false");
  });

  it("treats a paginated businesses response as an empty list", async () => {
    localStorage.setItem("bizflow.active_business_id", "missing");
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/auth/me")) return jsonResponse({ user: { id: "u1" }, memberships: "bad" });
      if (url.includes("/businesses")) return jsonResponse({ items: businesses });
      return jsonResponse({});
    });
    render(<Providers><Harness /></Providers>);
    await waitFor(() => expect(screen.getByTestId("loading")).toHaveTextContent("false"));
    expect(screen.getByTestId("active")).toHaveTextContent("none");
    expect(screen.getByTestId("business-count")).toHaveTextContent("0");
  });

  it("clears the session and stores an error when loading fails", async () => {
    fetchMock.mockRejectedValue(new Error("Cannot reach server"));
    render(<Providers><Harness /></Providers>);
    await waitFor(() => expect(screen.getByTestId("error")).toHaveTextContent("Unable to reach the server"));
    expect(screen.getByTestId("user")).toHaveTextContent("none");
    expect(screen.getByTestId("ready")).toHaveTextContent("false");
    expect(getActiveBusinessId()).toBeNull();
  });

  it("selects a business and logs out, clearing storage and navigating", async () => {
    const user = userEvent.setup();
    mockAuthEndpoints();
    render(<Providers><Harness /></Providers>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));

    await user.click(screen.getByRole("button", { name: "select b2" }));
    expect(localStorage.getItem("bizflow.active_business_id")).toBe("b2");
    expect(getActiveBusinessId()).toBe("b2");
    await user.click(screen.getByRole("button", { name: "check roles" }));
    expect(screen.getByTestId("can-owner")).toHaveTextContent("false");

    await user.click(screen.getByRole("button", { name: "logout" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
    expect(refreshRouter).toHaveBeenCalledOnce();
    expect(localStorage.getItem("bizflow.active_business_id")).toBeNull();
    expect(screen.getByTestId("user")).toHaveTextContent("none");
  });

  it("logs out even when the logout request fails", async () => {
    const user = userEvent.setup();
    mockAuthEndpoints();
    render(<Providers><Harness /></Providers>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    await user.click(screen.getByRole("button", { name: "logout" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login"));
  });

  it("supports a manual refresh", async () => {
    const user = userEvent.setup();
    mockAuthEndpoints();
    render(<Providers><Harness /></Providers>);
    await waitFor(() => expect(screen.getByTestId("ready")).toHaveTextContent("true"));
    await user.click(screen.getByRole("button", { name: "refresh" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });
});
