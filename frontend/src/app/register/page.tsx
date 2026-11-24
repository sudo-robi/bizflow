"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2 } from "lucide-react";
import { AuthCard } from "@/components/AuthCard";
import { FormField, inputWithError } from "@/components/FormField";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";
import type { Business, User } from "@/lib/types";

const schema = z.object({
  full_name: z.string().trim().min(2, "Enter your full name."),
  email: z.string().trim().email("Enter a valid work email address."),
  business_name: z.string().trim().max(120).optional().or(z.literal("")),
  password: z.string().min(8, "Use at least 8 characters.").max(128),
  confirm: z.string(),
}).refine((data) => data.password === data.confirm, {
  message: "Passwords do not match.",
  path: ["confirm"],
});

type FormValues = z.infer<typeof schema>;

export default function RegisterPage() {
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { full_name: "", email: "", business_name: "", password: "", confirm: "" } });

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true);
    try {
      const result = await api.post<{ user: User; business?: Business }>(
        "/auth/register",
        {
          full_name: values.full_name,
          email: values.email,
          password: values.password,
          ...(values.business_name ? { business_name: values.business_name } : {}),
        },
        { public: true },
      );
      await refresh();
      toast.success("Welcome to BizFlow", "Your workspace is ready.");
      router.push(result.business ? "/dashboard" : "/onboarding");
    } catch (error) {
      toast.error("Could not create your account", getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      eyebrow="Get started"
      title="Create your account"
      description="Set up a workspace for your business. You can invite your finance team later."
      footer={
        <p>
          Already have an account?{" "}
          <Link href="/login" className="font-semibold text-accent-600 hover:text-accent-700">Sign in</Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="space-y-4" noValidate>
        <FormField id="full_name" label="Full name" error={errors.full_name?.message} required>
          <input id="full_name" autoComplete="name" className={inputWithError(!!errors.full_name)} placeholder="Alex Morgan" {...register("full_name")} />
        </FormField>
        <FormField id="email" label="Work email" error={errors.email?.message} required>
          <input id="email" type="email" autoComplete="email" className={inputWithError(!!errors.email)} placeholder="alex@company.com" {...register("email")} />
        </FormField>
        <FormField id="business_name" label="Business name" error={errors.business_name?.message} hint="Optional — you can add this after signing in.">
          <input id="business_name" autoComplete="organization" className={inputWithError(!!errors.business_name)} placeholder="Acme Trading Ltd" {...register("business_name")} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="password" label="Password" error={errors.password?.message} required>
            <input id="password" type="password" autoComplete="new-password" className={inputWithError(!!errors.password)} {...register("password")} />
          </FormField>
          <FormField id="confirm" label="Confirm password" error={errors.confirm?.message} required>
            <input id="confirm" type="password" autoComplete="new-password" className={inputWithError(!!errors.confirm)} {...register("confirm")} />
          </FormField>
        </div>
        <button
          type="submit"
          disabled={submitting}
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-200 ease-spring hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submitting ? "Creating account…" : "Create account"}
        </button>
        <p className="text-center text-xs leading-relaxed text-slate-400">
          By continuing you agree to use this platform only on Stellar Testnet.
        </p>
      </form>
    </AuthCard>
  );
}
