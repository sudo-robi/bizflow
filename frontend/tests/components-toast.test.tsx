import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "../src/components/ToastProvider";

afterEach(() => {
  vi.useRealTimers();
});

function Harness() {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.success("Saved", "All good")}>success</button>
      <button onClick={() => toast.error("Failed")}>error</button>
      <button onClick={() => toast.info("Info")}>info</button>
      <button onClick={() => toast.warning("Careful", "Check this")}>warning</button>
      <button onClick={() => Array.from({ length: 50 }, (_, i) => toast.dismiss(i + 1))}>dismiss-all-known</button>
    </div>
  );
}

describe("ToastProvider", () => {
  it("renders children and a live region", () => {
    render(<ToastProvider><span>Child</span></ToastProvider>);
    expect(screen.getByText("Child")).toBeInTheDocument();
    expect(document.querySelector('[aria-live="polite"]')).toBeInTheDocument();
  });

  it("throws when useToast is used outside a provider", () => {
    expect(() => render(<Harness />)).toThrow("useToast must be used inside ToastProvider");
  });

  it("pushes and auto-dismisses all four toast kinds", () => {
    vi.useFakeTimers();
    render(<ToastProvider><Harness /></ToastProvider>);

    for (const kind of ["success", "error", "info", "warning"]) {
      fireEvent.click(screen.getByRole("button", { name: kind }));
    }
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.getByText("All good")).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
    expect(screen.getByText("Info")).toBeInTheDocument();
    expect(screen.getByText("Careful")).toBeInTheDocument();
    expect(screen.getByText("Check this")).toBeInTheDocument();
    expect(screen.getAllByRole("status")).toHaveLength(4);

    act(() => vi.advanceTimersByTime(6000));
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });

  it("caps the visible toasts at four and dismisses manually", () => {
    vi.useFakeTimers();
    render(<ToastProvider><Harness /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "error" }));
    fireEvent.click(screen.getByRole("button", { name: "info" }));
    fireEvent.click(screen.getByRole("button", { name: "warning" }));
    fireEvent.click(screen.getByRole("button", { name: "success" }));
    fireEvent.click(screen.getByRole("button", { name: "error" }));
    expect(screen.getAllByRole("status")).toHaveLength(4);
    expect(screen.getAllByText("Failed")).toHaveLength(1);

    const firstDismiss = screen.getAllByRole("button", { name: "Dismiss notification" })[0];
    fireEvent.click(firstDismiss);
    expect(screen.getAllByRole("status")).toHaveLength(3);
  });

  it("dismisses by id via the context API", () => {
    render(<ToastProvider><Harness /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: "dismiss-all-known" }));
    expect(screen.queryAllByRole("status")).toHaveLength(0);
  });
});
