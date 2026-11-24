import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/app/providers";
import { useParams, useRouter } from "next/navigation";
import { ToastProvider } from "@/components/ToastProvider";
import VerifyPage from "@/app/verify/[hash]/page";
import ReportsPage from "@/app/(app)/reports/page";
import DashboardPage from "@/app/(app)/dashboard/page";
import InvoicesPage from "@/app/(app)/invoices/page";
import TransactionsPage from "@/app/(app)/transactions/page";
import NotificationsPage from "@/app/(app)/notifications/page";

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: vi.fn(), useParams: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="dynamic-chart" /> }));
vi.mock("@/app/providers", () => ({ useAuth: vi.fn() }));

const push = vi.fn();
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(json: unknown, status = 200, headers: Record<string, string> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) =>
        name === "content-type" ? "application/json" : (headers[name.toLowerCase()] ?? null),
    },
    text: async () => JSON.stringify(json),
    json: async () => json,
    blob: async () => new Blob(["csv"]),
  };
}


function mockReportData(data: unknown, analytics: unknown = {}) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes("/reports/analytics")) return jsonResponse(analytics);
    return jsonResponse(data);
  });
}

function renderPage(page: React.ReactElement) {
  return render(<ToastProvider>{page}</ToastProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.mocked(useRouter).mockReturnValue({ push, replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  vi.mocked(useParams).mockReturnValue({ hash: "abc123" } as unknown as ReturnType<typeof useParams>);
  vi.mocked(useAuth).mockReturnValue({ can: () => true } as unknown as ReturnType<typeof useAuth>);
  vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
});

describe("VerifyPage", () => {
  it("shows a skeleton while loading", () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    render(<VerifyPage />);
    expect(document.querySelector(".animate-pulse, .animate-shimmer, .rounded-xl.h-96")).toBeInTheDocument();
  });

  it("shows an error alert when verification fails", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Receipt not found" }, 404));
    render(<VerifyPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Receipt not found");
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/verify/abc123");
  });

  it("renders a public receipt and explorer link", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        hash: "abc123",
        status: "confirmed",
        amount: "12.5",
        asset_code: "XLM",
        settled_invoice: "INV-1",
        source: "GSOURCE",
        destination: "GDEST",
        memo: "memo",
        confirmed_at: "2026-11-24T12:00:00Z",
      }),
    );
    render(<VerifyPage />);
    expect(await screen.findByText("12.5 XLM")).toBeInTheDocument();
    expect(screen.getByText("INV-1")).toBeInTheDocument();
    expect(screen.getByText("GSOURCE")).toBeInTheDocument();
    expect(screen.getAllByText("Confirmed").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /Verify on Stellar Expert/ })).toHaveAttribute(
      "href",
      "https://stellar.expert/explorer/testnet/tx/abc123",
    );
    expect(screen.getByText(/Independently verifiable/)).toBeInTheDocument();
  });

  it("uses fallbacks for missing optional receipt fields", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ hash: "h" }));
    render(<VerifyPage />);
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0));
    expect(screen.getByText("(none)")).toBeInTheDocument();
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("h")).toBeInTheDocument();
  });
});

describe("ReportsPage", () => {
  it("shows the loading skeleton and an error alert", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    renderPage(<ReportsPage />);
    expect(document.querySelectorAll(".animate-shimmer").length).toBeGreaterThan(0);

    fetchMock.mockResolvedValue(jsonResponse({ detail: "No access" }, 403));
    renderPage(<ReportsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("No access");
  });

  it("renders report statistics and chart sections", async () => {
    mockReportData(
      { total_paid: "1000", counts: { invoices: 5, agreements_active: 2 }, monthly_volume: { "2026-11": "100" } },
      { outstanding_liabilities: "250" },
    );
    renderPage(<ReportsPage />);
    expect(await screen.findByText("1,000.00")).toBeInTheDocument();
    expect(screen.getByText("250.00")).toBeInTheDocument();
    expect(screen.getAllByText("5").length).toBeGreaterThan(0);
    expect(screen.getAllByTestId("dynamic-chart")).toHaveLength(2);
    expect(screen.getByText("Payment volume")).toBeInTheDocument();
    expect(screen.getByText("Settlement split")).toBeInTheDocument();
  });

  it("shows the no-activity message for empty data", async () => {
    mockReportData({ counts: { invoices: 0 }, monthly_volume: {} });
    renderPage(<ReportsPage />);
    expect(await screen.findByText("No activity to chart yet.")).toBeInTheDocument();
  });

  it("exports a CSV and reports failures", async () => {
    mockReportData({ counts: { invoices: 1 }, monthly_volume: {} }, { outstanding_liabilities: "0" });
    renderPage(<ReportsPage />);
    const exportButton = await screen.findByRole("button", { name: "Export CSV" });

    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200, { "content-disposition": 'attachment; filename="payments.csv"' }));
    await userEvent.click(exportButton);
    await waitFor(() => expect(screen.getByText("Export ready")).toBeInTheDocument());
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/reports/payments.csv");

    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Export failed" }, 500));
    await userEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("Could not export report")).toBeInTheDocument();
  });
});

describe("DashboardPage", () => {
  it("renders a loading skeleton and an error alert", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    render(<DashboardPage />);
    expect(document.querySelectorAll(".animate-shimmer").length).toBeGreaterThan(0);

    fetchMock.mockResolvedValue(jsonResponse({ detail: "Forbidden" }, 403));
    render(<DashboardPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Forbidden");
  });

  it("renders statistics, approval queue and recent transactions", async () => {
    mockReportData({
        counts: { invoices: 12, payments_pending: 2, agreements_active: 3, milestones_released: 4, payments_confirmed: 9 },
        total_paid: "1500",
        monthly_volume: { "2026-11": "50" },
        recent_transactions: [
          {
            hash: "abcdefghijklmnopqrstuvwxyz",
            amount: "10.5",
            asset_code: "XLM",
            status: "confirmed",
            created_at: "2026-11-24T12:00:00Z",
          },
        ],
    }, { outstanding_liabilities: "300" });
    render(<DashboardPage />);
    expect(await screen.findByText("12")).toBeInTheDocument();
    expect(screen.getByText("1,500.00")).toBeInTheDocument();
    expect(screen.getByText("2 awaiting approval")).toBeInTheDocument();
    expect(screen.getByText("abcdefghij…stuvwxyz")).toBeInTheDocument();
    expect(screen.getByTestId("dynamic-chart")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /New invoice/ })).toHaveAttribute("href", "/invoices/new");
  });

  it("shows empty states when there is no activity or approval queue", async () => {
    mockReportData({ counts: { invoices: 0 }, monthly_volume: {} });
    render(<DashboardPage />);
    expect(await screen.findByText("No activity yet")).toBeInTheDocument();
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    expect(screen.getByText("No transactions yet")).toBeInTheDocument();
  });
});

describe("InvoicesPage", () => {
  const invoices = [
    { id: "inv-1", invoice_number: "INV-001", description: "October services", amount: "100", status: "pending", due_date: "2026-12-01", supplier: { business_name: "Northwind" } },
    { id: "inv-2", invoice_number: "INV-002", description: "Hardware", amount: "50", status: "paid", due_date: "2026-11-01" },
  ];

  it("searches, filters and navigates on row click", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ items: invoices, total: 2, page: 1, per_page: 20 }));
    render(<InvoicesPage />);
    expect(await screen.findByText("INV-001")).toBeInTheDocument();
    expect(screen.getByText("Northwind")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Search invoices"), "hardware");
    await waitFor(() => expect(screen.queryByText("INV-001")).not.toBeInTheDocument());
    expect(screen.getByText("INV-002")).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Search invoices"));

    await user.click(screen.getByRole("tab", { name: "Paid" }));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/invoices?status=paid"));
    const rows = screen.getAllByRole("link");
    fireEvent.click(screen.getByText("INV-002").closest("tr") as HTMLElement);
    expect(push).toHaveBeenCalledWith("/invoices/inv-2");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("renders an array payload and an empty state", async () => {
    fetchMock.mockResolvedValue(jsonResponse(invoices));
    render(<InvoicesPage />);
    expect(await screen.findByText("INV-001")).toBeInTheDocument();

    fetchMock.mockResolvedValue(jsonResponse([]));
    render(<InvoicesPage />);
    await waitFor(() => expect(screen.getAllByText("No invoices found").length).toBe(1));
  });

  it("shows an error alert", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Denied" }, 403));
    render(<InvoicesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  });
});

describe("TransactionsPage", () => {
  const transactions = [
    { hash: "aaaaaaaaaaaaaaaaaaaaaaaa", amount: "5", status: "confirmed", created_at: "2026-11-24" },
    { hash: "bbbbbbbbbbbbbbbbbbbbbbbb", amount: "7", status: "pending", successful: false },
  ];

  it("renders transactions, filters, searches and opens a transaction", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ items: transactions }));
    render(<TransactionsPage />);
    expect(await screen.findByText("aaaaaaaaaa…aaaaaaaa")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Pending" }));
    await waitFor(() => expect(screen.queryByText("aaaaaaaaaa…aaaaaaaa")).not.toBeInTheDocument());
    expect(screen.getByText("bbbbbbbbbb…bbbbbbbb")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "All" }));

    await user.type(screen.getByLabelText("Search transactions"), "aaaa");
    await waitFor(() => expect(screen.queryByText("bbbbbbbbbb…bbbbbbbb")).not.toBeInTheDocument());
    fireEvent.click(screen.getByText("aaaaaaaaaa…aaaaaaaa").closest("tr") as HTMLElement);
    expect(push).toHaveBeenCalledWith("/transactions/aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(screen.getAllByRole("link", { name: "View on Stellar Expert" })).toHaveLength(1);
  });

  it("handles raw arrays, successful status and empty/error states", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ hash: "cccc", amount: "1", status: "successful" }]));
    render(<TransactionsPage />);
    expect(await screen.findByText("cccc")).toBeInTheDocument();

    fetchMock.mockResolvedValue(jsonResponse(null));
    render(<TransactionsPage />);
    await waitFor(() => expect(screen.getAllByText("No transactions found").length).toBe(1));

    fetchMock.mockResolvedValue(jsonResponse({ detail: "Oops" }, 500));
    render(<TransactionsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Oops");
  });
});

describe("NotificationsPage", () => {
  const notifications = [
    { id: "n1", title: "Payment confirmed", message: "INV-1 paid", created_at: "2026-11-24T12:00:00Z", is_read: false },
    { id: "n2", title: "Older news", read: true },
  ];

  it("lists notifications and marks one as read", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ items: notifications }));
    renderPage(<NotificationsPage />);
    expect(await screen.findByText("Payment confirmed")).toBeInTheDocument();
    expect(screen.getByText(/1 unread/)).toBeInTheDocument();
    expect(screen.getByText("Older news")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Mark as read" }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => call[0] === "/api/v1/notifications/n1/read")).toBe(true));
  });

  it("filters unread and marks all as read", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(notifications));
    renderPage(<NotificationsPage />);
    expect(await screen.findByText("Payment confirmed")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() => expect(screen.getByText("All notifications marked as read")).toBeInTheDocument());
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/notifications/read-all");

    await user.click(screen.getByRole("tab", { name: /Unread/ }));
    await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toBe("/api/v1/notifications?unread_only=true"));
  });

  it("shows an empty state and an error alert", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    renderPage(<NotificationsPage />);
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();

    fetchMock.mockResolvedValue(jsonResponse({ detail: "Denied" }, 403));
    renderPage(<NotificationsPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Denied");
  });

  it("reports a failed mark-as-read request", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse(notifications));
    renderPage(<NotificationsPage />);
    expect(await screen.findByText("Payment confirmed")).toBeInTheDocument();
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Cannot update" }, 500));
    await user.click(screen.getByRole("button", { name: "Mark as read" }));
    expect(await screen.findByText("Could not update notification")).toBeInTheDocument();
  });
});
