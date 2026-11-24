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

const milestoneSchema = z.object({
  description: z.string().trim().min(2, "Describe this milestone."),
  amount: z.string().trim().refine(isValidAmount, "Enter a valid amount."),
  due_date: z.string().optional().or(z.literal("")),
});

const schema = z.object({
  supplier_id: z.string().min(1, "Select a supplier."),
  title: z.string().trim().min(3, "Give the agreement a title."),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  total_amount: z.string().trim().refine(isValidAmount, "Enter a total greater than zero."),
  asset_code: z.string().trim().refine(isValidAssetCode, "Use 1–12 letters or digits."),
  asset_issuer: z.string().trim().optional().or(z.literal("")),
  expiry_date: z.string().min(1, "Choose an expiry date."),
  conditions: z.string().trim().max(2000).optional().or(z.literal("")),
  approval_requirements: z.string().trim().max(2000).optional().or(z.literal("")),
  milestones: z.array(milestoneSchema).min(1, "Add at least one milestone."),
}).superRefine((values, context) => {
  const total = Number(values.total_amount);
  const sum = values.milestones.reduce((acc, milestone) => acc + (Number(milestone.amount) || 0), 0);
  if (Math.abs(sum - total) > 0.0000001) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["total_amount"],
      message: `Milestone amounts total ${formatMoney(sum, { decimals: 4 })}, but the agreement total is ${formatMoney(total, { decimals: 4 })}.`,
    });
  }
});

type FormValues = z.infer<typeof schema>;

function unwrapSuppliers(value: unknown): Supplier[] {
  if (Array.isArray(value)) return value as Supplier[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) return (value as { items: Supplier[] }).items;
  return [];
}

export default function NewAgreementPage() {
  const router = useRouter();
  const toast = useToast();
  const [submitting, setSubmitting] = useState(false);
  const { data: supplierData } = useApiResource<unknown>(() => api.get("/suppliers?status=active&per_page=100"));
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
      supplier_id: "", title: "", description: "", total_amount: "", asset_code: "XLM",
      asset_issuer: "", expiry_date: "", conditions: "", approval_requirements: "",
      milestones: [{ description: "", amount: "", due_date: "" }],
    },
  });

  const { fields, append, remove } = useFieldArray({ control, name: "milestones" });
  const milestones = useWatch({ control, name: "milestones" });
  const milestoneTotal = (milestones || []).reduce((sum, milestone) => sum + (Number(milestone?.amount) || 0), 0);

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true);
    try {
      const result = await api.post<{ id: string }>("/agreements", {
        supplier_id: values.supplier_id,
        title: values.title,
        ...(values.description ? { description: values.description } : {}),
        total_amount: values.total_amount,
        asset_code: values.asset_code.toUpperCase(),
        ...(values.asset_issuer ? { asset_issuer: values.asset_issuer } : {}),
        expiry_date: new Date(values.expiry_date).toISOString(),
        ...(values.conditions ? { conditions: values.conditions } : {}),
        ...(values.approval_requirements ? { approval_requirements: values.approval_requirements } : {}),
        milestones: values.milestones.map((milestone) => ({
          description: milestone.description,
          amount: milestone.amount,
          ...(milestone.due_date ? { due_date: new Date(milestone.due_date).toISOString() } : {}),
        })),
      });
      toast.success("Agreement created", "Review it, then submit for supplier acceptance.");
      router.push(`/agreements/${result.id}`);
    } catch (reason) {
      toast.error("Could not create agreement", getErrorMessage(reason));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <Link href="/agreements" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-navy-900">
        <ArrowLeft className="h-4 w-4" /> Back to agreements
      </Link>
      <PageHeader eyebrow="Operations" title="New agreement" description="Define scoped milestones. Their amounts must add up to the agreement total." />

      <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="grid gap-5 lg:grid-cols-[1.6fr_1fr]" noValidate>
        <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <div className="grid gap-5 sm:grid-cols-2">
            <FormField id="ag-supplier" label="Supplier" error={errors.supplier_id?.message} required className="sm:col-span-2">
              <select id="ag-supplier" className={inputWithError(!!errors.supplier_id)} {...register("supplier_id")}>
                <option value="">Select a supplier</option>
                {suppliers.map((supplier) => <option key={supplier.id} value={supplier.id}>{supplier.business_name}</option>)}
              </select>
            </FormField>
            <FormField id="ag-title" label="Title" error={errors.title?.message} required className="sm:col-span-2">
              <input id="ag-title" className={inputWithError(!!errors.title)} placeholder="Website redesign — phase 1" {...register("title")} />
            </FormField>
            <FormField id="ag-description" label="Description" error={errors.description?.message} className="sm:col-span-2">
              <textarea id="ag-description" rows={3} className={inputWithError(!!errors.description)} placeholder="Scope and deliverables…" {...register("description")} />
            </FormField>
            <FormField id="ag-total" label="Total amount" error={errors.total_amount?.message} required>
              <input id="ag-total" inputMode="decimal" className={inputWithError(!!errors.total_amount)} placeholder="5000" {...register("total_amount")} />
            </FormField>
            <FormField id="ag-asset" label="Asset" error={errors.asset_code?.message} required>
              <input id="ag-asset" maxLength={12} className={`${inputWithError(!!errors.asset_code)} uppercase`} {...register("asset_code")} />
            </FormField>
            <FormField id="ag-issuer" label="Asset issuer" error={errors.asset_issuer?.message} hint="Leave blank for XLM" className="sm:col-span-2">
              <input id="ag-issuer" className={inputWithError(!!errors.asset_issuer)} placeholder="G… (optional)" {...register("asset_issuer")} />
            </FormField>
            <FormField id="ag-expiry" label="Expiry date" error={errors.expiry_date?.message} required className="sm:col-span-2">
              <input id="ag-expiry" type="date" className={inputWithError(!!errors.expiry_date)} {...register("expiry_date")} />
            </FormField>
            <FormField id="ag-conditions" label="Conditions" error={errors.conditions?.message} className="sm:col-span-2">
              <textarea id="ag-conditions" rows={2} className={inputWithError(!!errors.conditions)} placeholder="What must happen before each milestone is released…" {...register("conditions")} />
            </FormField>
            <FormField id="ag-approval" label="Approval requirements" error={errors.approval_requirements?.message} className="sm:col-span-2">
              <textarea id="ag-approval" rows={2} className={inputWithError(!!errors.approval_requirements)} placeholder="Who signs off on delivery…" {...register("approval_requirements")} />
            </FormField>
          </div>

          <div className="border-t border-slate-100 pt-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-navy-900">Milestones</h2>
                <p className="mt-0.5 text-xs text-slate-500">Each milestone is released separately from escrow.</p>
              </div>
              <button type="button" onClick={() => append({ description: "", amount: "", due_date: "" })} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-navy-900 hover:bg-slate-50">
                <Plus className="h-3.5 w-3.5" /> Add milestone
              </button>
            </div>

            <div className="mt-4 space-y-3">
              {fields.map((milestone, index) => (
                <div key={milestone.id} className="rounded-lg border border-slate-100 bg-slate-50/60 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-600">Milestone {index + 1}</span>
                    <button type="button" onClick={() => remove(index)} className="rounded-md p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label={`Remove milestone ${index + 1}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[1fr_120px_150px]">
                    <input aria-label={`Milestone ${index + 1} description`} placeholder="Description" className={inputWithError(!!errors.milestones?.[index]?.description)} {...register(`milestones.${index}.description`)} />
                    <input aria-label={`Milestone ${index + 1} amount`} inputMode="decimal" placeholder="Amount" className={inputWithError(!!errors.milestones?.[index]?.amount)} {...register(`milestones.${index}.amount`)} />
                    <input aria-label={`Milestone ${index + 1} due date`} type="date" className={inputWithError(!!errors.milestones?.[index]?.due_date)} {...register(`milestones.${index}.due_date`)} />
                  </div>
                  {errors.milestones?.[index] ? <p className="mt-1 text-xs text-rose-600">{errors.milestones[index]?.description?.message || errors.milestones[index]?.amount?.message}</p> : null}
                </div>
              ))}
              {errors.milestones?.root?.message ? <p className="text-xs text-rose-600">{errors.milestones.root.message}</p> : null}
            </div>

            <div className="mt-4 flex items-center justify-between rounded-lg bg-accent-50 px-4 py-3 text-sm">
              <span className="font-medium text-accent-700">Milestone total</span>
              <div className="flex items-center gap-3">
                <span className="font-display text-lg text-navy-900">{formatMoney(milestoneTotal, { decimals: 4 })}</span>
                <button type="button" onClick={() => setValue("total_amount", milestoneTotal.toFixed(2), { shouldValidate: true })} className="text-xs font-semibold text-accent-600 hover:underline">Use as total</button>
              </div>
            </div>
          </div>
        </div>

        <aside className="space-y-5">
          <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
            <h2 className="text-sm font-semibold text-navy-900">Agreement lifecycle</h2>
            <ol className="mt-4 space-y-3 text-xs leading-relaxed text-slate-600">
              <li><strong className="text-navy-900">1. Create</strong> — draft agreement with milestones.</li>
              <li><strong className="text-navy-900">2. Submit</strong> — supplier is asked to accept.</li>
              <li><strong className="text-navy-900">3. Fund</strong> — escrow is funded with a verified on-chain transaction.</li>
              <li><strong className="text-navy-900">4. Release</strong> — each milestone is signed and released as delivered.</li>
            </ol>
          </div>
          <button type="submit" disabled={submitting || !suppliers.length} className="inline-flex w-full items-center justify-center rounded-lg bg-accent-600 px-4 py-3 text-sm font-semibold text-white shadow-sm hover:bg-accent-700 disabled:opacity-60">
            {submitting ? "Creating…" : "Create agreement"}
          </button>
          {!suppliers.length ? <Link href="/suppliers" className="block text-center text-xs font-medium text-accent-600 hover:underline">Add a supplier first</Link> : null}
        </aside>
      </form>
    </div>
  );
}
