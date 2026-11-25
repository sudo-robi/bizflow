"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ExternalLink, ReceiptText, Search, ShieldCheck } from "lucide-react";
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
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-accent-50 text-accent-600"><ReceiptText className="h-4 w-4" aria-hidden="true" /></span>
          <div className="min-w-0">
            <Link href={`/transactions/${encodeURIComponent(row.hash)}`} className="font-mono text-xs font-semibold text-accent-700 hover:underline">{truncateAddress(row.hash, 10, 8)}</Link>
            <p className="mt-0.5 text-2xs text-ink-400">{formatDate(row.created_at || row.confirmed_at)}</p>
          </div>
        </div>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      render: (row) => (
        <span className="whitespace-nowrap font-semibold text-ink-900">
          {row.amount ? `${formatMoney(row.amount, { decimals: 4 })} ${row.asset_code || "XLM"}` : "—"}
        </span>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => (
        <div className="space-y-1">
          <StatusBadge status={row.status || (row.successful ? "confirmed" : "pending")} />
          {row.verification_status ? <p className="text-2xs font-medium text-ink-400">Verification: {String(row.verification_status)}</p> : null}
        </div>
      ),
    },
    {
      key: "from",
      header: "From / To",
      render: (row) => (
        <div className="space-y-1">
          <p className="font-mono text-2xs text-ink-600">{row.source_account ? truncateAddress(row.source_account, 6, 4) : "—"}</p>
          <p className="font-mono text-2xs text-ink-400">→ {row.destination_account ? truncateAddress(row.destination_account, 6, 4) : "—"}</p>
        </div>
      ),
    },
    {
      key: "explorer",
      header: "",
      headerClassName: "text-right",
      className: "text-right",
      render: (row) => row.hash ? (
        <a href={explorerUrl(row.hash)} target="_blank" rel="noopener noreferrer" onClick={(event) => event.stopPropagation()} className="inline-flex items-center gap-1 rounded-control px-2 py-2 text-xs font-medium text-ink-500 transition hover:bg-slate-100 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500" aria-label="View on Stellar Expert">
          Explorer <ExternalLink className="h-3 w-3" />
        </a>
      ) : <span className="text-ink-400">—</span>,
    },
  ];

  return (
    <div className="animate-fade-in space-y-5">
      <PageHeader eyebrow="Operations" title="Transactions" description="Every blockchain transaction recorded for this workspace, with independent verification status." />

      <div className="flex items-start gap-3 rounded-card border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-700">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>Explorer links open the live Testnet record for hashes returned by the backend. No hash is generated in this browser.</p>
      </div>

      {error ? <div role="alert" className="ui-card border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <TableToolbar>
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" aria-hidden="true" />
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search by hash…" aria-label="Search transactions" className="ui-input pl-9" />
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
