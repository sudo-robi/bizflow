"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormField, inputWithError } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import { useToast } from "@/components/ToastProvider";
import { api, getErrorMessage } from "@/lib/api";
import { isValidAmount, isValidAssetCode } from "@/lib/validators";
import type { Invoice } from "@/lib/types";

const schema = z.object({
  description: z.string().trim().min(1, "Add a short description."),
  amount: z.string().trim().refine(isValidAmount, "Enter an amount greater than zero."),
  asset_code: z.string().trim().refine(isValidAssetCode, "Use 1–12 letters or digits."),
  asset_issuer: z.string().trim().optional().or(z.literal("")),
  due_date: z.string().min(1, "Choose a due date."),
  reference: z.string().trim().max(100).optional().or(z.literal("")),
}).superRefine((values, context) => {
  if (values.asset_code.trim().toUpperCase() !== "XLM" && !values.asset_issuer?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["asset_issuer"], message: "Asset issuer is required for non-XLM assets." });
  }
});

type FormValues = z.infer<typeof schema>;

function dateValue(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

interface EditInvoiceModalProps {
  invoice: Invoice;
  onClose: () => void;
  onSaved: (invoice: Invoice) => void;
}

/** Edits only fields the backend accepts for draft/pending invoices via PATCH. */
export function EditInvoiceModal({ invoice, onClose, onSaved }: EditInvoiceModalProps) {
  const toast = useToast();
  const { register, handleSubmit, formState: { errors, isSubmitting } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      description: invoice.description || "",
      amount: invoice.amount,
      asset_code: invoice.asset_code || "XLM",
      asset_issuer: invoice.asset_issuer || "",
      due_date: dateValue(invoice.due_date),
      reference: invoice.reference || "",
    },
  });

  const onSubmit = async (values: FormValues) => {
    try {
      const updated = await api.patch<Invoice>(`/invoices/${invoice.id}`, {
        description: values.description,
        amount: values.amount,
        asset_code: values.asset_code.toUpperCase(),
        ...(values.asset_issuer?.trim() ? { asset_issuer: values.asset_issuer.trim() } : {}),
        due_date: new Date(values.due_date).toISOString(),
        ...(values.reference?.trim() ? { reference: values.reference.trim() } : {}),
      });
      onSaved(updated);
      toast.success("Invoice updated");
    } catch (reason) {
      toast.error("Could not save changes", getErrorMessage(reason));
    }
  };

  return (
    <Modal open onClose={onClose} title="Edit invoice" description="Only draft and pending invoices can be changed." size="md">
      <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="space-y-4" noValidate>
        <FormField id="edit-inv-description" label="Description" error={errors.description?.message} required>
          <input id="edit-inv-description" className={inputWithError(!!errors.description)} {...register("description")} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="edit-inv-amount" label="Amount" error={errors.amount?.message} required>
            <input id="edit-inv-amount" inputMode="decimal" className={inputWithError(!!errors.amount)} {...register("amount")} />
          </FormField>
          <FormField id="edit-inv-asset" label="Asset" error={errors.asset_code?.message} required>
            <input id="edit-inv-asset" maxLength={12} className={`${inputWithError(!!errors.asset_code)} uppercase`} {...register("asset_code")} />
          </FormField>
          <FormField id="edit-inv-issuer" label="Asset issuer" error={errors.asset_issuer?.message} hint="Leave blank for native XLM" className="sm:col-span-2">
            <input id="edit-inv-issuer" placeholder="G…" className={inputWithError(!!errors.asset_issuer)} {...register("asset_issuer")} />
          </FormField>
          <FormField id="edit-inv-due" label="Due date" error={errors.due_date?.message} required>
            <input id="edit-inv-due" type="date" className={inputWithError(!!errors.due_date)} {...register("due_date")} />
          </FormField>
          <FormField id="edit-inv-reference" label="Reference" error={errors.reference?.message}>
            <input id="edit-inv-reference" className={inputWithError(!!errors.reference)} {...register("reference")} />
          </FormField>
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <button type="button" onClick={onClose} className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="rounded-lg bg-accent-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-700 disabled:opacity-50">
            {isSubmitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
