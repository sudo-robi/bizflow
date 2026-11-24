"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, ReceiptText, Search } from "lucide-react";
import { DataTable, FilterTabs, TableToolbar, type Column } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { api } from "@/lib/api";
import { formatDate, formatMoney, truncateAddress } from "@/lib/format";
import { explorerUrl } from "@/lib/stellar";
import { useApiResource } from "@/lib/useApiResource";
import type { BlockchainTransaction } from "@/lib/types";

type Filter = "all" | "confirmed" | "pending" | "failed";

function unwrap(value: unknown): BlockchainTransaction[] {
  if (Array.isArray(value)) return value as BlockchainTransaction[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) return (value as { items: BlockchainTransaction[] }).items;
  return [];
}

export default function TransactionsPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const { data, loading, error } = useApiResource<unknown>(() => api.get("/transactions?per_page=100"));
  const transactions = unwrap(data).filter((transaction) => {
    const status = transaction.status || (transaction.successful ? "confirmed" : "pending");
    const matchesFilter = filter === "all" || status.toLowerCase() === filter || (filter === "confirmed" && status === "successful");
    const matchesSearch = !search || (transaction.hash || "").toLowerCase().includes(search.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const columns: Column<BlockchainTransaction>[] = [
    {
      key: "hash",
      header: "Transaction hash",
      render: (row) => (
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-100 text-slate-500"><ReceiptText className="h-4 w-4" /></span>
          <div>
            <Link href={`/transactions/${encodeURIComponent(row.hash)}`} className="font-mono text-xs font-medium text-accent-600 hover:underline">{truncateAddress(row.hash, 10, 8)}</Link>
            <p className="text-[11px] text-slate-400">{formatDate(row.created_at || row.confirmed_at)}</p>
          </div>
        </div>
      ),
    },
    { key: "amount", header: "Amount", render: (row) => <span className="font-medium text-navy-900">{row.amount ? `${formatMoney(row.amount, { decimals: 4 })} ${row.asset_code || "XLM"}` : "—"}</span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status || (row.successful ? "confirmed" : "pending")} /> },
    {
      key: "from",
      header: "From / To",
      render: (row) => (
        <div className="space-y-0.5">
          <p className="font-mono text-[11px] text-slate-600">{row.source_account ? truncateAddress(row.source_account, 6, 4) : "—"}</p>
          <p className="font-mono text-[11px] text-slate-400">→ {row.destination_account ? truncateAddress(row.destination_account, 6, 4) : "—"}</p>
        </div>
      ),
    },
    {
      key: "explorer",
      header: "",
      headerClassName: "text-right",
      className: "text-right",
      render: (row) => (
        <a href={explorerUrl(row.hash)} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-navy-900" aria-label="View on Stellar Expert">
          Explorer <ExternalLink className="h-3 w-3" />
        </a>
      ),
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader eyebrow="Operations" title="Transactions" description="Every blockchain transaction recorded for this workspace, with independent verification status." />

      {error ? <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <TableToolbar>
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by hash…" aria-label="Search transactions" className="block w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:border-accent-600 focus:ring-2 focus:ring-accent-100" />
        </div>
        <FilterTabs value={filter} onChange={setFilter} options={[
          { value: "all", label: "All" },
          { value: "confirmed", label: "Confirmed" },
          { value: "pending", label: "Pending" },
          { value: "failed", label: "Failed" },
        ]} />
      </TableToolbar>

      <DataTable
        columns={columns}
        rows={transactions}
        rowKey={(row) => row.hash}
        loading={loading}
        onRowClick={(row) => router.push(`/transactions/${encodeURIComponent(row.hash)}`)}
        emptyTitle="No transactions found"
        emptyDescription="Confirmed and pending Stellar transactions will appear here once payments are submitted."
      />
    </div>
  );
}
