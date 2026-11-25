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

/** Calm, secure auth shell: brand context on the left, focused form on the right. */
export function AuthCard({ eyebrow, title, description, children, footer }: AuthCardProps) {
  return (
    <div className="flex min-h-screen bg-canvas">
      <aside className="relative hidden w-[44%] overflow-hidden bg-navy-950 p-10 text-white lg:flex lg:flex-col xl:p-12">
        <div className="absolute inset-0 grid-fade" aria-hidden="true" />
        <div className="absolute -bottom-40 -left-40 h-[32rem] w-[32rem] rounded-full bg-accent-600/20 blur-3xl" aria-hidden="true" />
        <div className="relative flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-control bg-accent-600">
            <CircleDollarSign className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="font-display text-xl tracking-tight">BizFlow</span>
        </div>
        <div className="relative my-auto max-w-md">
          <p className="text-2xs font-semibold uppercase tracking-[0.18em] text-accent-200">Secure workspace access</p>
          <h2 className="mt-4 font-display text-4xl leading-tight tracking-tight">The finance workspace for businesses that move on Stellar.</h2>
          <p className="mt-5 leading-relaxed text-slate-300">
            Invoices, supplier agreements and payments — with a clear approval trail and receipts your partners can verify.
          </p>
          <div className="mt-10 flex items-center gap-3 rounded-card border border-white/10 bg-white/5 p-4">
            <ShieldCheck className="h-5 w-5 shrink-0 text-accent-200" aria-hidden="true" />
            <p className="text-xs leading-relaxed text-slate-300">
              Transactions are signed locally in Freighter. BizFlow never sees your private keys.
            </p>
          </div>
        </div>
        <p className="relative text-xs text-white/40">Stellar Testnet · No real funds involved</p>
      </aside>

      <main className="flex flex-1 flex-col px-5 py-8 sm:px-10 lg:px-16">
        <div className="flex items-center justify-between gap-4 lg:justify-end">
          <Link href="/" className="flex items-center gap-2 lg:hidden" aria-label="BizFlow home">
            <span className="flex h-8 w-8 items-center justify-center rounded-control bg-navy-900 text-white">
              <CircleDollarSign className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="font-display text-lg tracking-tight text-ink-900">BizFlow</span>
          </Link>
          <Link href="/" className="text-xs font-medium text-ink-400 transition-colors duration-150 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2">
            Back to home
          </Link>
        </div>
        <div className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center py-10 sm:py-12">
          <p className="ui-kicker text-accent-700">{eyebrow}</p>
          <h1 className="mt-3 font-display text-3xl tracking-tight text-ink-900">{title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-400">{description}</p>
          <div className="mt-8 ui-panel p-5 shadow-card sm:p-6">{children}</div>
          <div className="mt-6 border-t border-line pt-5 text-sm text-ink-500">{footer}</div>
        </div>
      </main>
    </div>
  );
}
