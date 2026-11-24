"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { FormField, inputWithError } from "@/components/FormField";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/components/ToastProvider";
import { api, getErrorMessage } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { isValidAmount, isValidAssetCode } from "@/lib/validators";
import { useApiResource } from "@/lib/useApiResource";
import type { Supplier } from "@/lib/types";

const itemSchema = z.object({
  description: z.string().trim().min(1, "Describe this line item."),
  quantity: z.coerce.number().positive("Quantity must be greater than zero."),
  unit_price: z.string().trim().refine(isValidAmount, "Enter a valid unit price."),
});

const schema = z.object({
  supplier_id: z.string().min(1, "Select a supplier."),
  description: z.string().trim().min(3, "Add a short description."),
  amount: z.string().trim().refine(isValidAmount, "Enter an amount greater than zero."),
  asset_code: z.string().trim().refine(isValidAssetCode, "Use 1–12 letters or digits."),
  asset_issuer: z.string().trim().optional().or(z.literal("")),
  due_date: z.string().min(1, "Choose a due date."),
  reference: z.string().trim().max(100).optional().or(z.literal("")),
  items: z.array(itemSchema),
});

type FormValues = z.infer<typeof schema>;

function unwrapSuppliers(value: unknown): Supplier[] {
  if (Array.isArray(value)) return value as Supplier[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) {
    return (value as { items: Supplier[] }).items;
  }
  return [];
}

export default function NewInvoicePage() {
  const router = useRouter();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const { data: supplierData, loading: suppliersLoading } = useApiResource<unknown>(() => api.get("/suppliers?status=active&per_page=100"));
  const suppliers = unwrapSuppliers(supplierData).filter((supplier) => supplier.status !== "archived");

  const {
    register,
    control,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      supplier_id: "",
      description: "",
      amount: "",
      asset_code: "XLM",
      asset_issuer: "",
      due_date: "",
      reference: "",
      items: [],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "items" });
  const watchedItems = useWatch({ control, name: "items" });
  const lineTotal = (watchedItems || []).reduce((sum, item) => {
    const quantity = Number(item?.quantity) || 0;
    const price = Number(item?.unit_price) || 0;
    return sum + quantity * price;
  }, 0);

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true);
    try {
      const result = await api.post<{ id: string }>("/invoices", {
        supplier_id: values.supplier_id,
        description: values.description,
        amount: values.amount,
        asset_code: values.asset_code.toUpperCase(),
        ...(values.asset_issuer ? { asset_issuer: values.asset_issuer } : {}),
        due_date: new Date(values.due_date).toISOString(),
        ...(values.reference ? { reference: values.reference } : {}),
        ...(values.items.length
          ? { items: values.items.map((item) => ({ description: item.description, quantity: Number(item.quantity), unit_price: item.unit_price })) }
          : {}),
      });
      toast.success("Invoice created", "You can submit it for payment from the invoice page.");
      router.push(`/invoices/${result.id}`);
    } catch (reason) {
      toast.error("Could not create invoice", getErrorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <Link href="/invoices" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-navy-900">
        <ArrowLeft className="h-4 w-4" /> Back to invoices
      </Link>
      <PageHeader eyebrow="Operations" title="New invoice" description="Create an invoice for a supplier. Amounts are stored as decimal strings to preserve precision." />

      <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="grid gap-5 lg:grid-cols-[1.6fr_1fr]" noValidate>
        <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField id="supplier" label="Supplier" error={errors.supplier_id?.message} required className="sm:col-span-2">
              <select id="supplier" className={inputWithError(!!errors.supplier_id)} {...register("supplier_id")}>
                <option value="">{suppliersLoading ? "Loading suppliers…" : "Select a supplier"}</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}</option>)}
              </select>
            </FormField>
            <FormField id="description" label="Description" error={errors.description?.message} required className="sm:col-span-2">
              <input id="description" className={inputWithError(!!errors.description)} placeholder="Consulting services — September" {...register("description")} />
            </FormField>
            <FormField id="amount" label="Amount" error={errors.amount?.message} hint="Up to 7 decimal places" required>
              <input id="amount" inputMode="decimal" className={inputWithError(!!errors.amount)} placeholder="1250.50" {...register("amount")} />
            </FormField>
            <FormField id="asset_code" label="Asset" error={errors.asset_code?.message} required>
              <input id="asset_code" maxLength={12} className={`${inputWithError(!!errors.asset_code)} uppercase`} {...register("asset_code")} />
            </FormField>
            <FormField id="asset_issuer" label="Asset issuer" error={errors.asset_issuer?.message} hint="Leave blank for native XLM">
              <input id="asset_issuer" className={inputWithError(!!errors.asset_issuer)} placeholder="G… (optional)" {...register("asset_issuer")} />
            </FormField>
            <FormField id="due_date" label="Due date" error={errors.due_date?.message} required>
              <input id="due_date" type="date" className={inputWithError(!!errors.due_date)} {...register("due_date")} />
            </FormField>
            <FormField id="reference" label="Reference" error={errors.reference?.message} hint="Optional PO or contract reference" className="sm:col-span-2">
              <input id="reference" className={inputWithError(!!errors.reference)} placeholder="PO-2026-118" {...register("reference")} />
            </FormField>
          </div>

          <div className="border-t border-slate-100 pt-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-navy-900">Line items</h2>
                <p className="mt-0.5 text-xs text-slate-500">Optional breakdown shown on the invoice PDF.</p>
              </div>
              <button
                type="button"
                onClick={() => append({ description: "", quantity: 1, unit_price: "" })}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-navy-900 hover:bg-slate-50"
              >
                <Plus className="h-3.5 w-3.5" /> Add line
              </button>
            </div>

            {fields.length ? (
              <div className="mt-4 space-y-3">
                {fields.map((item, index) => (
                  <div key={item.id} className="grid gap-2 rounded-lg border border-slate-100 bg-slate-50/60 p-3 sm:grid-cols-[1fr_80px_110px_32px]">
                    <input aria-label={`Line ${index + 1} description`} placeholder="Description" className={inputWithError(!!errors.items?.[index]?.description)} {...register(`items.${index}.description`)} />
                    <input aria-label={`Line ${index + 1} quantity`} type="number" step="any" min="0" className={inputWithError(!!errors.items?.[index]?.quantity)} {...register(`items.${index}.quantity`)} />
                    <input aria-label={`Line ${index + 1} unit price`} inputMode="decimal" className={inputWithError(!!errors.items?.[index]?.unit_price)} placeholder="Unit price" {...register(`items.${index}.unit_price`)} />
                    <button type="button" onClick={() => remove(index)} className="flex h-10 w-8 items-center justify-center rounded-md text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove line ${index + 1}`}>
                      <Trash2 className="h-4 w-4" />
                    </button>
                    {errors.items?.[index] ? <p className="text-xs text-rose-600 sm:col-span-4">{errors.items[index]?.description?.message || errors.items[index]?.quantity?.message || errors.items[index]?.unit_price?.message}</p> : null}
                  </div>
                ))}
                <div className="flex items-center justify-between rounded-lg bg-accent-50 px-4 py-3 text-sm">
                  <span className="font-medium text-accent-700">Line item total</span>
                  <div className="flex items-center gap-3">
                    <span className="font-display text-lg text-navy-900">{formatMoney(lineTotal, { decimals: 4 })}</span>
                    <button type="button" onClick={() => setValue("amount", lineTotal.toFixed(2), { shouldValidate: true })} className="text-xs font-semibold text-accent-600 hover:underline">Use as amount</button>
                  </div>
                </div>
              </div>
            ) : (
              <p className="mt-4 rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-xs text-slate-500">
                No line items added. The invoice will show the total amount only.
              </p>
            )}
          </div>
        </div>

        <aside className="space-y-5">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
            <h2 className="text-sm font-semibold text-navy-900">Before you create</h2>
            <ul className="mt-4 space-y-3 text-xs leading-relaxed text-slate-600">
              <li>• The invoice starts in <strong>draft</strong>. Submit it when you&apos;re ready for approval.</li>
              <li>• Supply a valid Stellar Testnet address when adding a supplier.</li>
              <li>• Payments are signed in Freighter and verified on-chain before this invoice is marked paid.</li>
            </ul>
          </div>
          <button
            type="submit"
            disabled={submitting || !suppliers.length}
            className="inline-flex w-full items-center justify-center rounded-lg bg-accent-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-60"
          >
            {submitting ? "Creating…" : "Create invoice"}
          </button>
          {!suppliers.length && !suppliersLoading ? (
            <Link href="/suppliers" className="block text-center text-xs font-medium text-accent-600 hover:underline">Add a supplier first</Link>
          ) : null}
        </aside>
      </form>
    </div>
  );
}
