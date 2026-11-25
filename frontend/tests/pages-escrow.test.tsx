import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EscrowPage from "@/app/(app)/escrow/page";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function jsonResponse(json: unknown) {
  return {
    status: 200,
    ok: true,
    headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
    text: async () => JSON.stringify(json),
    json: async () => json,
  };
}

describe("Escrow page", () => {
  beforeEach(() => fetchMock.mockReset());

  it("renders real agreement funding state from the backend", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        items: [
          {
            id: "agreement-1",
            title: "Milestone deal",
            reference: "AGR-0001",
            status: "active",
            total_amount: "10.0000000",
            funded_amount: "4.0000000",
            milestones: [
              { id: "m1", status: "released", amount: "4.0000000" },
              { id: "m2", status: "pending", amount: "6.0000000" },
            ],
          },
        ],
        total: 1,
      }),
    );

    render(<EscrowPage />);
    expect(await screen.findByText("Milestone deal")).toBeInTheDocument();
    expect(screen.getByText("AGR-0001")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getAllByText("Funded").length).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/agreements"), expect.anything());
  });

  it("shows an honest empty state when no agreements exist", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ items: [], total: 0 }));
    render(<EscrowPage />);
    expect(await screen.findByText("No agreements yet")).toBeInTheDocument();
  });
});
