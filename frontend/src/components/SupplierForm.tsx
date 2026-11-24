"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { FormField, inputWithError } from "./FormField";
import { isValidEmail, isValidStellarPublicKey } from "@/lib/validators";
import type { Supplier } from "@/lib/types";

const schema = z.object({
  business_name: z.string().trim().min(2, "Enter the supplier's business name."),
  contact_name: z.string().trim().max(120).optional().or(z.literal("")),
  email: z.string().trim().refine((value) => !value || isValidEmail(value), "Enter a valid email address."),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  wallet_address: z.string().trim().refine(isValidStellarPublicKey, "Enter a valid Stellar public address (starts with G)."),
  country: z.string().trim().max(80).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
});

export type SupplierFormValues = z.infer<typeof schema>;

interface SupplierFormProps {
  idPrefix?: string;
  defaultValues?: Partial<Supplier>;
  submitting?: boolean;
  submitLabel?: string;
  onSubmit: (values: SupplierFormValues) => void | Promise<void>;
  onCancel?: () => void;
}

export function SupplierForm({
  idPrefix = "supplier",
  defaultValues,
  submitting = false,
  submitLabel = "Save supplier",
  onSubmit,
  onCancel,
}: SupplierFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SupplierFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      business_name: defaultValues?.business_name || "",
      contact_name: defaultValues?.contact_name || "",
      email: defaultValues?.email || "",
      phone: defaultValues?.phone || "",
      wallet_address: defaultValues?.wallet_address || "",
      country: defaultValues?.country || "",
      notes: defaultValues?.notes || "",
    },
  });

  const field = (name: string) => `${idPrefix}-${name}`;

  return (
    <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="space-y-4" noValidate>
      <FormField id={field("business_name")} label="Business name" error={errors.business_name?.message} required>
        <input id={field("business_name")} className={inputWithError(!!errors.business_name)} placeholder="Northwind Logistics" {...register("business_name")} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={field("contact_name")} label="Contact name" error={errors.contact_name?.message}>
          <input id={field("contact_name")} className={inputWithError(!!errors.contact_name)} placeholder="Jamie Lee" {...register("contact_name")} />
        </FormField>
        <FormField id={field("email")} label="Contact email" error={errors.email?.message}>
          <input id={field("email")} type="email" className={inputWithError(!!errors.email)} placeholder="jamie@northwind.com" {...register("email")} />
        </FormField>
      </div>
      <FormField id={field("wallet_address")} label="Stellar public address" error={errors.wallet_address?.message} hint="A G… address on Stellar Testnet. Never enter a secret key." required>
        <input id={field("wallet_address")} className={`${inputWithError(!!errors.wallet_address)} font-mono text-xs`} placeholder="GABC…XYZ" spellCheck={false} {...register("wallet_address")} />
      </FormField>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id={field("phone")} label="Phone" error={errors.phone?.message}>
          <input id={field("phone")} className={inputWithError(!!errors.phone)} placeholder="+44 20 7946 0958" {...register("phone")} />
        </FormField>
        <FormField id={field("country")} label="Country" error={errors.country?.message}>
          <input id={field("country")} className={inputWithError(!!errors.country)} placeholder="United Kingdom" {...register("country")} />
        </FormField>
      </div>
      <FormField id={field("notes")} label="Internal notes" error={errors.notes?.message} hint="Only visible to your team.">
        <textarea id={field("notes")} rows={3} className={inputWithError(!!errors.notes)} placeholder="Payment terms, preferred currency…" {...register("notes")} />
      </FormField>
      <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
        {onCancel ? (
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
        ) : null}
        <button
          type="submit"
          disabled={submitting}
          className="inline-flex items-center justify-center rounded-lg bg-accent-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-60"
        >
          {submitting ? "Saving…" : submitLabel}
        </button>
      </div>
    </form>
  );
}
