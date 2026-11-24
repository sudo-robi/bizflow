import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuth } from "@/app/providers";
import { useRouter } from "next/navigation";
import { ToastProvider } from "@/components/ToastProvider";
import LoginPage from "@/app/login/page";
import RegisterPage from "@/app/register/page";
import OnboardingPage from "@/app/onboarding/page";

vi.mock("next/navigation", () => ({ useRouter: vi.fn(), usePathname: vi.fn(), useParams: vi.fn() }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock("@/app/providers", () => ({ useAuth: vi.fn() }));

const refresh = vi.fn().mockResolvedValue(undefined);
const selectBusiness = vi.fn();
const push = vi.fn();
const replace = vi.fn();
const mockedUseAuth = vi.mocked(useAuth);
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

function renderPage(page: React.ReactElement) {
  return render(<ToastProvider>{page}</ToastProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  mockedUseAuth.mockReturnValue({
    user: { id: "u1", email: "alex@acme.com" },
    loading: false,
    refresh,
    selectBusiness,
    can: () => true,
  } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useRouter).mockReturnValue({ push, replace } as unknown as ReturnType<typeof useRouter>);
});

describe("LoginPage", () => {
  it("renders the form and validates required fields", async () => {
    const user = userEvent.setup();
    renderPage(<LoginPage />);
    expect(screen.getByRole("heading", { name: "Sign in to BizFlow" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs in, refreshes the session and navigates to the dashboard", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
    renderPage(<LoginPage />);
    await user.type(screen.getByLabelText(/Work email/), "alex@acme.com");
    await user.type(screen.getByLabelText(/Password/), "secret123");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getByText("Signed in")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/v1/auth/login");
    expect(fetchMock.mock.calls[0][1].headers.get("X-Business-ID")).toBeNull();
  });

  it("reports a failed sign-in without navigating", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Invalid credentials" }, 401));
    renderPage(<LoginPage />);
    await user.type(screen.getByLabelText(/Work email/), "alex@acme.com");
    await user.type(screen.getByLabelText(/Password/), "wrong");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText("Sign in failed")).toBeInTheDocument();
    expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });
});

describe("RegisterPage", () => {
  it("validates the form including matching passwords", async () => {
    const user = userEvent.setup();
    renderPage(<RegisterPage />);
    expect(screen.getByRole("heading", { name: "Create your account" })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Full name/), "A");
    await user.type(screen.getByLabelText(/Work email/), "bad-email");
    await user.type(screen.getByLabelText(/^Password/), "short");
    await user.type(screen.getByLabelText(/Confirm password/), "different");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(await screen.findByText("Enter your full name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid work email address.")).toBeInTheDocument();
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    expect(screen.getByText("Passwords do not match.")).toBeInTheDocument();
  });

  it("registers with an optional business and goes to the dashboard", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: "u1" }, business: { id: "b1" } }, 201));
    renderPage(<RegisterPage />);
    await user.type(screen.getByLabelText(/Full name/), "Alex Morgan");
    await user.type(screen.getByLabelText(/Work email/), "alex@acme.com");
    await user.type(screen.getByLabelText(/Business name/), "Acme Ltd");
    await user.type(screen.getByLabelText(/^Password/), "password123");
    await user.type(screen.getByLabelText(/Confirm password/), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(fetchMock.mock.calls[0][1].body).toContain("business_name");
    expect(screen.getByText("Welcome to BizFlow")).toBeInTheDocument();
  });

  it("routes to onboarding when no business was created", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ user: { id: "u1" } }, 201));
    renderPage(<RegisterPage />);
    await user.type(screen.getByLabelText(/Full name/), "Alex Morgan");
    await user.type(screen.getByLabelText(/Work email/), "alex@acme.com");
    await user.type(screen.getByLabelText(/^Password/), "password123");
    await user.type(screen.getByLabelText(/Confirm password/), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/onboarding"));
    expect(fetchMock.mock.calls[0][1].body).not.toContain("business_name");
  });

  it("shows a server error", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Email already registered" }, 409));
    renderPage(<RegisterPage />);
    await user.type(screen.getByLabelText(/Full name/), "Alex Morgan");
    await user.type(screen.getByLabelText(/Work email/), "alex@acme.com");
    await user.type(screen.getByLabelText(/^Password/), "password123");
    await user.type(screen.getByLabelText(/Confirm password/), "password123");
    await user.click(screen.getByRole("button", { name: "Create account" }));
    expect(await screen.findByText("Could not create your account")).toBeInTheDocument();
  });
});

describe("OnboardingPage", () => {
  it("shows a spinner while auth is loading", () => {
    mockedUseAuth.mockReturnValue({ loading: true, user: null } as unknown as ReturnType<typeof useAuth>);
    renderPage(<OnboardingPage />);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("redirects unauthenticated users to login", async () => {
    mockedUseAuth.mockReturnValue({ loading: false, user: null } as unknown as ReturnType<typeof useAuth>);
    renderPage(<OnboardingPage />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/login"));
  });

  it("creates a business, selects it and redirects", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ id: "b1", name: "Acme Ltd" }, 201));
    renderPage(<OnboardingPage />);
    await user.type(screen.getByLabelText(/Business name/), "Acme Ltd");
    await user.type(screen.getByLabelText(/Legal name/), "Acme Limited");
    await user.type(screen.getByLabelText(/Country/), "UK");
    await user.clear(screen.getByLabelText(/Reporting currency/));
    await user.type(screen.getByLabelText(/Reporting currency/), "GBP");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(selectBusiness).toHaveBeenCalledWith("b1");
    expect(screen.getByText("Business profile created")).toBeInTheDocument();
    expect(fetchMock.mock.calls[0][1].body).toContain('"currency":"GBP"');
  });

  it("validates the currency length and shows errors", async () => {
    const user = userEvent.setup();
    renderPage(<OnboardingPage />);
    await user.clear(screen.getByLabelText(/Reporting currency/));
    await user.type(screen.getByLabelText(/Reporting currency/), "US");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("Use a 3-letter currency code.")).toBeInTheDocument();
    expect(await screen.findByText("Enter your business name.")).toBeInTheDocument();
  });

  it("shows a creation error", async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(jsonResponse({ detail: "Nope" }, 400));
    renderPage(<OnboardingPage />);
    await user.type(screen.getByLabelText(/Business name/), "Acme Ltd");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(await screen.findByText("Could not create business")).toBeInTheDocument();
  });
});
