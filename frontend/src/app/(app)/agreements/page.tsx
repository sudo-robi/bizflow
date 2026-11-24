"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Handshake, Plus } from "lucide-react";
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
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><Handshake className="h-4 w-4" /></span>
          <div className="min-w-0">
            <p className="font-medium text-navy-900">{row.title}</p>
            <p className="font-mono text-[11px] text-slate-500">{row.reference || row.id.slice(0, 8)}</p>
          </div>
        </div>
      ),
    },
    { key: "supplier", header: "Supplier", render: (row) => <span className="text-slate-600">{row.supplier?.business_name || "—"}</span> },
    { key: "total_amount", header: "Total", render: (row) => <span className="font-medium text-navy-900">{formatMoney(row.total_amount, { decimals: 4 })} <span className="text-xs text-slate-400">{row.asset_code || "XLM"}</span></span> },
    { key: "milestones", header: "Milestones", render: (row) => <span className="text-slate-600">{row.milestones?.length || 0}</span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    { key: "expiry_date", header: "Expires", render: (row) => <span className="text-slate-500">{formatDate(row.expiry_date)}</span> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Operations"
        title="Agreements"
        description="Milestone-based supplier contracts with funds held in escrow until work is delivered."
        actions={
          can("owner", "admin") ? (
            <Link href="/agreements/new" className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-accent-700">
              <Plus className="h-4 w-4" /> New agreement
            </Link>
          ) : null
        }
      />

      {error ? <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <TableToolbar>
        <p className="text-xs text-slate-500">Track acceptance, funding and milestone releases in one place.</p>
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
        emptyAction={can("owner", "admin") ? <Link href="/agreements/new" className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-700">New agreement</Link> : undefined}
      />
    </div>
  );
}
