"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Building2, CircleDollarSign, Loader2 } from "lucide-react";
import { FormField, inputWithError } from "@/components/FormField";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";
import type { Business } from "@/lib/types";

const schema = z.object({
  name: z.string().trim().min(2, "Enter your business name."),
  legal_name: z.string().trim().max(160).optional().or(z.literal("")),
  country: z.string().trim().max(80).optional().or(z.literal("")),
  currency: z.string().trim().length(3, "Use a 3-letter currency code.").transform((value) => value.toUpperCase()),
});

type FormValues = z.infer<typeof schema>;

export default function OnboardingPage() {
  const router = useRouter();
  const toast = useToast();
  const { user, loading, refresh, selectBusiness } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", legal_name: "", country: "", currency: "USD" },
  });

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true);
    try {
      const business = await api.post<Business>("/businesses", values);
      await refresh();
      selectBusiness(business.id);
      toast.success("Business profile created", `${business.name} is now your active workspace.`);
      router.push("/dashboard");
    } catch (error) {
      toast.error("Could not create business", getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-accent-600" aria-label="Loading" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-line bg-white">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2" aria-label="BizFlow home">
            <span className="flex h-8 w-8 items-center justify-center rounded-control bg-navy-900 text-white">
              <CircleDollarSign className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="font-display text-lg tracking-tight text-ink-900">BizFlow</span>
          </Link>
          <span className="text-xs font-medium text-ink-400">Step 1 of 1 · Business profile</span>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-5 py-12 sm:px-8 sm:py-16">
        <div className="mx-auto max-w-2xl">
          <p className="ui-kicker text-accent-700">Almost there</p>
          <h1 className="mt-3 font-display text-3xl tracking-tight text-ink-900 sm:text-4xl">Tell us about your business</h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-400">
            This information appears on invoices and agreements. You can update it any time in Settings.
          </p>

          <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="ui-card mt-8 space-y-5 p-5 shadow-card sm:p-8" noValidate>
            <div className="flex items-center gap-3 rounded-control border border-accent-100 bg-accent-50 p-4">
              <Building2 className="h-5 w-5 shrink-0 text-accent-700" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-accent-700">
                All payments in this workspace are prepared on Stellar Testnet. No real funds are moved.
              </p>
            </div>
            <FormField id="name" label="Business name" error={errors.name?.message} required>
              <input id="name" className={inputWithError(!!errors.name)} placeholder="Acme Trading Ltd" aria-describedby={errors.name ? "name-error" : undefined} {...register("name")} />
            </FormField>
            <FormField id="legal_name" label="Legal name" error={errors.legal_name?.message} hint="Optional — used on formal documents.">
              <input id="legal_name" className={inputWithError(!!errors.legal_name)} placeholder="Acme Trading Limited" aria-describedby={errors.legal_name ? "legal_name-error" : "legal_name-hint"} {...register("legal_name")} />
            </FormField>
            <div className="grid gap-5 sm:grid-cols-2">
              <FormField id="country" label="Country" error={errors.country?.message}>
                <input id="country" className={inputWithError(!!errors.country)} placeholder="United Kingdom" aria-describedby={errors.country ? "country-error" : undefined} {...register("country")} />
              </FormField>
              <FormField id="currency" label="Reporting currency" error={errors.currency?.message} hint="3-letter ISO code">
                <input id="currency" maxLength={3} className={`${inputWithError(!!errors.currency)} uppercase`} placeholder="USD" aria-describedby={errors.currency ? "currency-error" : "currency-hint"} {...register("currency")} />
              </FormField>
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="ui-btn-accent min-h-11 w-full"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
              {submitting ? "Creating workspace…" : "Create workspace"}
            </button>
          </form>
        </div>
      </main>
    </div>
  );
}
