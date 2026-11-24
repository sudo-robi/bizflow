import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/app/providers";
import { useParams, usePathname, useRouter } from "next/navigation";
import { ToastProvider } from "@/components/ToastProvider";
import LandingPage from "@/app/page";
import AppLayout from "@/app/(app)/layout";
import TransactionDetailPage from "@/app/(app)/transactions/[hash]/page";
import SupplierDetailPage from "@/app/(app)/suppliers/[id]/page";
import AgreementsPage from "@/app/(app)/agreements/page";
import SuppliersPage from "@/app/(app)/suppliers/page";

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: vi.fn(), useParams: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@/app/providers", () => ({ useAuth: vi.fn() }));

const push = vi.fn();
const replace = vi.fn();
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const VALID_KEY = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";

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

function renderPage(page: React.ReactElement) {
  return render(<ToastProvider>{page}</ToastProvider>);
}

const authFull = {
  user: { id: "u1", email: "alex@acme.com", full_name: "Alex Morgan" },
  businesses: [{ id: "b1", name: "Acme Ltd", role: "owner" }],
  activeBusinessId: "b1",
  selectBusiness: vi.fn(),
  logout: vi.fn(),
  can: () => true,
  loading: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.mocked(useRouter).mockReturnValue({ push, replace, refresh: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(usePathname).mockReturnValue("/dashboard");
  vi.mocked(useParams).mockReturnValue({ hash: "hash-1", id: "s1" } as unknown as ReturnType<typeof useParams>);
  vi.mocked(useAuth).mockReturnValue(authFull as unknown as ReturnType<typeof useAuth>);
});

describe("LandingPage", () => {
  it("renders the hero, features, steps and calls to action", () => {
    render(<LandingPage />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Business payments, with the receipts to prove it.");
    expect(screen.getByRole("link", { name: /Get started/ })).toHaveAttribute("href", "/register");
    expect(screen.getAllByRole("link", { name: /Sign in/ }).length).toBeGreaterThan(0);
    expect(screen.getByText("Invoices that settle themselves")).toBeInTheDocument();
    expect(screen.getByText("Milestone agreements")).toBeInTheDocument();
    expect(screen.getByText("Verifiable receipts")).toBeInTheDocument();
    expect(screen.getByText("Set up your workspace")).toBeInTheDocument();
    expect(screen.getByText(/Local wallet signing/)).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeInTheDocument();
  });
});

describe("AppLayout", () => {
  it("shows a loading state and redirects unauthenticated users", async () => {
    vi.mocked(useAuth).mockReturnValue({ loading: true, user: null } as unknown as ReturnType<typeof useAuth>);
    render(<AppLayout><p>Child</p></AppLayout>);
    expect(screen.getByLabelText("Loading workspace")).toBeInTheDocument();
    expect(screen.queryByText("Child")).not.toBeInTheDocument();

    vi.mocked(useAuth).mockReturnValue({ loading: false, user: null } as unknown as ReturnType<typeof useAuth>);
    render(<AppLayout><p>Child</p></AppLayout>);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("prompts for a business when none is active", () => {
    vi.mocked(useAuth).mockReturnValue({ ...authFull, activeBusinessId: null } as unknown as ReturnType<typeof useAuth>);
    render(<AppLayout><p>Child</p></AppLayout>);
    expect(screen.getByRole("heading", { name: "Create a business workspace" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Set up my business" })).toHaveAttribute("href", "/onboarding");
  });

  it("wraps children in the AppShell when ready", () => {
    render(<AppLayout><p>Child</p></AppLayout>);
    expect(screen.getByText("Child")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
  });
});

describe("TransactionDetailPage", () => {
  it("renders loading and error states", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    render(<TransactionDetailPage />);
    expect(document.querySelectorAll(".animate-shimmer").length).toBeGreaterThan(0);

    fetchMock.mockResolvedValue(jsonResponse({ detail: "Not found" }, 404));
    render(<TransactionDetailPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Not found");
  });

  it("renders a fully populated transaction and fallbacks", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        hash: "hash-1",
        status: "confirmed",
        verification_status: "verified",
        amount: "10.5",
        asset_code: "XLM",
        source_account: "GSOURCE",
        destination_account: "GDEST",
        memo: "memo",
        ledger: 123,
        fee: "100",
        created_at: "2026-11-24T12:00:00Z",
        confirmed_at: "2026-11-24T12:05:00Z",
      }),
    );
    render(<TransactionDetailPage />);
    expect(await screen.findByText("Transaction detail")).toBeInTheDocument();
    expect(screen.getByText("hash-1")).toBeInTheDocument();
    expect(screen.getByText("verified")).toBeInTheDocument();
    expect(screen.getByText("10.5000000 XLM")).toBeInTheDocument();
    expect(screen.getByText("123")).toBeInTheDocument();
    expect(screen.getByText("100 stroops")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open public receipt/ })).toHaveAttribute("href", "/verify/hash-1");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/transactions/hash-1");
  });

  it("renders dash fallbacks for sparse data and a null state", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hash: "h", successful: true }));
    render(<TransactionDetailPage />);
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0));
    expect(screen.getByText("(none)")).toBeInTheDocument();
    expect(screen.getByText("confirmed")).toBeInTheDocument();
  });
});

describe("AgreementsPage", () => {
  const agreements = [
    { id: "a1", title: "Website build", agreement_reference: "AGR-1", total_amount: "500", status: "active", milestones: [{ id: "m1" }], expiry_date: "2026-12-01", supplier: { business_name: "Northwind" } },
    { id: "a2", title: "Audit", total_amount: "200", status: "draft" },
  ];

  it("renders rows, filters and opens an agreement", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(agreements));
    render(<AgreementsPage />);
    expect(await screen.findByText("Website build")).toBeInTheDocument();
    expect(screen.getByText("AGR-1")).toBeInTheDocument();
    expect(screen.getByText("Northwind")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Draft" }));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/agreements?status=draft"));
    fireEvent.click(screen.getByText("Audit").closest("tr") as HTMLElement);
    expect(push).toHaveBeenCalledWith("/agreements/a2");
  });

  it("supports paginated payloads, empty and error states", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: agreements }));
    render(<AgreementsPage />);
    expect(await screen.findByText("Website build")).toBeInTheDocument();

    fetchMock.mockResolvedValue(jsonResponse([]));
    render(<AgreementsPage />);
    await waitFor(() => expect(screen.getAllByText("No agreements found").length).toBe(1));

    fetchMock.mockResolvedValue(jsonResponse({ detail: "Denied" }, 403));
    render(<AgreementsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  });
});

describe("SuppliersPage", () => {
  const suppliers = [
    { id: "s1", business_name: "Northwind", email: "a@northwind.com", wallet_address: VALID_KEY, status: "active", country: "UK" },
    { id: "s2", business_name: "Archived Co", wallet_address: VALID_KEY, status: "archived" },
  ];

  it("renders rows, filters and archives a supplier", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ items: suppliers }));
    renderPage(<SuppliersPage />);
    expect(await screen.findByText("Northwind")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Archived" }));
    await waitFor(() => expect(screen.queryByText("Northwind")).not.toBeInTheDocument());
    expect(screen.getByText("Archived Co")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /^All/ }));

    await user.click(screen.getByRole("button", { name: "Archive Northwind" }));
    expect(await screen.findByText("Archive supplier?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Archive supplier" }));
    await waitFor(() => expect(screen.getByText("Supplier archived")).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/v1/suppliers/s1/archive")).toBe(true);
  });

  it("creates a supplier from the modal", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage(<SuppliersPage />);
    const addButton = await screen.findByRole("button", { name: "Add supplier" });
    await user.click(addButton);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Business name/), "New Supplier");
    await user.type(screen.getByLabelText(/Stellar public address/), VALID_KEY);
    await user.click(withinDialog(dialog, "Save supplier"));
    await waitFor(() => expect(screen.getByText("Supplier added")).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/v1/suppliers" && call[1].method === "POST")).toBe(true);
  });

  it("shows search, empty and error states", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(suppliers));
    renderPage(<SuppliersPage />);
    expect(await screen.findByText("Northwind")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search suppliers"), "zzzz");
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toContain("search=zzzz"));

    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage(<SuppliersPage />);
    await waitFor(() => expect(screen.getAllByText("No suppliers yet").length).toBe(1));

    fetchMock.mockResolvedValue(jsonResponse({ detail: "Denied" }, 403));
    renderPage(<SuppliersPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  });
});

function withinDialog(dialog: HTMLElement, name: string): HTMLElement {
  const button = Array.from(dialog.querySelectorAll("button")).find((candidate) => candidate.textContent?.includes(name));
  if (!button) throw new Error(`Button ${name} not found in dialog`);
  return button;
}

describe("SupplierDetailPage", () => {
  const supplier = {
    id: "s1",
    business_name: "Northwind",
    contact_name: "Jamie",
    email: "jamie@northwind.com",
    wallet_address: VALID_KEY,
    country: "UK",
    notes: "Net 30",
    status: "active",
  };

  beforeEach(() => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/suppliers/s1")) return jsonResponse(supplier);
      if (url.includes("/invoices")) return jsonResponse([{ id: "inv-1", invoice_number: "INV-1", amount: "10", status: "paid" }]);
      return jsonResponse([{ id: "pay-1", amount: "10", status: "confirmed", transaction_hash: "hash-1" }]);
    });
  });

  it("renders loading and error states", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    renderPage(<SupplierDetailPage />);
    expect(screen.getByText("Loading supplier…")).toBeInTheDocument();

    fetchMock.mockResolvedValue(jsonResponse({ detail: "Missing" }, 404));
    renderPage(<SupplierDetailPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing");
  });

  it("renders supplier details, invoices and payments then saves edits", async () => {
    const user = userEvent.setup();
    renderPage(<SupplierDetailPage />);
    expect(await screen.findByText("Northwind")).toBeInTheDocument();
    expect(screen.getByText("jamie@northwind.com")).toBeInTheDocument();
    expect(screen.getByText("Net 30")).toBeInTheDocument();
    expect(screen.getByText("INV-1")).toBeInTheDocument();
    expect(screen.getByText("pay-1")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Edit profile/ }));
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByLabelText(/Business name/)).toHaveValue("Northwind");
    await user.click(withinDialog(dialog, "Save supplier"));
    await waitFor(() => expect(screen.getByText("Supplier updated")).toBeInTheDocument());
    expect(fetchMock.mock.calls.some((call) => call[0] === "/api/v1/suppliers/s1" && call[1].method === "PATCH")).toBe(true);
  });
});
