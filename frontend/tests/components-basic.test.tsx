import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AuthCard } from "../src/components/AuthCard";
import { FieldError, FormField, inputClass, inputWithError } from "../src/components/FormField";
import { LoadingSkeleton, PageSkeleton, Skeleton } from "../src/components/LoadingSkeleton";
import { PageHeader, SectionCard } from "../src/components/PageHeader";
import { StatCard } from "../src/components/StatCard";
import { StatusBadge, toneForStatus } from "../src/components/StatusBadge";
import { EmptyState } from "../src/components/EmptyState";

describe("EmptyState", () => {
  it("renders the default icon, title and optional description/action", () => {
    render(<EmptyState title="No invoices" description="Add one to begin" action={<button>New</button>} />);
    expect(screen.getByText("No invoices")).toBeInTheDocument();
    expect(screen.getByText("Add one to begin")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("supports custom icons and compact spacing", () => {
    render(<EmptyState title="Empty" icon={<span data-testid="custom-icon" />} compact />);
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
    expect(screen.getByText("Empty").parentElement).toHaveClass("px-4", "py-10");
  });
});

describe("LoadingSkeleton", () => {
  it("renders a bare skeleton with default and custom classes", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveClass("bg-slate-100", "overflow-hidden");
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.querySelector(".animate-shimmer")).toBeInTheDocument();
    const { container: custom } = render(<Skeleton className="h-4 w-8" />);
    expect(custom.querySelector(".h-4.w-8")).toBeInTheDocument();
  });

  it("caps LoadingSkeleton columns at four and renders the requested rows", () => {
    render(<LoadingSkeleton rows={2} columns={8} />);
    expect(screen.getByRole("status", { name: "Loading data" })).toBeInTheDocument();
    expect(document.querySelectorAll(".rounded-xl.border.border-slate-100.bg-white.p-5.shadow-card")).toHaveLength(4);
    expect(document.querySelectorAll(".flex.items-center.gap-4.px-6.py-4")).toHaveLength(2);
  });

  it("renders PageSkeleton with the page label", () => {
    render(<PageSkeleton />);
    expect(screen.getByRole("status", { name: "Loading page" })).toBeInTheDocument();
  });
});

describe("PageHeader / SectionCard", () => {
  it("renders all optional header parts", () => {
    render(
      <PageHeader eyebrow="Finance" title="Invoices" description="Manage bills" actions={<button>Create</button>} />,
    );
    expect(screen.getByText("Finance")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Invoices" })).toBeInTheDocument();
    expect(screen.getByText("Manage bills")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create" })).toBeInTheDocument();
  });

  it("renders a minimal header without optional parts", () => {
    render(<PageHeader title="Plain" />);
    expect(screen.getByRole("heading", { name: "Plain" })).toBeInTheDocument();
  });

  it("renders SectionCard with and without description/actions and a custom class", () => {
    const { rerender } = render(
      <SectionCard title="Card" description="Details" actions={<button>Act</button>} className="extra">
        Body
      </SectionCard>,
    );
    expect(screen.getByRole("heading", { name: "Card" })).toBeInTheDocument();
    expect(screen.getByText("Details")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Act" })).toBeInTheDocument();
    expect(screen.getByText("Card").closest("section")).toHaveClass("extra");
    rerender(<SectionCard title="Card">Body</SectionCard>);
    expect(screen.queryByText("Details")).not.toBeInTheDocument();
  });
});

describe("StatCard", () => {
  it("renders label, value, icon, hint and both trend directions", () => {
    const { rerender } = render(
      <StatCard label="Paid" value={42} icon={<span data-testid="icon" />} hint="this month" trend={{ value: "12%", direction: "up" }} accent="green" />,
    );
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByTestId("icon")).toBeInTheDocument();
    expect(screen.getByText("this month")).toBeInTheDocument();
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("42").previousElementSibling?.querySelector("[aria-hidden]")).toBeInTheDocument();

    rerender(<StatCard label="Due" value="5" trend={{ value: "3%", direction: "down" }} accent="amber" />);
    expect(screen.getByText("3%")).toBeInTheDocument();
    expect(screen.queryByTestId("icon")).not.toBeInTheDocument();
  });

  it("supports slate and blue accents without a trend", () => {
    const { rerender } = render(<StatCard label="A" value="1" accent="slate" />);
    rerender(<StatCard label="A" value="1" accent="blue" />);
    expect(screen.getByText("1")).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  it("maps all known statuses to their tones", () => {
    const expected: Record<string, string> = {
      draft: "bg-slate-100",
      pending: "bg-amber-50",
      partially_paid: "bg-accent-50",
      paid: "bg-emerald-50",
      overdue: "bg-rose-50",
      cancelled: "bg-slate-100",
      awaiting_acceptance: "bg-amber-50",
      active: "bg-accent-50",
      completed: "bg-emerald-50",
      disputed: "bg-rose-50",
      funded: "bg-violet-50",
      released: "bg-emerald-50",
      approved: "bg-emerald-50",
      confirmed: "bg-emerald-50",
      successful: "bg-emerald-50",
      failed: "bg-rose-50",
      rejected: "bg-rose-50",
      unconfirmed: "bg-amber-50",
      processing: "bg-accent-50",
      verifying: "bg-accent-50",
      submitted: "bg-accent-50",
      archived: "bg-slate-100",
      invited: "bg-amber-50",
      suspended: "bg-rose-50",
      unread: "bg-accent-50",
      read: "bg-slate-100",
    };
    for (const [status, tone] of Object.entries(expected)) {
      expect(toneForStatus(status), status).toBe(
        ({ "bg-slate-100": "neutral", "bg-amber-50": "warning", "bg-accent-50": "info", "bg-emerald-50": "success", "bg-rose-50": "danger", "bg-violet-50": "purple" } as Record<string, string>)[tone],
      );
    }
    expect(toneForStatus("something_new")).toBe("neutral");
  });

  it("normalises status text, supports label overrides, no dot and custom classes", () => {
    render(<StatusBadge status="PARTIALLY-PAID" label="Partial" dot={false} className="custom" />);
    const badge = screen.getByText("Partial");
    expect(badge).toHaveClass("bg-accent-50", "custom");
    expect(badge.querySelector("[aria-hidden]")).toBeNull();

    const { rerender } = render(<StatusBadge status="weird_status" />);
    expect(screen.getByText("Weird Status")).toBeInTheDocument();
    rerender(<StatusBadge status="read" />);
    expect(screen.getByText("Read")).toBeInTheDocument();
  });
});

describe("FormField helpers", () => {
  it("renders required marker, error and hint variants", () => {
    const { rerender } = render(
      <FormField id="f" label="Field" required error="Required field" className="wide">
        <input id="f" />
      </FormField>,
    );
    expect(screen.getByText("Field").querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Required field");
    expect(screen.getByText("Field").parentElement).toHaveClass("wide");

    rerender(
      <FormField id="f" label="Field" hint="Helpful hint">
        <input id="f" />
      </FormField>,
    );
    expect(screen.getByText("Helpful hint")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("exposes input classes and FieldError behaviour", () => {
    expect(inputClass).toContain("focus:border-accent-600");
    expect(inputWithError()).toBe(inputClass);
    expect(inputWithError(true)).toContain("border-rose-300");
    const { container, rerender } = render(<FieldError id="x" />);
    expect(container.firstChild).toBeNull();
    rerender(<FieldError id="x" error="Bad" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Bad");
    expect(screen.getByRole("alert")).toHaveAttribute("id", "x-error");
  });
});

describe("AuthCard", () => {
  it("renders the marketing panel and auth form slot", () => {
    render(
      <AuthCard eyebrow="Sign in" title="Welcome back" description="Access your workspace" footer={<span>No account?</span>}>
        <form><input aria-label="Email" /></form>
      </AuthCard>,
    );
    expect(screen.getByText("Sign in")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
    expect(screen.getByText("Access your workspace")).toBeInTheDocument();
    expect(screen.getByText("No account?")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Email" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: /home|Back to home/i })).toHaveLength(2);
    expect(screen.getByText(/never sees your private keys/i)).toBeInTheDocument();
  });
});
