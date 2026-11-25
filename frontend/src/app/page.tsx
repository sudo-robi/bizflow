import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  CircleDollarSign,
  FileCheck2,
  FileText,
  Handshake,
  LockKeyhole,
  ReceiptText,
  ShieldCheck,
  Wallet,
} from "lucide-react";

const features = [
  {
    icon: FileText,
    title: "Invoices that settle themselves",
    body: "Create branded invoices, track payment status in real time and reconcile automatically against confirmed Stellar transactions.",
  },
  {
    icon: Handshake,
    title: "Milestone agreements",
    body: "Define scoped deliverables, fund them into escrow and release each milestone only when the agreed conditions are met.",
  },
  {
    icon: ShieldCheck,
    title: "Approval with real oversight",
    body: "Every outgoing payment is prepared server-side, shown in full, and signed locally in your wallet — never in a browser form.",
  },
  {
    icon: ReceiptText,
    title: "Verifiable receipts",
    body: "Share a public receipt for any confirmed payment. Independent verification means your counterparties don't have to take your word for it.",
  },
];

const steps = [
  { number: "01", title: "Set up your workspace", body: "Register your business, invite finance teammates and add supplier wallet addresses." },
  { number: "02", title: "Create and send", body: "Issue invoices or fund a milestone agreement with clear terms and due dates." },
  { number: "03", title: "Review and sign", body: "Approvers see the full transaction before signing in Freighter. Nothing leaves without a human decision." },
  { number: "04", title: "Track to settlement", body: "Watch confirmations, download receipts and export reports — all reconciled against the ledger." },
];

const assurances = [
  { icon: Wallet, label: "Wallet connection", value: "Freighter" },
  { icon: Building2, label: "Network", value: "Testnet only" },
  { icon: FileCheck2, label: "Approvals", value: "Human-in-the-loop" },
  { icon: ShieldCheck, label: "Verification", value: "On-chain" },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-40 border-b border-line bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-5 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2" aria-label="BizFlow home">
            <span className="flex h-8 w-8 items-center justify-center rounded-control bg-navy-900 text-white">
              <CircleDollarSign className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="font-display text-xl tracking-tight text-ink-900">BizFlow</span>
          </Link>
          <nav className="hidden items-center gap-8 text-sm font-medium text-ink-500 md:flex" aria-label="Primary">
            <a href="#features" className="transition-colors duration-150 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500">Platform</a>
            <a href="#how" className="transition-colors duration-150 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500">How it works</a>
            <a href="#security" className="transition-colors duration-150 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500">Security</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link href="/login" className="ui-btn-ghost min-h-9 text-navy-900">Sign in</Link>
            <Link href="/register" className="ui-btn-accent min-h-9 transition-all duration-200 ease-spring hover:-translate-y-0.5">Get started</Link>
          </div>
        </div>
      </header>

      <main>
        <section className="relative overflow-hidden bg-navy-950 text-white">
          <div className="absolute inset-0 grid-fade" aria-hidden="true" />
          <div className="absolute -right-40 -top-56 h-[36rem] w-[36rem] rounded-full bg-accent-600/20 blur-3xl" aria-hidden="true" />
          <div className="relative mx-auto grid max-w-7xl gap-12 px-5 py-20 sm:px-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center lg:py-28">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-accent-100">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                Built on Stellar Testnet
              </span>
              <h1 className="mt-7 max-w-2xl text-balance font-display text-[42px] leading-[1.08] tracking-tight sm:text-6xl">
                Business payments, with the receipts to prove it.
              </h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-slate-300 sm:text-lg">
                BizFlow brings invoices, supplier agreements and treasury approvals into one calm workspace — with every payment
                independently verifiable on the Stellar network.
              </p>
              <div className="mt-9 flex flex-wrap gap-3">
                <Link href="/register" className="ui-btn-accent min-h-11 px-5 transition-all duration-200 ease-spring hover:-translate-y-0.5">
                  Start your workspace <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
                <Link href="/login" className="ui-btn-secondary min-h-11 border-white/20 bg-transparent px-5 text-white hover:bg-white/10 hover:text-white">
                  Sign in to your account
                </Link>
              </div>
              <div className="mt-12 flex flex-wrap gap-x-8 gap-y-4 border-t border-white/10 pt-6 text-xs text-slate-400">
                <span className="flex items-center gap-2"><LockKeyhole className="h-4 w-4 text-accent-200" aria-hidden="true" /> Local wallet signing</span>
                <span className="flex items-center gap-2"><BadgeCheck className="h-4 w-4 text-accent-200" aria-hidden="true" /> Ledger-verified settlement</span>
                <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-accent-200" aria-hidden="true" /> Role-based approvals</span>
              </div>
            </div>

            <div className="relative">
              <div className="relative rounded-card border border-white/10 bg-white/[0.06] p-3 shadow-raised backdrop-blur-sm">
                <div className="rounded-card bg-white p-5 text-ink-900 shadow-inner">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-2xs font-semibold uppercase tracking-widest text-ink-400">Invoice INV-2026-0142</p>
                      <p className="mt-1 font-display text-xl">Northwind Logistics</p>
                    </div>
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">Paid</span>
                  </div>
                  <div className="mt-6 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-5">
                    <div>
                      <p className="text-xs text-ink-400">Amount settled</p>
                      <p className="mt-1 font-display text-3xl">12,450.00 <span className="text-base text-ink-400">XLM</span></p>
                    </div>
                    <p className="text-xs text-ink-400">Due 14 Nov 2026</p>
                  </div>
                  <div className="mt-5 space-y-3">
                    {[
                      ["Invoice approved", "Today · 09:14"],
                      ["Signed in Freighter", "Today · 09:16"],
                      ["Confirmed on Testnet", "Today · 09:16"],
                    ].map(([label, time], index) => (
                      <div key={label} className="flex items-center gap-3">
                        <span className={`flex h-6 w-6 items-center justify-center rounded-full ${index === 2 ? "bg-emerald-500 text-white" : "bg-accent-100 text-accent-700"}`} aria-hidden="true">
                          <BadgeCheck className="h-3.5 w-3.5" />
                        </span>
                        <span className="flex-1 text-sm font-medium">{label}</span>
                        <span className="text-xs text-ink-400">{time}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-5 rounded-control bg-canvas px-4 py-3">
                    <p className="text-2xs uppercase tracking-wider text-ink-400">Verified transaction</p>
                    <p className="mt-1 truncate font-mono text-xs text-ink-500">GA7F…Q4KM · ledger 1293841</p>
                  </div>
                </div>
              </div>
              <div className="absolute -bottom-5 -left-5 hidden rounded-control border border-white/10 bg-navy-900/95 px-4 py-3 shadow-xl backdrop-blur sm:block">
                <p className="text-2xs uppercase tracking-wider text-slate-400">Network</p>
                <p className="mt-1 flex items-center gap-2 text-sm font-semibold"><span className="h-2 w-2 rounded-full bg-emerald-400" /> TESTNET · SAMPLE DATA</p>
              </div>
              <p className="mt-8 text-center text-xs text-slate-300/70">
                Illustrative interface preview — the figures above are examples, not live account data.
              </p>
            </div>
          </div>
        </section>

        <section id="features" className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24">
          <div className="max-w-2xl">
            <p className="ui-kicker text-accent-700">The platform</p>
            <h2 className="mt-3 font-display text-3xl tracking-tight text-ink-900 sm:text-4xl">Everything finance needs. Nothing it doesn&apos;t.</h2>
            <p className="mt-4 text-base leading-relaxed text-ink-500">
              Purpose-built workflows for supplier payments — not a crypto dashboard with a logo swapped in.
            </p>
          </div>
          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {features.map((feature) => {
              const Icon = feature.icon;
              return (
                <article key={feature.title} className="ui-card p-6 transition-all duration-300 ease-spring hover:-translate-y-1 hover:border-accent-200 hover:shadow-raised">
                  <span className="flex h-10 w-10 items-center justify-center rounded-control bg-accent-50 text-accent-700">
                    <Icon className="h-5 w-5" aria-hidden="true" />
                  </span>
                  <h3 className="mt-5 text-base font-semibold text-ink-900">{feature.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">{feature.body}</p>
                </article>
              );
            })}
          </div>
        </section>

        <section id="how" className="border-y border-line bg-canvas">
          <div className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24">
            <div className="max-w-2xl">
              <p className="ui-kicker text-accent-700">How it works</p>
              <h2 className="mt-3 font-display text-3xl tracking-tight text-ink-900 sm:text-4xl">From invoice to ledger, in four clear steps.</h2>
            </div>
            <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-4">
              {steps.map((step) => (
                <article key={step.number} className="ui-card p-6">
                  <span className="font-display text-3xl text-accent-200">{step.number}</span>
                  <h3 className="mt-3 text-base font-semibold text-ink-900">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-ink-500">{step.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="security" className="mx-auto max-w-7xl px-5 py-20 sm:px-8 sm:py-24">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div>
              <p className="ui-kicker text-accent-700">Security by design</p>
              <h2 className="mt-3 font-display text-3xl tracking-tight text-ink-900 sm:text-4xl">Your keys stay with you. Always.</h2>
              <p className="mt-4 leading-relaxed text-ink-500">
                BizFlow prepares transactions on the server, but only your wallet can sign them. You review the amount, asset,
                destination, memo and fee before approving. We never ask for a seed phrase or private key.
              </p>
              <ul className="mt-7 space-y-3">
                {[
                  "httpOnly cookies for sessions — no tokens in browser storage",
                  "Testnet-only enforcement before every signature",
                  "Independent on-chain verification before an invoice is credited",
                  "Immutable audit trail for every privileged action",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm text-ink-800">
                    <BadgeCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              {assurances.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.label} className="ui-card p-5">
                    <Icon className="h-5 w-5 text-accent-700" aria-hidden="true" />
                    <p className="mt-4 text-xs text-ink-400">{item.label}</p>
                    <p className="mt-1 text-sm font-semibold text-ink-900">{item.value}</p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="bg-navy-900">
          <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-6 px-5 py-14 sm:px-8 md:flex-row md:items-center">
            <div>
              <h2 className="font-display text-3xl tracking-tight text-white">Ready to modernise supplier payments?</h2>
              <p className="mt-2 text-sm text-slate-300">Set up your workspace in minutes. No real funds required.</p>
            </div>
            <Link href="/register" className="ui-btn-accent min-h-11 px-6 transition-all duration-200 ease-spring hover:-translate-y-0.5">
              Create your workspace <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line bg-white">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-5 py-8 text-xs text-ink-400 sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>© {new Date().getFullYear()} BizFlow. Business payments on Stellar.</p>
          <p>Built for Testnet · Not a custodial service</p>
        </div>
      </footer>
    </div>
  );
}
