import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/app/providers";
import { useParams, useRouter } from "next/navigation";
import { ToastProvider } from "@/components/ToastProvider";
import NewInvoicePage from "@/app/(app)/invoices/new/page";
import NewAgreementPage from "@/app/(app)/agreements/new/page";
import InvoiceDetailPage from "@/app/(app)/invoices/[id]/page";
import AgreementDetailPage from "@/app/(app)/agreements/[id]/page";
import ApprovalsPage from "@/app/(app)/payments/approve/page";
import SettingsPage from "@/app/(app)/settings/page";
import WalletPage from "@/app/(app)/wallet/page";

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: vi.fn(), useParams: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@/app/providers", () => ({ useAuth: vi.fn() }));
vi.mock("@/lib/stellar", () => ({
  assertTestnet: vi.fn().mockResolvedValue({}),
  connectWallet: vi.fn().mockResolvedValue("GADDRESS"),
  getWalletAddress: vi.fn().mockResolvedValue(null),
  getNetwork: vi.fn().mockResolvedValue({ network: "Testnet", networkPassphrase: "Test SDF Network ; September 2015" }),
  getBalances: vi.fn().mockResolvedValue([]),
  hasFreighterProvider: vi.fn(() => false),
  isFreighterInstalled: vi.fn().mockResolvedValue(false),
  explorerUrl: vi.fn((hash: string) => `https://explorer/${hash}`),
  parseTransactionDetails: vi.fn(() => ({ hash: "prepared" })),
  buildAndSignPayment: vi.fn(),
  buildAndSignEscrowFund: vi.fn(),
  buildAndSignMilestoneApproval: vi.fn(),
  buildAndSignMilestoneRelease: vi.fn(),
  signTransaction: vi.fn().mockResolvedValue("signed"),
  WalletError: class extends Error {},
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const VALID_KEY = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";

function response(json: unknown, status = 200) {
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

const suppliers = [{ id: "s1", business_name: "Northwind", wallet_address: VALID_KEY, status: "active" }];

const invoice = {
  id: "inv-1",
  invoice_number: "INV-1",
  supplier_id: "s1",
  description: "Services",
  amount: "100",
  status: "draft",
  due_date: "2026-12-01T00:00:00Z",
};

const agreement = {
  id: "ag-1",
  title: "Website build",
  total_amount: "100",
  asset_code: "XLM",
  status: "draft",
  expiry_date: "2026-12-01T00:00:00Z",
  milestones: [{ id: "m1", description: "Design", amount: "100", status: "pending" }],
  conditions: '{"delivery":"on receipt"}',
};

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useParams).mockReturnValue({ id: "inv-1" } as unknown as ReturnType<typeof useParams>);
  vi.mocked(useAuth).mockReturnValue({
    can: () => true,
    role: "owner",
    activeBusinessId: "b1",
    activeBusiness: { id: "b1", name: "Acme Ltd" },
    refresh: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useAuth>);
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/suppliers?status=active")) return response(suppliers);
    if (url.includes("/suppliers/s1")) return response(suppliers[0]);
    if (url.includes("/payments?")) return response([]);
    if (url.includes("/businesses/b1/members")) return response([{ user: { id: "u1", email: "a@b.com", full_name: "Alex" }, role: "admin", status: "active" }]);
    if (url.includes("/agreements/ag-1")) return response(agreement);
    if (url.includes("/invoices/inv-1")) return response(invoice);
    if (url.includes("/wallets")) return response([]);
    return response({});
  });
});

describe("NewInvoicePage", () => {
  it("renders the supplier-backed form with validation", async () => {
    renderPage(<NewInvoicePage />);
    expect(await screen.findByRole("heading", { name: "New invoice" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Supplier/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create invoice" })).toBeInTheDocument();
  });
});

describe("NewAgreementPage", () => {
  it("renders the milestone form and default total", async () => {
    renderPage(<NewAgreementPage />);
    expect(await screen.findByRole("heading", { name: "New agreement" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Supplier/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create agreement" })).toBeInTheDocument();
  });
});

describe("InvoiceDetailPage", () => {
  it("shows loading and error states", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    renderPage(<InvoiceDetailPage />);
    expect(screen.getByText("Loading invoice…")).toBeInTheDocument();

    fetchMock.mockResolvedValue(response({ detail: "Missing" }, 404));
    renderPage(<InvoiceDetailPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing");
  });

  it("renders a draft invoice with its supplier and payment table", async () => {
    renderPage(<InvoiceDetailPage />);
    expect(await screen.findByText("Services")).toBeInTheDocument();
    expect(await screen.findByText("Northwind")).toBeInTheDocument();
    expect(await screen.findByText("No payments yet")).toBeInTheDocument();
  });
});

describe("AgreementDetailPage", () => {
  it("shows loading and error states", async () => {
    vi.mocked(useParams).mockReturnValue({ id: "ag-1" } as unknown as ReturnType<typeof useParams>);
    fetchMock.mockReturnValue(new Promise(() => undefined));
    renderPage(<AgreementDetailPage />);
    expect(screen.getByText("Loading agreement…")).toBeInTheDocument();

    fetchMock.mockResolvedValue(response({ detail: "Missing" }, 404));
    renderPage(<AgreementDetailPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Missing");
  });

  it("renders a draft agreement with milestones", async () => {
    vi.mocked(useParams).mockReturnValue({ id: "ag-1" } as unknown as ReturnType<typeof useParams>);
    renderPage(<AgreementDetailPage />);
    expect(await screen.findByText("Website build")).toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
  });
});

describe("ApprovalsPage", () => {
  it("renders an empty approval queue and an error state", async () => {
    renderPage(<ApprovalsPage />);
    expect(await screen.findByRole("heading", { name: "Payment approvals" })).toBeInTheDocument();
    expect(screen.getByText("Nothing to approve")).toBeInTheDocument();
    expect(screen.getByText("Approval queue is clear")).toBeInTheDocument();

    fetchMock.mockResolvedValue(response({ detail: "Denied" }, 403));
    renderPage(<ApprovalsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  });

  it("lists pending payments with review buttons", async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes("/payments?")) return response([{ id: "pay-1", amount: "10", status: "prepared", invoice_id: "inv-1", created_at: "2026-11-24" }]);
      return response({});
    });
    renderPage(<ApprovalsPage />);
    await waitFor(() => expect(document.body.textContent).toContain("Review & sign"));
  });
});

describe("SettingsPage", () => {
  it("renders the profile and team members", async () => {
    renderPage(<SettingsPage />);
    expect(await screen.findByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Business name/)).toHaveValue("Acme Ltd");
    expect(screen.getByText("Alex")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /Role for/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send invitation" })).toBeInTheDocument();
  });
});

describe("WalletPage", () => {
  it("shows the not-installed state and registered addresses", async () => {
    renderPage(<WalletPage />);
    expect(await screen.findByText("Freighter is not installed")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("No addresses registered")).toBeInTheDocument());
    expect(screen.getByText("Network unknown")).toBeInTheDocument();
  });
});
