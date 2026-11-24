"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Building2, FileText, Mail, MapPin, Pencil, ReceiptText, Wallet } from "lucide-react";
import { DataTable, type Column } from "@/components/DataTable";
import { Modal } from "@/components/Modal";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { SupplierForm, type SupplierFormValues } from "@/components/SupplierForm";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";
import { formatDate, formatMoney, truncateAddress } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Invoice, Payment, Supplier } from "@/lib/types";

interface SupplierDetail {
  supplier: Supplier;
  invoices: Invoice[];
  payments: Payment[];
}

function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) {
    return (value as { items: T[] }).items;
  }
  return [];
}

export default function SupplierDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const toast = useToast();
  const { can } = useAuth();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, loading, error, reload } = useApiResource<SupplierDetail>(async () => {
    const [supplier, invoices, payments] = await Promise.all([
      api.get<Supplier>(`/suppliers/${id}`),
      api.get<unknown>(`/suppliers/${id}/invoices`),
      api.get<unknown>(`/suppliers/${id}/payments`),
    ]);
    return { supplier, invoices: asList<Invoice>(invoices), payments: asList<Payment>(payments) };
  }, [id]);

  const onEdit = async (values: SupplierFormValues) => {
    setSaving(true);
    try {
      await api.patch(`/suppliers/${id}`, values);
      toast.success("Supplier updated");
      setEditing(false);
      reload();
    } catch (reason) {
      toast.error("Could not save changes", getErrorMessage(reason));
    } finally {
      setSaving(false);
    }
  };

  const invoiceColumns: Column<Invoice>[] = [
    {
      key: "invoice_number",
      header: "Invoice",
      render: (row) => (
        <Link href={`/invoices/${row.id}`} className="font-medium text-accent-600 hover:underline">
          {row.invoice_number || row.id.slice(0, 8)}
        </Link>
      ),
    },
    { key: "description", header: "Description", render: (row) => <span className="text-slate-600">{row.description || "—"}</span> },
    { key: "amount", header: "Amount", render: (row) => <span className="font-medium text-navy-900">{formatMoney(row.amount, { decimals: 4 })} {row.asset_code || "XLM"}</span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    { key: "due_date", header: "Due", render: (row) => <span className="text-slate-500">{formatDate(row.due_date)}</span> },
  ];

  const paymentColumns: Column<Payment>[] = [
    {
      key: "id",
      header: "Payment",
      render: (row) => <span className="font-mono text-xs text-slate-600">{truncateAddress(row.id, 8, 4)}</span>,
    },
    { key: "amount", header: "Amount", render: (row) => <span className="font-medium text-navy-900">{formatMoney(row.amount, { decimals: 4 })} {row.asset_code || "XLM"}</span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "hash",
      header: "Transaction",
      render: (row) => row.hash ? (
        <Link href={`/transactions/${encodeURIComponent(row.hash)}`} className="font-mono text-xs text-accent-600 hover:underline">
          {truncateAddress(row.hash, 8, 4)}
        </Link>
      ) : <span className="text-slate-400">—</span>,
    },
    { key: "created_at", header: "Date", render: (row) => <span className="text-slate-500">{formatDate(row.created_at)}</span> },
  ];

  if (loading) return <div className="py-16 text-center text-sm text-slate-500">Loading supplier…</div>;
  if (error) return <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  if (!data) return null;

  const supplier = data.supplier;

  return (
    <div className="animate-fade-in">
      <Link href="/suppliers" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 transition hover:text-navy-900">
        <ArrowLeft className="h-4 w-4" /> Back to suppliers
      </Link>

      <PageHeader
        eyebrow="Supplier profile"
        title={supplier.business_name}
        description="Contact details, receiving address and payment history for this supplier."
        actions={
          can("owner", "admin", "finance_manager") ? (
            <button onClick={() => setEditing(true)} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50">
              <Pencil className="h-4 w-4" /> Edit profile
            </button>
          ) : null
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
        <SectionCard title="Details">
          <dl className="space-y-4">
            <div className="flex items-start gap-3">
              <Building2 className="mt-0.5 h-4 w-4 text-slate-400" />
              <div><dt className="text-xs text-slate-500">Status</dt><dd className="mt-1"><StatusBadge status={supplier.status || "active"} /></dd></div>
            </div>
            <div className="flex items-start gap-3">
              <Wallet className="mt-0.5 h-4 w-4 text-slate-400" />
              <div className="min-w-0">
                <dt className="text-xs text-slate-500">Stellar receiving address</dt>
                <dd className="mt-1 break-all font-mono text-xs text-navy-900">{supplier.wallet_address}</dd>
              </div>
            </div>
            {supplier.contact_name ? <div className="flex items-start gap-3"><Building2 className="mt-0.5 h-4 w-4 text-slate-400" /><div><dt className="text-xs text-slate-500">Contact</dt><dd className="mt-1 text-sm text-navy-900">{supplier.contact_name}</dd></div></div> : null}
            {supplier.email ? <div className="flex items-start gap-3"><Mail className="mt-0.5 h-4 w-4 text-slate-400" /><div><dt className="text-xs text-slate-500">Email</dt><dd className="mt-1 text-sm text-navy-900">{supplier.email}</dd></div></div> : null}
            {supplier.country ? <div className="flex items-start gap-3"><MapPin className="mt-0.5 h-4 w-4 text-slate-400" /><div><dt className="text-xs text-slate-500">Country</dt><dd className="mt-1 text-sm text-navy-900">{supplier.country}</dd></div></div> : null}
            {supplier.notes ? <div className="border-t border-slate-100 pt-4"><dt className="text-xs text-slate-500">Internal notes</dt><dd className="mt-1 text-sm leading-relaxed text-slate-600">{supplier.notes}</dd></div> : null}
          </dl>
        </SectionCard>

        <div className="space-y-5">
          <SectionCard title="Invoices" description={`${data.invoices.length} invoice(s) for this supplier`} actions={<Link href="/invoices/new" className="text-xs font-semibold text-accent-600 hover:underline">New invoice</Link>} className="[&>div:last-child]:p-0">
            <DataTable columns={invoiceColumns} rows={data.invoices} rowKey={(row) => row.id} emptyTitle="No invoices yet" emptyDescription="Invoices for this supplier will appear here." />
          </SectionCard>
          <SectionCard title="Payments" description={`${data.payments.length} payment record(s)`} className="[&>div:last-child]:p-0">
            <DataTable columns={paymentColumns} rows={data.payments} rowKey={(row) => row.id} emptyTitle="No payments yet" emptyDescription="Confirmed and pending payments will appear here." />
          </SectionCard>
        </div>
      </div>

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit supplier" description="Update contact details or the receiving Stellar address.">
        <SupplierForm idPrefix="edit-supplier" defaultValues={supplier} submitting={saving} onSubmit={onEdit} onCancel={() => setEditing(false)} />
      </Modal>
    </div>
  );
}
