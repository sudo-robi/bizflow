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
          <Link href="/register" className="font-semibold text-accent-600 hover:text-accent-700">Create an account</Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit((values) => void onSubmit(values))} className="space-y-4" noValidate>
        <FormField id="email" label="Work email" error={errors.email?.message} required>
          <input id="email" type="email" autoComplete="email" className={inputWithError(!!errors.email)} placeholder="alex@company.com" {...register("email")} />
        </FormField>
        <FormField id="password" label="Password" error={errors.password?.message} required>
          <input id="password" type="password" autoComplete="current-password" className={inputWithError(!!errors.password)} placeholder="••••••••" {...register("password")} />
        </FormField>
        <button
          type="submit"
          disabled={submitting}
          className="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-accent-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all duration-200 ease-spring hover:bg-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:opacity-60"
        >
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          {submitting ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </AuthCard>
  );
}
