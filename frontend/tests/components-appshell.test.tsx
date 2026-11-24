import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../src/components/AppShell";
import { useAuth } from "../src/app/providers";
import { usePathname } from "next/navigation";

vi.mock("next/navigation", () => ({ usePathname: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));
vi.mock("../src/app/providers", () => ({ useAuth: vi.fn() }));

const mockedPathname = vi.mocked(usePathname);
const mockedUseAuth = vi.mocked(useAuth);
const selectBusiness = vi.fn();
const logout = vi.fn();

const authValue = {
  user: { id: "u1", email: "admin@acme.com", full_name: "Alex Morgan" },
  businesses: [
    { id: "b1", name: "Acme Ltd", role: "owner" },
    { id: "b2", name: "Beta Inc" },
  ],
  activeBusinessId: "b1",
  selectBusiness,
  logout,
  role: "admin",
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedPathname.mockReturnValue("/dashboard");
  mockedUseAuth.mockReturnValue(authValue as unknown as ReturnType<typeof useAuth>);
});

describe("AppShell", () => {
  it("renders navigation, workspace label and the active link", () => {
    render(<AppShell><p>Content</p></AppShell>);
    expect(screen.getByText("Content")).toBeInTheDocument();
    expect(screen.getAllByText("Dashboard").length).toBeGreaterThan(0);
    expect(screen.getByRole("navigation", { name: "Main navigation" })).toBeInTheDocument();
    const dashboard = screen.getByRole("link", { name: "Dashboard" });
    expect(dashboard).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Suppliers" })).not.toHaveAttribute("aria-current");
    expect(screen.getByText("Stellar Testnet")).toBeInTheDocument();
    expect(screen.getByText("AM")).toBeInTheDocument();
  });

  it("marks nested routes active and falls back to a generic workspace label", () => {
    mockedPathname.mockReturnValue("/invoices/123");
    render(<AppShell><p>Content</p></AppShell>);
    expect(screen.getAllByText("Invoices").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Invoices" })).toHaveAttribute("aria-current", "page");

    mockedPathname.mockReturnValue("/unknown");
    render(<AppShell><p>Other</p></AppShell>);
    expect(screen.getAllByText("Workspace").length).toBeGreaterThan(0);
  });

  it("opens and closes the mobile navigation", () => {
    render(<AppShell><p>Content</p></AppShell>);
    expect(screen.getAllByRole("button", { name: "Close navigation" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    expect(screen.getAllByRole("button", { name: "Close navigation" })).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: "Close navigation" })[0]);
    expect(screen.getAllByRole("button", { name: "Close navigation" })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    const overlay = document.querySelector(".fixed.inset-0.z-50 > .absolute");
    if (overlay) fireEvent.click(overlay);
    expect(screen.getAllByRole("button", { name: "Close navigation" })).toHaveLength(1);
  });

  it("opens the business switcher, lists businesses and selects one", () => {
    render(<AppShell><p>Content</p></AppShell>);
    const trigger = screen.getByRole("button", { name: /Acme Ltd/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const list = screen.getByRole("listbox");
    expect(list).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(options[0]).toHaveTextContent("owner");
    expect(options[1]).toHaveTextContent("admin");
    fireEvent.click(options[1]);
    expect(selectBusiness).toHaveBeenCalledWith("b2");
  });

  it("offers an onboarding link when there are no businesses", () => {
    mockedUseAuth.mockReturnValue({ ...authValue, businesses: [], activeBusinessId: null } as unknown as ReturnType<typeof useAuth>);
    render(<AppShell><p>Content</p></AppShell>);
    fireEvent.click(screen.getByRole("button", { name: /Select business/ }));
    expect(screen.getByRole("link", { name: "Create a business" })).toHaveAttribute("href", "/onboarding");
  });

  it("signs out and shows notification/avatar details", () => {
    render(<AppShell><p>Content</p></AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(logout).toHaveBeenCalledOnce();
    expect(screen.getAllByRole("link", { name: "Notifications" })[0]).toHaveAttribute("href", "/notifications");
    expect(screen.getByTitle("admin@acme.com")).toBeInTheDocument();
  });

  it("closes open menus when the pathname changes", () => {
    const { rerender } = render(<AppShell><p>Content</p></AppShell>);
    fireEvent.click(screen.getByRole("button", { name: "Open navigation" }));
    fireEvent.click(screen.getByRole("button", { name: /Acme Ltd/ }));
    expect(screen.getByRole("listbox")).toBeInTheDocument();

    mockedPathname.mockReturnValue("/reports");
    rerender(<AppShell><p>Content</p></AppShell>);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Close navigation" })).toHaveLength(1);
  });
});
