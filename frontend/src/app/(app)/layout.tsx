"use client";

import { useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Building2, Loader2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useAuth } from "@/app/providers";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { user, loading, activeBusinessId } = useAuth();

  useEffect(() => {
    if (!loading && !user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-[#F6F8FB]">
        <Loader2 className="h-6 w-6 animate-spin text-accent-600" aria-label="Loading workspace" />
        <p className="text-sm text-slate-500">Loading your workspace…</p>
      </div>
    );
  }

  if (!user) return null;

  if (!activeBusinessId) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F6F8FB] px-5">
        <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
          <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl bg-accent-50 text-accent-600">
            <Building2 className="h-6 w-6" />
          </span>
          <h1 className="mt-5 font-display text-2xl text-navy-900">Create a business workspace</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">
            Invoices, agreements and payments belong to a business. Set one up to continue.
          </p>
          <Link
            href="/onboarding"
            className="mt-6 inline-flex w-full items-center justify-center rounded-lg bg-accent-600 px-4 py-3 text-sm font-semibold text-white transition hover:bg-accent-700"
          >
            Set up my business
          </Link>
        </div>
      </div>
    );
  }

  return <AppShell>{children}</AppShell>;
}
