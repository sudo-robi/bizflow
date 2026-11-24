import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../src/components/ToastProvider";
import { EditInvoiceModal } from "../src/components/EditInvoiceModal";
import { EditAgreementModal } from "../src/components/EditAgreementModal";
import type { Invoice, Agreement } from "../src/lib/types";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function response(json: unknown, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(json),
    json: async () => json,
  };
}

function renderModal(element: React.ReactElement) {
  return render(<ToastProvider>{element}</ToastProvider>);
}

const invoice: Invoice = {
  id: "inv-1",
  description: "Old description",
  amount: "10",
  asset_code: "XLM",
  due_date: "2026-12-01T00:00:00Z",
  reference: "REF-1",
  status: "draft",
};

const agreement: Agreement = {
  id: "ag-1",
  title: "Website build",
  description: "Build the site",
  asset_code: "XLM",
  expiry_date: "2026-12-01T00:00:00Z",
  conditions: { delivery: "on receipt" } as never,
  approval_requirements: "",
  status: "draft",
  total_amount: "100",
};

beforeEach(() => {
  fetchMock.mockReset();
});

describe("EditInvoiceModal", () => {
  it("renders prefilled fields and cancels", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(<EditInvoiceModal invoice={invoice} onClose={onClose} onSaved={() => undefined} />);
    expect(screen.getByRole("heading", { name: "Edit invoice" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Description/)).toHaveValue("Old description");
    expect(screen.getByLabelText(/^Amount/)).toHaveValue("10");
    expect(document.getElementById("edit-inv-asset") as HTMLInputElement).toHaveValue("XLM");
    expect(screen.getByLabelText(/Due date/)).toHaveValue("2026-12-01");
    expect(screen.getByLabelText(/Reference/)).toHaveValue("REF-1");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("validates fields including non-XLM issuer", async () => {
    const user = userEvent.setup();
    renderModal(<EditInvoiceModal invoice={invoice} onClose={() => undefined} onSaved={() => undefined} />);
    await user.clear(screen.getByLabelText(/Description/));
    await user.clear(screen.getByLabelText(/^Amount/));
    await user.clear(document.getElementById("edit-inv-asset") as HTMLInputElement);
    await user.type(document.getElementById("edit-inv-asset") as HTMLInputElement, "USD");
    await user.clear(screen.getByLabelText(/Due date/));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Add a short description.")).toBeInTheDocument();
    expect(screen.getByText("Enter an amount greater than zero.")).toBeInTheDocument();
    expect(screen.getByText("Asset issuer is required for non-XLM assets.")).toBeInTheDocument();
    expect(screen.getByText("Choose a due date.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("saves changes including issuer/reference and reports success or failure", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    fetchMock.mockResolvedValue(response({ ...invoice, amount: "20" }));
    renderModal(<EditInvoiceModal invoice={invoice} onClose={() => undefined} onSaved={onSaved} />);
    fireEvent.change(document.getElementById("edit-inv-amount") as HTMLInputElement, { target: { value: "20" } });
    fireEvent.change(document.getElementById("edit-inv-asset") as HTMLInputElement, { target: { value: "usd" } });
    fireEvent.change(document.getElementById("edit-inv-issuer") as HTMLInputElement, { target: { value: "GISSUER" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...invoice, amount: "20" }), { timeout: 15000 });
    expect(screen.getByText("Invoice updated")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/invoices/inv-1");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.asset_code).toBe("USD");
    expect(body.asset_issuer).toBe("GISSUER");

    fetchMock.mockResolvedValue(response({ detail: "Locked" }, 409));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Could not save changes")).toBeInTheDocument();
  });
});

describe("EditAgreementModal", () => {
  it("renders prefilled fields and handles an invalid date default", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderModal(
      <EditAgreementModal
        agreement={{ ...agreement, expiry_date: "not-a-date", conditions: null }}
        onClose={onClose}
        onSaved={() => undefined}
      />,
    );
    expect(screen.getByRole("heading", { name: "Edit agreement" })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Title/)).toHaveValue("Website build");
    expect(screen.getByLabelText(/Expiry date/)).toHaveValue("");
    expect(screen.getByLabelText(/Conditions/)).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("validates title, asset code, dates and JSON fields", async () => {
    const user = userEvent.setup();
    renderModal(<EditAgreementModal agreement={agreement} onClose={() => undefined} onSaved={() => undefined} />);
    await user.clear(screen.getByLabelText(/^Title/));
    await user.type(screen.getByLabelText(/^Title/), "ab");
    fireEvent.change(document.getElementById("edit-ag-asset") as HTMLInputElement, { target: { value: "BAD CODE" } });
    await user.clear(screen.getByLabelText(/Expiry date/));
    fireEvent.change(screen.getByLabelText(/Conditions/), { target: { value: "{bad json" } });
    fireEvent.change(screen.getByLabelText(/Approval requirements/), { target: { value: "[]" } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Give the agreement a title.")).toBeInTheDocument();
    expect(screen.getByText("Use 1–12 letters or digits.")).toBeInTheDocument();
    expect(screen.getByText("Choose an expiry date.")).toBeInTheDocument();
    expect(screen.getByText('Enter valid JSON, for example: {"key": "value"}.')).toBeInTheDocument();
    expect(screen.getByText(/Enter a JSON object/)).toBeInTheDocument();
  }, { timeout: 15000 });

  it("saves JSON fields and reports errors", async () => {
    const onSaved = vi.fn();
    fetchMock.mockResolvedValue(response({ ...agreement, title: "New title" }));
    renderModal(<EditAgreementModal agreement={agreement} onClose={() => undefined} onSaved={onSaved} />);
    fireEvent.change(document.getElementById("edit-ag-title") as HTMLInputElement, { target: { value: "New title" } });
    fireEvent.change(document.getElementById("edit-ag-approval") as HTMLTextAreaElement, { target: { value: '{"approver": "finance"}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ ...agreement, title: "New title" }), { timeout: 15000 });
    expect(screen.getByText("Agreement updated")).toBeInTheDocument();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.conditions).toEqual({ delivery: "on receipt" });
    expect(body.approval_requirements).toEqual({ approver: "finance" });

    fetchMock.mockResolvedValue(response({ detail: "Locked" }, 409));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Could not save changes")).toBeInTheDocument();
  });

  it("requires an issuer for non-XLM assets", async () => {
    const user = userEvent.setup();
    renderModal(<EditAgreementModal agreement={agreement} onClose={() => undefined} onSaved={() => undefined} />);
    fireEvent.change(document.getElementById("edit-ag-asset") as HTMLInputElement, { target: { value: "USDC" } });
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Asset issuer is required for non-XLM assets.")).toBeInTheDocument();
  });
});
