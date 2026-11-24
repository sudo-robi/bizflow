"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Plus, Search } from "lucide-react";
import { DataTable, FilterTabs, TableToolbar, type Column } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { useAuth } from "@/app/providers";
import { api } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Invoice, Paginated } from "@/lib/types";

type Filter = "all" | "draft" | "pending" | "partially_paid" | "paid" | "overdue" | "cancelled";

function unwrap(result: Paginated<Invoice> | Invoice[] | null): Invoice[] {
  if (Array.isArray(result)) return result;
  return result?.items || [];
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
  const invoices = useMemo(() => {
    const list = unwrap(data);
    if (!search.trim()) return list;
    const term = search.toLowerCase();
    return list.filter((invoice) =>
      [invoice.invoice_number, invoice.description, invoice.reference, invoice.supplier?.business_name]
        .some((value) => value?.toLowerCase().includes(term)),
    );
  }, [data, search]);

  const columns: Column<Invoice>[] = [
    {
      key: "invoice_number",
      header: "Invoice",
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><FileText className="h-4 w-4" /></span>
          <div>
            <p className="font-medium text-navy-900">{row.invoice_number || row.id.slice(0, 8)}</p>
            <p className="text-xs text-slate-500">{row.supplier?.business_name || "Supplier"}</p>
          </div>
        </div>
      ),
    },
    { key: "description", header: "Description", render: (row) => <span className="line-clamp-1 text-slate-600">{row.description || row.reference || "—"}</span> },
    { key: "amount", header: "Amount", render: (row) => <span className="font-medium text-navy-900">{formatMoney(row.amount, { decimals: 4 })} <span className="text-xs text-slate-400">{row.asset_code || "XLM"}</span></span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    { key: "due_date", header: "Due date", render: (row) => <span className="text-slate-500">{formatDate(row.due_date)}</span> },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Operations"
        title="Invoices"
        description="Issue invoices, follow their status and settle them directly on Stellar."
        actions={
          can("owner", "admin", "finance_manager") ? (
            <Link href="/invoices/new" className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700">
              <Plus className="h-4 w-4" /> New invoice
            </Link>
          ) : null
        }
      />

      {error ? <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <TableToolbar>
        <div className="relative w-full sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search invoices…"
            aria-label="Search invoices"
            className="block w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-accent-600 focus:ring-2 focus:ring-accent-100"
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
