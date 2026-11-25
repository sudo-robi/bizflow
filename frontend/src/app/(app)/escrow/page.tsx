"use client";

import Link from "next/link";
import { ArrowUpRight, LockKeyhole, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/LoadingSkeleton";
import { api } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Agreement } from "@/lib/types";

export default function EscrowPage() {
  const { data, loading, error } = useApiResource<Agreement[]>(() => api.get("/agreements"));
  const agreements = Array.isArray(data)
    ? data
    : ((data as unknown as { items?: Agreement[] })?.items ?? []);

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Operations"
        title="Escrow"
        description="Funding, approval and release state for agreements held by the Soroban escrow contract."
      />

      <div className="mb-5 flex items-start gap-3 rounded-card border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-700">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          Funds move only after the real contract event is verified. Prepared transactions
          remain awaiting signature until they are submitted and confirmed on Testnet.
        </p>
      </div>

      {error ? <p className="ui-card p-4 text-sm text-rose-700">{error}</p> : null}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((key) => <Skeleton key={key} className="h-40 w-full" />)}
        </div>
      ) : agreements.length === 0 ? (
        <div className="ui-card">
          <EmptyState
            title="No agreements yet"
            description="Create an agreement with milestones to see its escrow state here."
            action={<Link href="/agreements/new" className="ui-btn-accent">New agreement</Link>}
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {agreements.map((agreement) => {
            const funded = Number(agreement.funded_amount ?? "0") > 0 || Boolean(agreement.fund_transaction_hash);
            const released = (agreement.milestones ?? []).filter((milestone) => milestone.status === "released").length;
            return (
              <section key={agreement.id} className="ui-card flex flex-col p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink-900">{agreement.title}</p>
                    <p className="mt-1 font-mono text-2xs text-ink-400">{agreement.reference || agreement.id.slice(0, 8)}</p>
                  </div>
                  <StatusBadge status={agreement.status} />
                </div>
                <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="ui-kicker">Agreement value</dt>
                    <dd className="mt-1 font-semibold text-ink-900">{formatMoney(agreement.total_amount, { decimals: 4 })}</dd>
                  </div>
                  <div>
                    <dt className="ui-kicker">Funded</dt>
                    <dd className="mt-1 font-semibold text-ink-900">{formatMoney(agreement.funded_amount ?? "0", { decimals: 4 })}</dd>
                  </div>
                  <div>
                    <dt className="ui-kicker">Milestones released</dt>
                    <dd className="mt-1 font-semibold text-ink-900">{released} / {agreement.milestones?.length ?? 0}</dd>
                  </div>
                  <div>
                    <dt className="ui-kicker">Escrow state</dt>
                    <dd className="mt-1 flex items-center gap-1.5 font-semibold text-ink-900">
                      <LockKeyhole className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
                      {funded ? "Funded" : "Not funded"}
                    </dd>
                  </div>
                </dl>
                <Link href={`/agreements/${agreement.id}`} className="ui-btn-ghost mt-5 self-start px-0 text-accent-700">
                  View escrow details <ArrowUpRight className="h-4 w-4" />
                </Link>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
