"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";
import { ArrowLeft, FileText, Info, Plus, Trash2 } from "lucide-react";
import { FormField } from "@/components/FormField";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { useToast } from "@/components/ToastProvider";
import { api, getErrorMessage } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
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
}).superRefine((values, context) => {
  if (values.asset_code.trim().toUpperCase() !== "XLM" && !values.asset_issuer?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["asset_issuer"],
      message: "Asset issuer is required for non-XLM assets.",
    });
  }
});

type FormValues = z.infer<typeof schema>;

function fieldClass(hasError?: boolean): string {
  return `ui-input ${hasError ? "border-rose-300 focus:border-rose-500" : ""}`;
}

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
  const watched = useWatch({ control }) as Partial<FormValues>;
  const lineItems = watched.items || [];
  const lineTotal = lineItems.reduce((sum, item) => {
    const quantity = Number(item?.quantity) || 0;
    const price = Number(item?.unit_price) || 0;
    return sum + quantity * price;
  }, 0);
  const enteredAmount = Number(watched.amount) || 0;
  const amountMismatch = lineItems.length > 0 && Math.abs(lineTotal - enteredAmount) > 0.0000001;
  const selectedSupplier = suppliers.find((supplier) => supplier.id === watched.supplier_id);
  const asset = (watched.asset_code || "XLM").toUpperCase();

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
      <Link href="/invoices" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-ink-400 transition-colors hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Back to invoices
      </Link>
      <PageHeader eyebrow="Operations" title="New invoice" description="Create an invoice for a supplier. Amounts are stored as decimal strings to preserve precision." />

      <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="grid gap-5 lg:grid-cols-[1.6fr_1fr]" noValidate>
        <div className="space-y-5">
          <SectionCard title="Invoice details" description="Supplier, amount and settlement terms">
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField id="supplier" label="Supplier" error={errors.supplier_id?.message} required className="sm:col-span-2">
                <select id="supplier" className={fieldClass(!!errors.supplier_id)} {...register("supplier_id")}>
                  <option value="">{suppliersLoading ? "Loading suppliers…" : "Select a supplier"}</option>
                  {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}</option>)}
                </select>
              </FormField>
              <FormField id="description" label="Description" error={errors.description?.message} required className="sm:col-span-2">
                <input id="description" className={fieldClass(!!errors.description)} placeholder="Consulting services — September" {...register("description")} />
              </FormField>
              <FormField id="amount" label="Amount" error={errors.amount?.message} hint="Up to 7 decimal places" required>
                <input id="amount" inputMode="decimal" className={fieldClass(!!errors.amount)} placeholder="1250.50" {...register("amount")} />
              </FormField>
              <FormField id="asset_code" label="Asset" error={errors.asset_code?.message} required>
                <input id="asset_code" maxLength={12} className={`${fieldClass(!!errors.asset_code)} uppercase`} {...register("asset_code")} />
              </FormField>
              <FormField id="asset_issuer" label="Asset issuer" error={errors.asset_issuer?.message} hint="Required for non-XLM assets; leave blank for native XLM" className="sm:col-span-2">
                <input id="asset_issuer" className={fieldClass(!!errors.asset_issuer)} placeholder="G…" {...register("asset_issuer")} />
              </FormField>
              <FormField id="due_date" label="Due date" error={errors.due_date?.message} required>
                <input id="due_date" type="date" className={fieldClass(!!errors.due_date)} {...register("due_date")} />
              </FormField>
              <FormField id="reference" label="Reference" error={errors.reference?.message} hint="Optional PO or contract reference" className="sm:col-span-2">
                <input id="reference" className={fieldClass(!!errors.reference)} placeholder="PO-2026-118" {...register("reference")} />
              </FormField>
            </div>
          </SectionCard>

          <SectionCard
            title="Line items"
            description="Optional breakdown shown on the invoice PDF"
            actions={
              <button
                type="button"
                onClick={() => append({ description: "", quantity: 1, unit_price: "" })}
                className="ui-btn-secondary min-h-[36px] px-3 py-1.5 text-xs"
              >
                <Plus className="h-3.5 w-3.5" /> Add line
              </button>
            }
          >
            {fields.length ? (
              <div className="space-y-3">
                {fields.map((item, index) => (
                  <div key={item.id} className="grid gap-2 rounded-card border border-line bg-slate-50/60 p-3 sm:grid-cols-[1fr_88px_120px_36px]">
                    <input aria-label={`Line ${index + 1} description`} placeholder="Description" className={fieldClass(!!errors.items?.[index]?.description)} {...register(`items.${index}.description`)} />
                    <input aria-label={`Line ${index + 1} quantity`} type="number" step="any" min="0" className={fieldClass(!!errors.items?.[index]?.quantity)} {...register(`items.${index}.quantity`)} />
                    <input aria-label={`Line ${index + 1} unit price`} inputMode="decimal" className={fieldClass(!!errors.items?.[index]?.unit_price)} placeholder="Unit price" {...register(`items.${index}.unit_price`)} />
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      className="flex h-9 w-9 items-center justify-center rounded-control text-ink-400 transition-colors hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                      aria-label={`Remove line ${index + 1}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                    {errors.items?.[index] ? (
                      <p role="alert" className="text-xs font-medium text-rose-600 sm:col-span-4">
                        {errors.items[index]?.description?.message || errors.items[index]?.quantity?.message || errors.items[index]?.unit_price?.message}
                      </p>
                    ) : null}
                  </div>
                ))}
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-accent-100 bg-accent-50 px-4 py-3">
                  <span className="ui-kicker text-accent-700">Line item total</span>
                  <div className="flex items-center gap-3">
                    <span className="font-display text-lg tabular-nums text-ink-900">{formatMoney(lineTotal, { decimals: 4 })}</span>
                    <button
                      type="button"
                      onClick={() => setValue("amount", lineTotal.toFixed(2), { shouldValidate: true })}
                      className="text-xs font-semibold text-accent-700 underline underline-offset-2"
                    >
                      Use as amount
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-card border border-dashed border-line px-4 py-6 text-center text-xs text-ink-400">
                No line items added. The invoice will show the total amount only.
              </div>
            )}
          </SectionCard>
        </div>

        <aside className="space-y-5">
          <SectionCard title="Review before creating" description="Values are read from the form as you type">
            <dl className="space-y-4 text-sm">
              <div>
                <dt className="ui-kicker">Supplier</dt>
                <dd className="mt-1 font-medium text-ink-900">{selectedSupplier?.business_name || "Not selected"}</dd>
              </div>
              <div>
                <dt className="ui-kicker">Description</dt>
                <dd className="mt-1 text-ink-700">{watched.description || "Not entered"}</dd>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <dt className="ui-kicker">Amount</dt>
                  <dd className="mt-1 whitespace-nowrap font-semibold tabular-nums text-ink-900">{formatMoney(watched.amount, { decimals: 4 })} <span className="text-xs font-medium text-ink-400">{asset}</span></dd>
                </div>
                <div>
                  <dt className="ui-kicker">Due date</dt>
                  <dd className="mt-1 text-ink-700">{formatDate(watched.due_date)}</dd>
                </div>
              </div>
              <div className="border-t border-line pt-4">
                <dt className="ui-kicker">Line items</dt>
                <dd className="mt-1 text-ink-700">{lineItems.length} item(s) · {formatMoney(lineTotal, { decimals: 4 })} total</dd>
              </div>
            </dl>
            {amountMismatch ? (
              <div className="mt-4 flex items-start gap-2 rounded-control border border-amber-200 bg-amber-50 px-3 py-2.5" role="status">
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" aria-hidden="true" />
                <p className="text-xs leading-relaxed text-amber-800">The invoice amount differs from the line item total. Check both values before creating.</p>
              </div>
            ) : null}
          </SectionCard>

          <div className="ui-card p-5">
            <p className="ui-kicker">What happens next</p>
            <ul className="mt-4 space-y-3 text-xs leading-relaxed text-ink-500">
              <li className="flex gap-2"><FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-600" aria-hidden="true" /> The invoice starts in draft. Submit it when you are ready for approval.</li>
              <li className="flex gap-2"><FileText className="mt-0.5 h-3.5 w-3.5 shrink-0 text-accent-600" aria-hidden="true" /> Payments are signed in Freighter and verified on-chain before the invoice is marked paid.</li>
            </ul>
            <button
              type="submit"
              disabled={submitting || !suppliers.length}
              className="ui-btn-accent mt-5 w-full"
            >
              {submitting ? "Creating…" : "Create invoice"}
            </button>
            {!suppliers.length && !suppliersLoading ? (
              <Link href="/suppliers" className="mt-3 block text-center text-xs font-semibold text-accent-700 hover:underline">Add a supplier first</Link>
            ) : null}
          </div>
        </aside>
      </form>
    </div>
  );
}
