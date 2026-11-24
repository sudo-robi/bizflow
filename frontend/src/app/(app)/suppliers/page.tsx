"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Building2, Plus, Search, Users } from "lucide-react";
import { DataTable, FilterTabs, TableToolbar, type Column } from "@/components/DataTable";
import { ConfirmModal } from "@/components/ConfirmModal";
import { Modal } from "@/components/Modal";
import { PageHeader } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { SupplierForm, type SupplierFormValues } from "@/components/SupplierForm";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";
import { truncateAddress } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Paginated, Supplier } from "@/lib/types";

type Filter = "all" | "active" | "archived";

function unwrap(result: Paginated<Supplier> | Supplier[] | null): Supplier[] {
  if (Array.isArray(result)) return result;
  return result?.items || [];
}

export default function SuppliersPage() {
  const router = useRouter();
  const toast = useToast();
  const { can } = useAuth();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toArchive, setToArchive] = useState<Supplier | null>(null);
  const [archiving, setArchiving] = useState(false);

  const { data, loading, error, reload } = useApiResource<Paginated<Supplier> | Supplier[]>(
    () => api.get(`/suppliers?search=${encodeURIComponent(search)}&page=1&per_page=100`),
    [search],
  );
  const suppliers = useMemo(() => unwrap(data), [data]);
  const filtered = suppliers.filter((supplier) => {
    if (filter === "active") return (supplier.status || "active") !== "archived";
    if (filter === "archived") return supplier.status === "archived";
    return true;
  });

  const onCreate = async (values: SupplierFormValues) => {
    setSaving(true);
    try {
      await api.post("/suppliers", values);
      toast.success("Supplier added", `${values.business_name} is ready to receive invoices.`);
      setAddOpen(false);
      reload();
    } catch (reason) {
      toast.error("Could not add supplier", getErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const onArchive = async () => {
    if (!toArchive) return;
    setArchiving(true);
    try {
      await api.post(`/suppliers/${toArchive.id}/archive`);
      toast.success("Supplier archived", `${toArchive.business_name} can no longer be selected for new invoices.`);
      setToArchive(null);
      reload();
    } catch (reason) {
      toast.error("Could not archive supplier", getErrorMessage(reason));
    } finally {
      setArchiving(false);
    }
  };

  const columns: Column<Supplier>[] = [
    {
      key: "business_name",
      header: "Supplier",
      render: (row) => (
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600">
            <Building2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate font-medium text-navy-900">{row.business_name}</p>
            <p className="truncate text-xs text-slate-500">{row.email || row.contact_name || "No contact details"}</p>
          </div>
        </div>
      ),
    },
    {
      key: "wallet_address",
      header: "Stellar address",
      render: (row) => <span className="font-mono text-xs text-slate-600">{truncateAddress(row.wallet_address, 8, 6)}</span>,
    },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status || "active"} /> },
    { key: "country", header: "Country", render: (row) => <span className="text-slate-500">{row.country || "—"}</span> },
    {
      key: "actions",
      header: "",
      headerClassName: "text-right",
      className: "text-right",
      render: (row) => (
        <div className="flex items-center justify-end gap-1" onClick={(event) => event.stopPropagation()}>
          <Link href={`/suppliers/${row.id}`} className="rounded-md px-2.5 py-1.5 text-xs font-semibold text-accent-600 hover:bg-accent-50">View</Link>
          {can("owner", "admin") && row.status !== "archived" ? (
            <button
              type="button"
              onClick={() => setToArchive(row)}
              className="rounded-md p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
              aria-label={`Archive ${row.business_name}`}
              title="Archive supplier"
            >
              <Archive className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Operations"
        title="Suppliers"
        description="Manage the organisations you pay, including their verified Stellar receiving addresses."
        actions={
          can("owner", "admin", "finance_manager") ? (
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-accent-700"
            >
              <Plus className="h-4 w-4" /> Add supplier
            </button>
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
            placeholder="Search by name or email…"
            aria-label="Search suppliers"
            className="block w-full rounded-lg border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition focus:border-accent-600 focus:ring-2 focus:ring-accent-100"
          />
        </div>
        <FilterTabs
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All", count: suppliers.length },
            { value: "active", label: "Active" },
            { value: "archived", label: "Archived" },
          ]}
        />
      </TableToolbar>

      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(row) => row.id}
        loading={loading}
        onRowClick={(row) => router.push(`/suppliers/${row.id}`)}
        emptyTitle={search ? "No matching suppliers" : "No suppliers yet"}
        emptyDescription={search ? "Try a different name or clear your search." : "Add your first supplier and their Stellar address to start paying invoices."}
        emptyAction={!search && can("owner", "admin", "finance_manager") ? (
          <button onClick={() => setAddOpen(true)} className="rounded-lg bg-accent-600 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-700">Add supplier</button>
        ) : undefined}
      />

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="Add a supplier" description="Payments are sent to the Stellar address you provide. Double-check it before saving.">
        <SupplierForm onSubmit={onCreate} submitting={saving} onCancel={() => setAddOpen(false)} />
      </Modal>

      <ConfirmModal
        open={!!toArchive}
        onClose={() => setToArchive(null)}
        onConfirm={onArchive}
        title="Archive supplier?"
        message={`${toArchive?.business_name || "This supplier"} will be hidden from new invoices. Existing records stay intact.`}
        confirmLabel="Archive supplier"
        tone="danger"
        loading={archiving}
      />
    </div>
  );
}
