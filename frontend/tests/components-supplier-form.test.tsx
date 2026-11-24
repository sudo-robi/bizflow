import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SupplierForm } from "../src/components/SupplierForm";

const VALID_KEY = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";

describe("SupplierForm", () => {
  it("renders all fields with default values and a custom prefix/label", () => {
    render(
      <SupplierForm
        idPrefix="edit"
        submitLabel="Update"
        defaultValues={{
          business_name: "Northwind",
          contact_name: "Jamie",
          email: "jamie@northwind.com",
          phone: "12345",
          wallet_address: VALID_KEY,
          country: "UK",
          notes: "Net 30",
        }}
        onCancel={() => undefined}
        onSubmit={() => undefined}
      />,
    );
    expect(screen.getByLabelText(/Business name/)).toHaveValue("Northwind");
    expect(screen.getByLabelText("Contact name")).toHaveValue("Jamie");
    expect(screen.getByLabelText("Contact email")).toHaveValue("jamie@northwind.com");
    expect(screen.getByLabelText(/Stellar public address/)).toHaveValue(VALID_KEY);
    expect(screen.getByLabelText("Phone")).toHaveValue("12345");
    expect(screen.getByLabelText("Country")).toHaveValue("UK");
    expect(screen.getByLabelText("Internal notes")).toHaveValue("Net 30");
    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Business name/)).toHaveAttribute("id", "edit-business_name");
  });

  it("submits trimmed values", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<SupplierForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/Business name/), "  Acme  ");
    await user.type(screen.getByLabelText(/Stellar public address/), VALID_KEY);
    await user.type(screen.getByLabelText("Contact email"), " finance@acme.com ");
    await user.type(screen.getByLabelText("Phone"), " 123 ");
    await user.type(screen.getByLabelText("Country"), " US ");
    await user.type(screen.getByLabelText("Internal notes"), " hello ");
    await user.click(screen.getByRole("button", { name: "Save supplier" }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        business_name: "Acme",
        contact_name: "",
        email: "finance@acme.com",
        phone: "123",
        wallet_address: VALID_KEY,
        country: "US",
        notes: "hello",
      }),
    );
  });

  it("shows validation errors for missing and invalid fields", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<SupplierForm onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText(/Business name/), "A");
    await user.type(screen.getByLabelText(/Stellar public address/), "GABC");
    await user.type(screen.getByLabelText("Contact email"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Save supplier" }));

    expect(await screen.findByText("Enter the supplier's business name.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter a valid Stellar public address (starts with G).")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables submit while submitting and fires cancel", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<SupplierForm submitting submitLabel="Saving…" onCancel={onCancel} onSubmit={() => undefined} />);
    const submit = screen.getByRole("button", { name: "Saving…" });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("renders without a cancel button", () => {
    render(<SupplierForm onSubmit={() => undefined} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });
});
