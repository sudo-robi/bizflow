"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Loader2, LockKeyhole } from "lucide-react";
import { AuthCard } from "@/components/AuthCard";
import { FormField, inputWithError } from "@/components/FormField";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";

const schema = z.object({
  email: z.string().trim().email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
});

type FormValues = z.infer<typeof schema>;

export default function LoginPage() {
  const router = useRouter();
  const toast = useToast();
  const { refresh } = useAuth();
  const [submitting, setSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const onSubmit = async (values: FormValues) => {
    setSubmitting(true);
    try {
      await api.post("/auth/login", values, { public: true });
      await refresh();
      toast.success("Signed in", "Welcome back to BizFlow.");
      router.push("/dashboard");
    } catch (error) {
      toast.error("Sign in failed", getErrorMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthCard
      eyebrow="Welcome back"
      title="Sign in to BizFlow"
      description="Manage your supplier payments, invoices and agreements in one place."
      footer={
        <p>
          New to BizFlow?{" "}
          <Link href="/register" className="font-semibold text-accent-700 hover:text-accent-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2">Create an account</Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="space-y-4" noValidate>
        <FormField id="email" label="Work email" error={errors.email?.message} required>
          <input id="email" type="email" autoComplete="email" className={inputWithError(!!errors.email)} placeholder="alex@company.com" aria-describedby={errors.email ? "email-error" : undefined} {...register("email")} />
        </FormField>
        <FormField id="password" label="Password" error={errors.password?.message} required>
          <input id="password" type="password" autoComplete="current-password" className={inputWithError(!!errors.password)} placeholder="••••••••" aria-describedby={errors.password ? "password-error" : undefined} {...register("password")} />
        </FormField>
        <button
          type="submit"
          disabled={submitting}
          className="ui-btn-accent mt-2 min-h-11 w-full"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {submitting ? "Signing in…" : "Sign in"}
        </button>
        <p className="flex items-center justify-center gap-1.5 border-t border-line pt-4 text-xs text-ink-400">
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden="true" />
          Sessions are stored in httpOnly cookies, never in browser storage.
        </p>
      </form>
    </AuthCard>
  );
}
