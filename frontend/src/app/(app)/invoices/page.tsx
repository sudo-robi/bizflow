"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Plus, Search } from "lucide-react";
import { DataTable, FilterTabs, TableToolbar, type Column } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { StatCard } from "@/components/StatCard";
import { StatusBadge } from "@/components/StatusBadge";
import { useAuth } from "@/app/providers";
import { api } from "@/lib/api";
import { formatDate, formatMoney, formatNumber, toNumber } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Invoice, Paginated } from "@/lib/types";

type Filter = "all" | "draft" | "pending" | "partially_paid" | "paid" | "overdue" | "cancelled";

function unwrap(result: Paginated<Invoice> | Invoice[] | null): Invoice[] {
  if (Array.isArray(result)) return result;
  return result?.items || [];
}

/** Payment progress is derived only from the amounts returned by the API. */
function paymentPosition(invoice: Invoice) {
  const total = toNumber(invoice.amount);
  const paid = toNumber(invoice.amount_paid);
  const remaining = invoice.remaining_amount !== undefined
    ? toNumber(invoice.remaining_amount)
    : Math.max(total - paid, 0);
  const percent = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  return { total, paid, remaining, percent };
}

export default function InvoicesPage() {
  const router = useRouter();
  const { can } = useAuth();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");

  const { data, loading, error } = useApiResource<Paginated<Invoice> | Invoice[]>(
    () => api.get(`/invoices${filter !== "all" ? `?status=${filter}` : ""}`),
    [filter],
  );

  const loaded = useMemo(() => unwrap(data), [data]);
  const invoices = useMemo(() => {
    if (!search.trim()) return loaded;
    const term = search.toLowerCase();
    return loaded.filter((invoice) =>
      [invoice.invoice_number, invoice.description, invoice.reference, invoice.supplier?.business_name]
        .some((value) => value?.toLowerCase().includes(term)),
    );
  }, [loaded, search]);

  const summary = useMemo(() => {
    const positions = loaded.map(paymentPosition);
    return {
      count: loaded.length,
      paid: positions.reduce((sum, position) => sum + position.paid, 0),
      outstanding: positions.reduce((sum, position) => sum + position.remaining, 0),
    };
  }, [loaded]);

  const columns: Column<Invoice>[] = [
    {
      key: "invoice_number",
      header: "Invoice",
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent-50 text-accent-600" aria-hidden="true">
            <FileText className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="font-semibold text-ink-900">{row.invoice_number || row.id.slice(0, 8)}</p>
            <p className="truncate text-xs text-ink-400">{row.supplier?.business_name || "Supplier"}</p>
          </div>
        </div>
      ),
    },
    {
      key: "description",
      header: "Description",
      render: (row) => <span className="line-clamp-1 text-ink-500">{row.description || row.reference || "—"}</span>,
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => (
        <span className="whitespace-nowrap font-semibold text-ink-900">
          {formatMoney(row.amount, { decimals: 4 })}
          <span className="ml-1 text-xs font-medium text-ink-400">{row.asset_code || "XLM"}</span>
        </span>
      ),
    },
    {
      key: "payment",
      header: "Payment",
      render: (row) => {
        const { paid, remaining, percent } = paymentPosition(row);
        return (
          <div className="min-w-[168px]">
            <div className="flex items-center justify-between gap-2 text-2xs text-ink-400">
              <span>{formatMoney(paid, { decimals: 4 })} paid</span>
              <span>{formatMoney(remaining, { decimals: 4 })} left</span>
            </div>
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
              role="progressbar"
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${percent}% of invoice paid`}
            >
              <div className="h-full rounded-full bg-accent-500" style={{ width: `${percent}%` }} />
            </div>
          </div>
        );
      },
    },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "due_date",
      header: "Due date",
      render: (row) => <span className="whitespace-nowrap text-ink-400">{formatDate(row.due_date)}</span>,
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Operations"
        title="Invoices"
        description="Issue invoices, follow their status and settle them directly on Stellar."
        actions={
          can("owner", "admin", "finance_manager") ? (
            <Link href="/invoices/new" className="ui-btn-accent">
              <Plus className="h-4 w-4" /> New invoice
            </Link>
          ) : null
        }
      />

      {error ? (
        <div role="alert" className="ui-card mb-5 border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : null}

      <div className="mb-5 grid gap-4 sm:grid-cols-3">
        <StatCard label="Invoices in view" value={formatNumber(summary.count)} hint="Loaded from this workspace" icon={<FileText className="h-5 w-5" />} />
        <StatCard label="Amount paid" value={formatMoney(summary.paid, { decimals: 4 })} hint="Confirmed against invoices" accent="green" />
        <StatCard label="Outstanding" value={formatMoney(summary.outstanding, { decimals: 4 })} hint="Awaiting settlement" accent="amber" />
      </div>

      <TableToolbar>
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" aria-hidden="true" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search invoices…"
            aria-label="Search invoices"
            className="ui-input pl-9"
          />
        </div>
        <FilterTabs
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "draft", label: "Draft" },
            { value: "pending", label: "Pending" },
            { value: "partially_paid", label: "Partial" },
            { value: "paid", label: "Paid" },
            { value: "overdue", label: "Overdue" },
          ]}
        />
      </TableToolbar>

      <DataTable
        columns={columns}
        rows={invoices}
        rowKey={(row) => row.id}
        loading={loading}
        onRowClick={(row) => router.push(`/invoices/${row.id}`)}
        emptyTitle={search ? "No matching invoices" : "No invoices found"}
        emptyDescription={search ? "Try a different search term or status filter." : "Create your first invoice to begin tracking supplier payments."}
      />
    </div>
  );
}
