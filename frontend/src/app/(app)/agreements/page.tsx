"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowUpRight, CalendarDays, Handshake, Layers3, Plus, ShieldCheck } from "lucide-react";
import { DataTable, FilterTabs, TableToolbar, type Column } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { useAuth } from "@/app/providers";
import { api } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Agreement } from "@/lib/types";

type Filter = "all" | "draft" | "awaiting_acceptance" | "active" | "completed" | "cancelled" | "disputed";

export default function AgreementsPage() {
  const router = useRouter();
  const { can } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const { data, loading, error } = useApiResource<Agreement[]>(() => api.get(`/agreements${filter !== "all" ? `?status=${filter}` : ""}`), [filter]);
  const agreements = useMemo(() => (Array.isArray(data) ? data : (data as unknown as { items?: Agreement[] })?.items || []), [data]);

  const columns: Column<Agreement>[] = [
    {
      key: "reference",
      header: "Agreement",
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent-50 text-accent-600" aria-hidden="true">
            <Handshake className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-ink-900">{row.title}</p>
            <p className="font-mono text-2xs text-ink-400">{row.reference || row.id.slice(0, 8)}</p>
          </div>
        </div>
      ),
    },
    {
      key: "supplier",
      header: "Supplier",
      render: (row) => <span className="text-ink-700">{row.supplier?.business_name || "—"}</span>,
    },
    {
      key: "total_amount",
      header: "Total value",
      render: (row) => (
        <span className="whitespace-nowrap font-semibold text-ink-900">
          {formatMoney(row.total_amount, { decimals: 4 })}
          <span className="ml-1.5 rounded-control bg-slate-100 px-1.5 py-0.5 text-2xs font-medium text-ink-500">{row.asset_code || "XLM"}</span>
        </span>
      ),
    },
    {
      key: "milestones",
      header: "Milestones",
      render: (row) => (
        <span className="inline-flex items-center gap-1.5 text-ink-700">
          <Layers3 className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
          <span className="font-semibold text-ink-900">{row.milestones?.length || 0}</span>
        </span>
      ),
    },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "expiry_date",
      header: "Expires",
      render: (row) => (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-ink-500">
          <CalendarDays className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
          {formatDate(row.expiry_date)}
        </span>
      ),
    },
  ];

  return (
    <div className="animate-fade-in space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Agreements"
        description="Milestone-based supplier contracts with funds held in escrow until work is delivered."
        actions={
          can("owner", "admin") ? (
            <Link href="/agreements/new" className="ui-btn-accent">
              <Plus className="h-4 w-4" /> New agreement
            </Link>
          ) : null
        }
      />

      <div className="flex items-start gap-3 rounded-card border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-700">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>Funds are released milestone by milestone only after the contract event is verified on Testnet.</p>
      </div>

      {error ? <div role="alert" className="ui-card border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <TableToolbar>
        <div>
          <p className="ui-kicker">Contract register</p>
          <p className="mt-1 text-xs text-ink-400">Track acceptance, funding and milestone releases in one place.</p>
        </div>
        <FilterTabs
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "draft", label: "Draft" },
            { value: "awaiting_acceptance", label: "Awaiting" },
            { value: "active", label: "Active" },
            { value: "completed", label: "Completed" },
            { value: "disputed", label: "Disputed" },
          ]}
        />
      </TableToolbar>

      <DataTable
        columns={columns}
        rows={agreements}
        rowKey={(row) => row.id}
        loading={loading}
        onRowClick={(row) => router.push(`/agreements/${row.id}`)}
        emptyTitle="No agreements found"
        emptyDescription="Milestone agreements with suppliers will appear here once created."
        emptyAction={can("owner", "admin") ? <Link href="/agreements/new" className="ui-btn-accent">New agreement <ArrowUpRight className="h-4 w-4" /></Link> : undefined}
      />
    </div>
  );
}
