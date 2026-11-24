import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfirmModal } from "../src/components/ConfirmModal";
import { Modal } from "../src/components/Modal";
import { SignTransactionModal } from "../src/components/SignTransactionModal";
import type { TransactionDetails } from "../src/lib/types";

afterEach(() => {
  document.body.style.overflow = "";
});

const details: TransactionDetails = {
  source: "GSOURCEADDRESS",
  destination: "GDESTINATIONADDRESS",
  amount: "12.5",
  asset: "XLM",
  assetIssuer: null,
  memo: "invoice-1",
  fee: "0.00001",
  network: "Stellar Testnet",
  hash: "abc123",
  operationType: "payment",
};

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(<Modal open={false} onClose={() => undefined} title="Hidden"><p>Body</p></Modal>);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("renders the dialog with title, description, children and footer", () => {
    render(
      <Modal open onClose={() => undefined} title="Title" description="Description" footer={<button>Done</button>} size="lg">
        <p>Body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass("max-w-3xl");
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("Description")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("supports the small size and omits optional description/footer", () => {
    render(<Modal open onClose={() => undefined} title="Small"><p>Body</p></Modal>);
    expect(screen.getByRole("dialog")).toHaveClass("max-w-xl");
    expect(screen.queryByText("Description")).not.toBeInTheDocument();
  });

  it("closes on overlay click and on the close button", () => {
    const onClose = vi.fn();
    const { rerender } = render(<Modal open onClose={onClose} title="X"><p>Body</p></Modal>);
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(onClose).toHaveBeenCalledTimes(1);

    rerender(<Modal open onClose={onClose} title="X" size="sm"><p>Body</p></Modal>);
    expect(screen.getByRole("dialog")).toHaveClass("max-w-md");
    const overlay = document.querySelector(".absolute.inset-0");
    if (overlay) fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("closes on Escape and restores body overflow on unmount", () => {
    const onClose = vi.fn();
    const { unmount } = render(<Modal open onClose={onClose} title="X"><p>Body</p></Modal>);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("autofocuses the first focusable element after the delay and traps Tab", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(
      <Modal open onClose={onClose} title="Focus">
        <input aria-label="First" />
        <button type="button">Second</button>
      </Modal>,
    );
    const first = screen.getByLabelText("First");
    const second = screen.getByRole("button", { name: "Second" });
    const closeButton = screen.getByRole("button", { name: "Close dialog" });
    act(() => vi.advanceTimersByTime(40));
    expect(document.activeElement).toBe(closeButton);

    closeButton.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(second);

    second.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(closeButton);

    first.focus();
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(first);
    vi.useRealTimers();
  });

  it("does nothing on Tab when there are no focusable elements", () => {
    render(<Modal open onClose={() => undefined} title="Empty"><p>Just text</p></Modal>);
    expect(() => fireEvent.keyDown(document, { key: "Tab" })).not.toThrow();
  });
});

describe("ConfirmModal", () => {
  it("renders custom labels and danger tone and fires callbacks", async () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfirmModal open onClose={onClose} onConfirm={onConfirm} title="Delete" message="Are you sure?" confirmLabel="Delete it" cancelLabel="Keep" tone="danger" />,
    );
    expect(screen.getByRole("heading", { name: "Delete" })).toBeInTheDocument();
    expect(screen.getByText("Are you sure?")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "Delete it" });
    expect(confirm).toHaveClass("bg-rose-600");
    confirm.click();
    expect(onConfirm).toHaveBeenCalledOnce();
    screen.getByRole("button", { name: "Keep" }).click();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("uses the primary tone by default and disables both buttons while loading", () => {
    const onClose = vi.fn();
    const onConfirm = vi.fn();
    render(<ConfirmModal open onClose={onClose} onConfirm={onConfirm} title="Save" message="Continue?" loading />);
    expect(screen.getByRole("button", { name: "Working…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Working…" })).toHaveClass("bg-accent-600");
    fireEvent.click(screen.getByRole("button", { name: "Working…" }));
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe("SignTransactionModal", () => {
  it("shows a preparing state and disables approval without details", () => {
    const onApprove = vi.fn();
    render(<SignTransactionModal open details={null} onApprove={onApprove} onCancel={() => undefined} />);
    expect(screen.getByText("Preparing transaction details…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Approve & Sign/ })).toBeDisabled();
  });

  it("renders every transaction detail with native asset and hidden hash fallback", () => {
    render(<SignTransactionModal open details={details} onApprove={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText("12.5 XLM")).toBeInTheDocument();
    expect(screen.getByText("GSOURCEADDRESS")).toBeInTheDocument();
    expect(screen.getByText("GDESTINATIONADDRESS")).toBeInTheDocument();
    expect(screen.getByText("XLM (native)")).toBeInTheDocument();
    expect(screen.getByText("0.00001 XLM")).toBeInTheDocument();
    expect(screen.getByText("invoice-1")).toBeInTheDocument();
    expect(screen.getByText("payment")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByText(/You are authorising a real payment/)).toBeInTheDocument();
  });

  it("falls back to the Freighter hash notice when the hash is empty", () => {
    render(<SignTransactionModal open details={{ ...details, hash: "" }} onApprove={() => undefined} onCancel={() => undefined} />);
    expect(screen.getByText("Provided by Freighter before signing")).toBeInTheDocument();
  });

  it("truncates an issued asset issuer and shows the hash and error alert", () => {
    render(
      <SignTransactionModal
        open
        details={{ ...details, asset: "USDC", assetIssuer: "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR" }}
        error="Signature rejected"
        onApprove={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(screen.getByText("USDC (GCFIRY…YOJR)")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Signature rejected");
  });

  it("fires approve/cancel and reflects the busy stage", () => {
    const onApprove = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <SignTransactionModal open details={details} onApprove={onApprove} onCancel={onCancel} />,
    );
    screen.getByRole("button", { name: /Approve & Sign/ }).click();
    expect(onApprove).toHaveBeenCalledOnce();
    screen.getByRole("button", { name: "Cancel" }).click();
    expect(onCancel).toHaveBeenCalledOnce();

    rerender(<SignTransactionModal open details={details} busy stage="Signing…" onApprove={onApprove} onCancel={onCancel} />);
    const approve = screen.getByRole("button", { name: /Signing…/ });
    expect(approve).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
