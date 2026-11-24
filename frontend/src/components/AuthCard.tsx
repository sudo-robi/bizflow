import Link from "next/link";
import { CircleDollarSign, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";

interface AuthCardProps {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
}

export function AuthCard({ eyebrow, title, description, children, footer }: AuthCardProps) {
  return (
    <div className="flex min-h-screen bg-white">
      <div className="relative hidden w-[44%] overflow-hidden bg-navy-900 p-12 text-white lg:flex lg:flex-col">
        <div className="absolute inset-0 grid-fade" aria-hidden="true" />
        <div className="absolute -bottom-40 -left-40 h-[32rem] w-[32rem] rounded-full bg-accent-600/20 blur-3xl" aria-hidden="true" />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent-600">
            <CircleDollarSign className="h-5 w-5" />
          </span>
          <span className="font-display text-xl tracking-tight">BizFlow</span>
        </div>
        <div className="relative my-auto max-w-md">
          <h2 className="font-display text-4xl leading-tight tracking-tight">The finance workspace for businesses that move on Stellar.</h2>
          <p className="mt-5 leading-relaxed text-slate-300">
            Invoices, supplier agreements and payments — with a clear approval trail and receipts your partners can verify.
          </p>
          <div className="mt-10 flex items-center gap-3 rounded-xl border border-white/10 bg-white/5 p-4">
            <ShieldCheck className="h-5 w-5 shrink-0 text-emerald-400" />
            <p className="text-xs leading-relaxed text-slate-300">
              Transactions are signed locally in Freighter. BizFlow never sees your private keys.
            </p>
          </div>
        </div>
        <p className="relative text-xs text-white/40">Stellar Testnet · No real funds involved</p>
      </div>

      <div className="flex flex-1 flex-col px-5 py-8 sm:px-10 lg:px-16">
        <div className="flex items-center justify-between lg:justify-end">
          <Link href="/" className="flex items-center gap-2 lg:hidden" aria-label="BizFlow home">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-navy-900 text-white">
              <CircleDollarSign className="h-5 w-5" />
            </span>
            <span className="font-display text-lg tracking-tight text-navy-900">BizFlow</span>
          </Link>
          <Link href="/" className="text-xs font-medium text-slate-500 transition hover:text-navy-900">
            Back to home
          </Link>
        </div>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-12">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent-600">{eyebrow}</p>
          <h1 className="mt-3 font-display text-3xl tracking-tight text-navy-900">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-500">{description}</p>
          <div className="mt-8">{children}</div>
          <div className="mt-8 border-t border-slate-100 pt-6 text-sm text-slate-600">{footer}</div>
        </div>
      </div>
    </div>
  );
}
