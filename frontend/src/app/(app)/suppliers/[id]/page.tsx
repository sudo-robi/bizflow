"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  Building2,
  Copy,
  FileText,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Send,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { FormField } from "@/components/FormField";
import { Modal } from "@/components/Modal";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { StatusBadge } from "@/components/StatusBadge";
import { SupplierForm, type SupplierFormValues } from "@/components/SupplierForm";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";
import { formatDate, formatMoney, humanize, truncateAddress } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Invoice, Payment, Supplier } from "@/lib/types";

interface SupplierDetail {
  supplier: Supplier;
  invoices: Invoice[];
  payments: Payment[];
}

interface SupplierInvitation {
  id: string;
  supplier_id: string;
  email: string;
  status: string;
  role?: string;
  expires_at?: string;
  created_at?: string;
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
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ email: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const canManage = can("owner", "admin", "finance_manager");

  const { data, loading, error, reload } = useApiResource<SupplierDetail>(async () => {
    const [supplier, invoices, payments] = await Promise.all([
      api.get<Supplier>(`/suppliers/${id}`),
      api.get<unknown>(`/suppliers/${id}/invoices`),
      api.get<unknown>(`/suppliers/${id}/payments`),
    ]);
    return { supplier, invoices: asList<Invoice>(invoices), payments: asList<Payment>(payments) };
  }, [id]);

  const invitationsResource = useApiResource<unknown>(
    () => api.get("/suppliers/invitations"),
    [id],
    canManage,
  );
  const invitations = asList<SupplierInvitation>(invitationsResource.data).filter(
    (invite) => invite.supplier_id === id && typeof invite.email === "string",
  );

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

  const openInvite = () => {
    setIssuedToken(null);
    setInviteEmail(data?.supplier.email || "");
    setInviteOpen(true);
  };

  const onInvite = async () => {
    setInviting(true);
    try {
      const created = await api.post<{ email: string; token?: string | null }>(`/suppliers/${id}/invitations`, { email: inviteEmail.trim() });
      setIssuedToken({ email: created.email || inviteEmail.trim(), token: created.token || "" });
      toast.success("Invitation created", "Share the access token with the supplier contact.");
      invitationsResource.reload();
    } catch (reason) {
      toast.error("Could not send invitation", getErrorMessage(reason));
    } finally {
      setInviting(false);
    }
  };

  const onRevoke = async (invite: SupplierInvitation) => {
    setRevoking(invite.id);
    try {
      await api.post(`/suppliers/${id}/invitations/${invite.id}/revoke`);
      toast.success("Invitation revoked", `${invite.email} can no longer accept this invitation.`);
      invitationsResource.reload();
    } catch (reason) {
      toast.error("Could not revoke invitation", getErrorMessage(reason));
    } finally {
      setRevoking(null);
    }
  };

  const invoiceColumns: Column<Invoice>[] = [
    {
      key: "invoice_number",
      header: "Invoice",
      render: (row) => (
        <Link href={`/invoices/${row.id}`} className="font-semibold text-accent-700 hover:underline">
          {row.invoice_number || row.id.slice(0, 8)}
        </Link>
      ),
    },
    { key: "description", header: "Description", render: (row) => <span className="text-ink-500">{row.description || "—"}</span> },
    { key: "amount", header: "Amount", render: (row) => <span className="whitespace-nowrap font-semibold text-ink-900">{formatMoney(row.amount, { decimals: 4 })} <span className="text-xs font-medium text-ink-400">{row.asset_code || "XLM"}</span></span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    { key: "due_date", header: "Due", render: (row) => <span className="whitespace-nowrap text-ink-400">{formatDate(row.due_date)}</span> },
  ];

  const paymentColumns: Column<Payment>[] = [
    {
      key: "id",
      header: "Payment",
      render: (row) => <span className="font-mono text-xs text-ink-500">{truncateAddress(row.id, 8, 4)}</span>,
    },
    { key: "amount", header: "Amount", render: (row) => <span className="whitespace-nowrap font-semibold text-ink-900">{formatMoney(row.amount, { decimals: 4 })} <span className="text-xs font-medium text-ink-400">{row.asset_code || "XLM"}</span></span> },
    { key: "status", header: "Status", render: (row) => <StatusBadge status={row.status} /> },
    {
      key: "hash",
      header: "Transaction",
      render: (row) => row.hash ? (
        <Link href={`/transactions/${encodeURIComponent(row.hash)}`} className="font-mono text-xs text-accent-700 hover:underline">
          {truncateAddress(row.hash, 8, 4)}
        </Link>
      ) : <span className="text-ink-400">—</span>,
    },
    { key: "created_at", header: "Date", render: (row) => <span className="whitespace-nowrap text-ink-400">{formatDate(row.created_at)}</span> },
  ];

  if (loading) {
    return <div className="ui-card py-16 text-center text-sm text-ink-400" role="status">Loading supplier…</div>;
  }
  if (error) {
    return <div role="alert" className="ui-card border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  }
  if (!data) return null;

  const supplier = data.supplier;

  return (
    <div className="animate-fade-in space-y-5">
      <Link href="/suppliers" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-400 transition-colors hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Back to suppliers
      </Link>

      <PageHeader
        eyebrow="Supplier profile"
        title={supplier.business_name}
        description="Contact details, receiving address and payment history for this supplier."
        actions={
          canManage ? (
            <button type="button" onClick={() => setEditing(true)} className="ui-btn-secondary">
              <Pencil className="h-4 w-4" /> Edit profile
            </button>
          ) : null
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_2fr]">
        <div className="space-y-5">
          <SectionCard title="Supplier details" description="Identity and payment destination">
            <div className="mb-4 flex items-center justify-between gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-control bg-accent-50 text-accent-600" aria-hidden="true">
                <Building2 className="h-5 w-5" />
              </span>
              <StatusBadge status={supplier.status || "active"} />
            </div>
            <dl className="space-y-5 border-t border-line pt-5">
              <div className="flex items-start gap-3">
                <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" aria-hidden="true" />
                <div className="min-w-0">
                  <dt className="ui-kicker">Stellar receiving address</dt>
                  <dd className="mt-1.5 break-all font-mono text-xs text-ink-700">{supplier.wallet_address}</dd>
                </div>
              </div>
              {supplier.contact_name ? (
                <div className="flex items-start gap-3"><Building2 className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" /><div><dt className="ui-kicker">Contact</dt><dd className="mt-1.5 text-sm font-medium text-ink-900">{supplier.contact_name}</dd></div></div>
              ) : null}
              {supplier.email ? (
                <div className="flex items-start gap-3"><Mail className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" /><div><dt className="ui-kicker">Email</dt><dd className="mt-1.5 text-sm text-ink-900">{supplier.email}</dd></div></div>
              ) : null}
              {supplier.phone ? (
                <div className="flex items-start gap-3"><Phone className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" /><div><dt className="ui-kicker">Phone</dt><dd className="mt-1.5 text-sm text-ink-900">{supplier.phone}</dd></div></div>
              ) : null}
              {supplier.country ? (
                <div className="flex items-start gap-3"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" /><div><dt className="ui-kicker">Country</dt><dd className="mt-1.5 text-sm text-ink-900">{supplier.country}</dd></div></div>
              ) : null}
              {supplier.notes ? (
                <div className="border-t border-line pt-4"><dt className="ui-kicker">Internal notes</dt><dd className="mt-1.5 text-sm leading-relaxed text-ink-500">{supplier.notes}</dd></div>
              ) : null}
            </dl>
          </SectionCard>

          {canManage ? (
            <SectionCard
              title="Supplier access"
              description="Invitations use the real supplier invitation endpoints"
              actions={
                <button type="button" onClick={openInvite} className="ui-btn-secondary min-h-[36px] px-3 py-1.5 text-xs">
                  <Send className="h-3.5 w-3.5" /> Invite contact
                </button>
              }
            >
              {invitations.length ? (
                <ul className="space-y-2">
                  {invitations.map((invite) => (
                    <li key={invite.id} className="flex flex-wrap items-center justify-between gap-2 rounded-control border border-line px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-ink-900">{invite.email}</p>
                        <p className="text-2xs text-ink-400">{humanize(invite.role || "supplier")} · Sent {formatDate(invite.created_at)}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusBadge status={invite.status} />
                        {invite.status === "pending" ? (
                          <button
                            type="button"
                            onClick={() => void onRevoke(invite)}
                            disabled={!!revoking}
                            className="min-h-[36px] rounded-control px-2 text-xs font-semibold text-rose-600 hover:bg-rose-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:opacity-50"
                            aria-label={`Revoke invitation for ${invite.email}`}
                          >
                            {revoking === invite.id ? "Revoking…" : "Revoke"}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState compact icon={<ShieldCheck className="h-6 w-6" aria-hidden="true" />} title="No invitations" description="Invite a contact to give them supplier access to this workspace." />
              )}
            </SectionCard>
          ) : null}
        </div>

        <div className="space-y-5">
          <SectionCard title="Invoices" description={`${data.invoices.length} invoice(s) for this supplier`} actions={<Link href="/invoices/new" className="text-xs font-semibold text-accent-700 hover:underline">New invoice</Link>} className="[&>div:last-child]:p-0">
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

      <Modal
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        title="Invite a supplier contact"
        description="The contact must accept the invitation from their own signed-in account."
        size="sm"
        footer={
          issuedToken ? (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  if (!issuedToken.token) return;
                  if (typeof navigator !== "undefined" && navigator.clipboard) {
                    void navigator.clipboard.writeText(issuedToken.token)
                      .then(() => toast.success("Token copied"))
                      .catch(() => toast.info("Copy manually", "Select the token shown above and copy it."));
                  } else {
                    toast.info("Copy manually", "Select the token shown above and copy it.");
                  }
                }}
                disabled={!issuedToken.token}
                className="ui-btn-secondary"
              >
                <Copy className="h-4 w-4" /> Copy access token
              </button>
            </div>
          ) : (
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <button type="button" onClick={() => setInviteOpen(false)} className="ui-btn-secondary">Cancel</button>
              <button type="button" onClick={() => void onInvite()} disabled={inviting || !inviteEmail.trim()} className="ui-btn-accent">
                <Send className="h-4 w-4" /> {inviting ? "Sending…" : "Send invitation"}
              </button>
            </div>
          )
        }
      >
        {issuedToken ? (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-control border border-emerald-200 bg-emerald-50 px-3 py-2.5">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-emerald-800">Invitation created for {issuedToken.email}. The access token is shown once — store it securely before closing this dialog.</p>
            </div>
            <div>
              <p className="ui-kicker">One-time access token</p>
              <p className="mt-1.5 break-all rounded-control border border-line bg-slate-50 p-3 font-mono text-xs text-ink-700">{issuedToken.token || "No token returned"}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <FormField id="invite-email" label="Contact email" hint={supplier.email ? `Must match the supplier contact ${supplier.email}.` : "The address that will receive supplier access."} required>
              <input id="invite-email" type="email" value={inviteEmail} onChange={(event) => setInviteEmail(event.target.value)} className="ui-input" placeholder="jamie@northwind.com" />
            </FormField>
            <div className="flex items-start gap-2 rounded-control border border-accent-100 bg-accent-50 px-3 py-2.5">
              <FileText className="mt-0.5 h-4 w-4 shrink-0 text-accent-600" aria-hidden="true" />
              <p className="text-xs leading-relaxed text-accent-700">Pending invitations can be revoked here. Acceptance and rejection are recorded only when the invited account acts on the token.</p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
