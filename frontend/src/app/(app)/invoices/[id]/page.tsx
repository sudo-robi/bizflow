"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Download, Loader2, Pencil, Send, Wallet, XCircle } from "lucide-react";
import { ConfirmModal } from "@/components/ConfirmModal";
import { EditInvoiceModal } from "@/components/EditInvoiceModal";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { SignTransactionModal } from "@/components/SignTransactionModal";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, downloadBlob, getErrorMessage } from "@/lib/api";
import { formatDate, formatMoney, truncateAddress } from "@/lib/format";
import { buildAndSignPayment, connectWallet, getWalletAddress } from "@/lib/stellar";
import { useApiResource } from "@/lib/useApiResource";
import type { Invoice, Payment, Supplier, TransactionDetails } from "@/lib/types";

const STAGE_LABELS: Record<string, string> = {
  connecting: "Connecting wallet",
  preparing: "Preparing transaction",
  review: "Awaiting approval",
  signing: "Waiting for Freighter",
  submitting: "Submitting to network",
};

function unwrapPayments(value: unknown): Payment[] {
  if (Array.isArray(value)) return value as Payment[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) return (value as { items: Payment[] }).items;
  return [];
}

export default function InvoiceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const toast = useToast();
  const { can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [editing, setEditing] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const decisionRef = useRef<{ resolve: (value: boolean) => void } | null>(null);

  const { data: invoice, loading, error, reload, setData } = useApiResource<Invoice>(() => api.get(`/invoices/${id}`), [id]);
  // The invoice response has no embedded supplier or payments; load both from
  // their real endpoints so the detail view never shows invented relationships.
  const { data: supplier } = useApiResource<Supplier>(
    () => api.get<Supplier>(`/suppliers/${invoice?.supplier_id}`),
    [invoice?.supplier_id],
    !!invoice?.supplier_id,
  );
  const { data: paymentsData } = useApiResource<unknown>(() => api.get(`/payments?invoice_id=${id}&per_page=100`), [id]);

  const askApproval = (transaction: TransactionDetails): Promise<boolean> =>
    new Promise((resolve) => {
      setDetails(transaction);
      decisionRef.current = { resolve };
    });

  const decide = (approved: boolean) => {
    decisionRef.current?.resolve(approved);
    decisionRef.current = null;
    if (!approved) setDetails(null);
  };

  const runAction = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    try {
      await action();
    } catch (reason) {
      const message = getErrorMessage(reason);
      if (label === "pay") setSignError(message);
      toast.error("Action failed", message);
    } finally {
      setBusy(null);
      setStage("");
    }
  };

  const onSubmitInvoice = () => runAction("submit", async () => {
    await api.post(`/invoices/${id}/submit`);
    toast.success("Invoice submitted", "It is now awaiting payment approval.");
    reload();
  });

  const onCancelInvoice = () => runAction("cancel", async () => {
    await api.post(`/invoices/${id}/cancel`);
    setConfirmCancel(false);
    toast.success("Invoice cancelled");
    reload();
  });

  const onDownload = () => runAction("pdf", async () => {
    const { blob, filename } = await api.download(`/invoices/${id}/pdf`, `invoice-${invoice?.invoice_number || id}.pdf`);
    downloadBlob(blob, filename);
    toast.success("Invoice downloaded");
  });

  const onPay = () => runAction("pay", async () => {
    if (!invoice) return;
    setSignError(null);
    let source = await getWalletAddress();
    if (!source) {
      toast.info("Connect Freighter", "Approve the connection request to continue.");
      source = await connectWallet();
    }
    const result = await buildAndSignPayment({
      invoiceId: invoice.id,
      sourceAccount: source,
      ...(payAmount.trim() ? { amount: payAmount.trim() } : {}),
      confirm: askApproval,
      onProgress: (next) => setStage(STAGE_LABELS[next] || next),
    });
    setDetails(null);
    toast.success("Payment submitted", `Payment ${result.id} was submitted to Stellar Testnet.`);
    reload();
  });

  if (loading) return <div className="py-16 text-center text-sm text-slate-500">Loading invoice…</div>;
  if (error) return <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  if (!invoice) return null;

  const payments = unwrapPayments(paymentsData);
  const canEdit = can("owner", "admin", "finance_manager") && ["draft", "pending"].includes(invoice.status);

  return (
    <div className="animate-fade-in">
      <Link href="/invoices" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-navy-900">
        <ArrowLeft className="h-4 w-4" /> Back to invoices
      </Link>

      <PageHeader
        eyebrow={invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : "Invoice"}
        title={invoice.description || "Invoice detail"}
        description={`Created ${formatDate(invoice.created_at)} · Due ${formatDate(invoice.due_date)}`}
        actions={
          <>
            <button onClick={onDownload} disabled={busy === "pdf"} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50 disabled:opacity-50">
              <Download className="h-4 w-4" /> {busy === "pdf" ? "Preparing…" : "Download PDF"}
            </button>
            {can("owner", "admin", "finance_manager") && invoice.status === "draft" ? (
              <button onClick={onSubmitInvoice} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50 disabled:opacity-50">
                <Send className="h-4 w-4" /> Submit
              </button>
            ) : null}
            {canEdit ? (
              <button onClick={() => setEditing(true)} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50 disabled:opacity-50">
                <Pencil className="h-4 w-4" /> Edit
              </button>
            ) : null}
            {can("owner", "admin", "finance_manager") && ["draft", "pending", "overdue", "partially_paid"].includes(invoice.status) ? (
              <>
                <button
                  onClick={onPay}
                  disabled={!!busy}
                  className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-accent-700 disabled:opacity-60"
                >
                  {busy === "pay" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                  {busy === "pay" ? stage || "Working…" : "Pay with Stellar"}
                </button>
                <button onClick={() => setConfirmCancel(true)} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-2.5 text-slate-500 hover:bg-rose-50 hover:text-rose-600" aria-label="Cancel invoice" title="Cancel invoice">
                  <XCircle className="h-4 w-4" />
                </button>
              </>
            ) : null}
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-5">
          <SectionCard title="Invoice summary">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500">Amount due</p>
                <p className="mt-1 font-display text-3xl tracking-tight text-navy-900">
                  {formatMoney(invoice.amount, { decimals: 4 })} <span className="text-lg text-slate-400">{invoice.asset_code || "XLM"}</span>
                </p>
                <p className="mt-1 text-xs text-slate-500">
                  Paid {formatMoney(invoice.amount_paid || "0", { decimals: 4 })} · Outstanding {formatMoney(invoice.remaining_amount || invoice.amount, { decimals: 4 })}
                </p>
              </div>
              <StatusBadge status={invoice.status} />
            </div>
            {can("owner", "admin", "finance_manager") && ["draft", "pending", "overdue", "partially_paid"].includes(invoice.status) ? (
              <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
                <label htmlFor="pay-amount" className="block text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Payment amount (leave blank for full outstanding balance)
                </label>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    id="pay-amount"
                    inputMode="decimal"
                    value={payAmount}
                    onChange={(event) => setPayAmount(event.target.value)}
                    placeholder={invoice.remaining_amount || invoice.amount}
                    className="w-full rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm text-navy-900 outline-none focus:border-accent-600 focus:ring-2 focus:ring-accent-100"
                  />
                  <span className="text-sm font-medium text-slate-500">{invoice.asset_code || "XLM"}</span>
                </div>
                <p className="mt-2 text-xs text-slate-500">Partial payments are verified on-chain before the invoice status changes.</p>
              </div>
            ) : null}
            <dl className="mt-6 grid gap-5 border-t border-slate-100 pt-5 sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">Supplier</dt><dd className="mt-1 text-sm font-medium text-navy-900">{supplier?.business_name || "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Reference</dt><dd className="mt-1 text-sm text-navy-900">{invoice.reference || "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Due date</dt><dd className="mt-1 text-sm text-navy-900">{formatDate(invoice.due_date)}</dd></div>
              <div><dt className="text-xs text-slate-500">Asset issuer</dt><dd className="mt-1 truncate font-mono text-xs text-navy-900">{invoice.asset_issuer ? truncateAddress(invoice.asset_issuer) : "Native XLM"}</dd></div>
              {supplier?.wallet_address ? (
                <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Receiving address</dt><dd className="mt-1 break-all font-mono text-xs text-navy-900">{supplier.wallet_address}</dd></div>
              ) : null}
            </dl>
          </SectionCard>

          {invoice.items?.length ? (
            <SectionCard title="Line items">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead><tr className="border-b border-slate-100 text-left text-[11px] uppercase tracking-wider text-slate-500"><th className="pb-2">Description</th><th className="pb-2 text-right">Qty</th><th className="pb-2 text-right">Unit price</th><th className="pb-2 text-right">Total</th></tr></thead>
                  <tbody className="divide-y divide-slate-50">
                    {invoice.items.map((item, index) => (
                      <tr key={item.id || index}>
                        <td className="py-3 text-navy-900">{item.description}</td>
                        <td className="py-3 text-right text-slate-600">{String(item.quantity)}</td>
                        <td className="py-3 text-right text-slate-600">{formatMoney(item.unit_price, { decimals: 4 })}</td>
                        <td className="py-3 text-right font-medium text-navy-900">{formatMoney(Number(item.quantity) * Number(item.unit_price), { decimals: 4 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ) : null}
        </div>

        <SectionCard title="Payment history" description={`${payments.length} record(s)`}>
          {payments.length ? (
            <ul className="space-y-3">
              {payments.map((payment) => (
                <li key={payment.id} className="rounded-lg border border-slate-100 p-3.5">
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-medium text-navy-900">{formatMoney(payment.amount, { decimals: 4 })}</span>
                    <StatusBadge status={payment.status || "pending"} />
                  </div>
                  <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                    <span>{formatDate(payment.created_at)}</span>
                    {payment.hash ? (
                      <Link href={`/transactions/${encodeURIComponent(payment.hash)}`} className="font-mono text-accent-600 hover:underline">
                        {truncateAddress(payment.hash, 6, 4)}
                      </Link>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-10 text-center">
              <Wallet className="mx-auto h-8 w-8 text-slate-300" />
              <p className="mt-3 text-sm font-medium text-navy-900">No payments yet</p>
              <p className="mt-1 text-xs text-slate-500">Confirmed payments will appear here automatically.</p>
            </div>
          )}
        </SectionCard>
      </div>

      <ConfirmModal
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={onCancelInvoice}
        title="Cancel this invoice?"
        message="This invoice will be marked cancelled. Only invoices with no confirmed payments can be cancelled."
        confirmLabel="Cancel invoice"
        tone="danger"
        loading={busy === "cancel"}
      />

      {editing ? (
        <EditInvoiceModal
          invoice={invoice}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setData(updated); setEditing(false); }}
        />
      ) : null}

      <SignTransactionModal
        open={!!details}
        details={details}
        busy={busy === "pay" && !!stage && stage !== "Awaiting approval"}
        stage={stage}
        error={signError}
        onApprove={() => decide(true)}
        onCancel={() => decide(false)}
      />
    </div>
  );
}
