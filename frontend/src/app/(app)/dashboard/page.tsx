"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import {
  ArrowRight,
  Building2,
  CircleDollarSign,
  FileCheck2,
  FileText,
  Handshake,
  Inbox,
  Plus,
  ReceiptText,
  Wallet,
} from "lucide-react";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { Skeleton } from "@/components/LoadingSkeleton";
import { StatCard } from "@/components/StatCard";
import { StatusBadge } from "@/components/StatusBadge";
import { useApiResource } from "@/lib/useApiResource";
import { monthlyVolumeToActivity, reportHasData, useOutstanding } from "@/lib/useReportMetrics";
import { api } from "@/lib/api";
import { formatDate, formatMoney, formatNumber, truncateAddress } from "@/lib/format";
import type { BlockchainTransaction, DashboardReport, Invoice, Supplier } from "@/lib/types";

const ActivityChart = dynamic(() => import("@/components/ActivityChart"), {
  ssr: false,
  loading: () => <Skeleton className="h-64 w-full" />,
});

const columns: Column<BlockchainTransaction>[] = [
  {
    key: "hash",
    header: "Transaction",
    render: (row) => (
      <Link href={`/transactions/${encodeURIComponent(row.hash)}`} className="font-mono text-xs font-medium text-accent-700 hover:underline">
        {truncateAddress(row.hash, 10, 8)}
      </Link>
    ),
  },
  {
    key: "amount",
    header: "Amount",
    render: (row) => <span className="font-semibold text-ink-900">{row.amount ? `${formatMoney(row.amount, { decimals: 4 })} ${row.asset_code || "XLM"}` : "—"}</span>,
  },
  { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status || (row.successful ? "confirmed" : "pending")} /> },
  {
    key: "created_at",
    header: "Date",
    render: (row) => <span className="text-ink-400">{formatDate(row.confirmed_at || row.created_at)}</span>,
  },
];

function normalize<T>(data: T[] | { items?: T[] } | null): T[] {
  if (Array.isArray(data)) return data;
  return data?.items ?? [];
}

export default function DashboardPage() {
  const { data, loading, error } = useApiResource<DashboardReport>(() => api.get("/reports/dashboard"));
  const invoicesResource = useApiResource<Invoice[] | { items?: Invoice[] }>(() => api.get("/invoices?per_page=5"));
  const suppliersResource = useApiResource<Supplier[] | { items?: Supplier[] }>(() => api.get("/suppliers?per_page=5"));
  const outstanding = useOutstanding(data?.outstanding);

  const counts = data?.counts;
  const pending = Number(counts?.payments_pending ?? 0);
  const activity = monthlyVolumeToActivity(data?.monthly_volume);
  const transactions = data?.recent_transactions || [];
  const invoices = normalize(invoicesResource.data).slice(0, 5);
  const suppliers = normalize(suppliersResource.data).slice(0, 5);
  const hasData = reportHasData(data);

  if (loading) {
    return (
      <div className="space-y-6">
        <div><Skeleton className="h-8 w-52" /><Skeleton className="mt-2 h-4 w-80" /></div>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-32 rounded-card" />)}
        </div>
        <Skeleton className="h-72 rounded-card" />
      </div>
    );
  }

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Overview"
        title="Dashboard"
        description="A live view of invoices, supplier payments and agreement progress across your workspace."
        actions={
          <>
            <Link href="/invoices/new" className="ui-btn-secondary"><Plus className="h-4 w-4" /> New invoice</Link>
            <Link href="/agreements/new" className="ui-btn-primary">New agreement <ArrowRight className="h-4 w-4" /></Link>
          </>
        }
      />

      {error ? <div role="alert" className="ui-card mb-5 border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total invoices" value={formatNumber(counts?.invoices ?? 0)} hint="Issued in this workspace" icon={<FileText className="h-5 w-5" />} />
        <StatCard label="Total paid" value={formatMoney(data?.total_paid)} hint="Confirmed on-ledger" icon={<CircleDollarSign className="h-5 w-5" />} accent="green" />
        <StatCard label="Outstanding" value={outstanding === null ? "—" : formatMoney(outstanding)} hint="Awaiting settlement" icon={<Wallet className="h-5 w-5" />} accent="amber" />
        <StatCard label="Pending approvals" value={formatNumber(pending)} hint="Payments needing review" icon={<FileCheck2 className="h-5 w-5" />} accent="slate" />
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <StatCard label="Active agreements" value={formatNumber(counts?.agreements_active ?? 0)} hint="Currently in progress" icon={<Handshake className="h-5 w-5" />} />
        <StatCard label="Milestones released" value={formatNumber(counts?.milestones_released ?? 0)} hint="Released from escrow" icon={<Handshake className="h-5 w-5" />} accent="green" />
        <StatCard label="Confirmed payments" value={formatNumber(counts?.payments_confirmed ?? 0)} hint="Verified on-ledger" icon={<ReceiptText className="h-5 w-5" />} accent="blue" />
      </div>

      <div className="ui-panel mt-5 flex flex-wrap items-center gap-2 p-4">
        <p className="ui-kicker mr-2">Quick actions</p>
        <Link href="/suppliers" className="ui-btn-secondary"><Building2 className="h-4 w-4" /> Suppliers</Link>
        <Link href="/escrow" className="ui-btn-secondary"><Handshake className="h-4 w-4" /> Escrow</Link>
        <Link href="/reports" className="ui-btn-secondary"><ReceiptText className="h-4 w-4" /> Reports</Link>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <SectionCard title="Payment activity" description="Settled volume by month">
          {activity.length ? (
            <ActivityChart activity={activity} />
          ) : (
            <EmptyState compact icon={<Inbox className="h-6 w-6" />} title="No activity yet" description={hasData ? "No payments have settled yet." : "Once payments start settling, volume will appear here."} />
          )}
        </SectionCard>

        <SectionCard title="Approval queue" description="Payments waiting on your team" actions={<Link href="/payments/approve" className="text-xs font-semibold text-accent-700 hover:underline">View all</Link>}>
          {pending > 0 ? (
            <div className="flex items-center gap-3 rounded-control border border-amber-200 bg-amber-50 p-4">
              <FileCheck2 className="h-5 w-5 text-amber-600" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-900">{formatNumber(pending)} awaiting approval</p>
                <p className="text-xs text-amber-700">Review transaction details before signing.</p>
              </div>
              <Link href="/payments/approve" className="ui-btn bg-amber-600 px-3 py-2 text-xs text-white hover:bg-amber-700">Review</Link>
            </div>
          ) : (
            <EmptyState compact icon={<FileCheck2 className="h-6 w-6" />} title="All caught up" description="No payments are waiting for approval right now." />
          )}
        </SectionCard>
      </div>

      <div className="mt-5 grid gap-5 xl:grid-cols-3">
        <SectionCard title="Recent invoices" description="Latest requests in this workspace" className="[&>div:last-child]:p-0" actions={<Link href="/invoices" className="text-xs font-semibold text-accent-700 hover:underline">View all</Link>}>
          {invoices.length ? (
            <ul className="divide-y divide-line">
              {invoices.map((invoice) => (
                <li key={invoice.id}>
                  <Link href={`/invoices/${invoice.id}`} className="flex items-center justify-between gap-3 px-5 py-3.5 hover:bg-slate-50">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-ink-900">{invoice.invoice_number || invoice.description || "Invoice"}</p>
                      <p className="text-xs text-ink-400">{invoice.supplier?.business_name || "Supplier"}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-ink-900">{formatMoney(invoice.amount)}</p>
                      <StatusBadge status={invoice.status} dot={false} />
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title="No invoices yet" description="Create an invoice to start tracking payments." />
          )}
        </SectionCard>

        <SectionCard title="Supplier activity" description="Suppliers in your directory" className="[&>div:last-child]:p-0" actions={<Link href="/suppliers" className="text-xs font-semibold text-accent-700 hover:underline">View all</Link>}>
          {suppliers.length ? (
            <ul className="divide-y divide-line">
              {suppliers.map((supplier) => (
                <li key={supplier.id}>
                  <Link href={`/suppliers/${supplier.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50">
                    <span className="flex h-8 w-8 items-center justify-center rounded-control bg-slate-100 text-ink-500"><Building2 className="h-4 w-4" /></span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink-900">{supplier.business_name}</span>
                    <StatusBadge status={supplier.status || "active"} dot={false} />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact title="No suppliers yet" description="Add a supplier to your directory." />
          )}
        </SectionCard>

        <SectionCard title="Latest ledger activity" description="Verified transactions only" className="[&>div:last-child]:p-0" actions={<Link href="/transactions" className="text-xs font-semibold text-accent-700 hover:underline">View history</Link>}>
          <DataTable
            columns={columns}
            rows={transactions}
            rowKey={(row) => row.hash}
            dense
            emptyTitle="No transactions yet"
            emptyDescription="Confirmed Stellar payments will appear here once your first invoice is paid."
          />
        </SectionCard>
      </div>
    </div>
  );
}
