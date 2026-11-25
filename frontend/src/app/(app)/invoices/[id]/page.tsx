"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  Download,
  FileText,
  Loader2,
  Paperclip,
  Pencil,
  Send,
  ShieldCheck,
  Wallet,
  XCircle,
} from "lucide-react";
import { ConfirmModal } from "@/components/ConfirmModal";
import { EditInvoiceModal } from "@/components/EditInvoiceModal";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { SignTransactionModal } from "@/components/SignTransactionModal";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, downloadBlob, getErrorMessage } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney, humanize, toNumber, truncateAddress } from "@/lib/format";
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
const STAGE_KEYS = ["connecting", "preparing", "review", "signing", "submitting"] as const;

function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) {
    return (value as { items: T[] }).items;
  }
  return [];
}

function unwrapPayments(value: unknown): Payment[] {
  return asList<Payment>(value);
}

/** Settlement figures come only from the backend's decimal-string fields. */
function paymentPosition(invoice: Invoice) {
  const total = toNumber(invoice.amount);
  const paid = toNumber(invoice.amount_paid);
  const remaining = invoice.remaining_amount !== undefined
    ? toNumber(invoice.remaining_amount)
    : Math.max(total - paid, 0);
  const percent = total > 0 ? Math.min(100, Math.round((paid / total) * 100)) : 0;
  return { total, paid, remaining, percent };
}

interface InvoiceDetailData {
  invoice: Invoice;
  supplier: Supplier | null;
  payments: Payment[];
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

  // The invoice response has no embedded supplier or payments; load both from
  // their real endpoints so the detail view never shows invented relationships.
  const { data, loading, error, reload, setData } = useApiResource<InvoiceDetailData>(async () => {
    const invoice = await api.get<Invoice>(`/invoices/${id}`);
    const [supplier, payments] = await Promise.all([
      invoice.supplier_id ? api.get<Supplier>(`/suppliers/${invoice.supplier_id}`).catch(() => null) : Promise.resolve(null),
      api.get<unknown>(`/payments?invoice_id=${id}&per_page=100`).then(unwrapPayments),
    ]);
    return { invoice, supplier, payments };
  }, [id]);
  const invoice = data?.invoice;
  const supplier = data?.supplier;
  const payments = data?.payments || [];

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

  if (loading) {
    return <div className="ui-card py-16 text-center text-sm text-ink-400" role="status">Loading invoice…</div>;
  }
  if (error) {
    return <div role="alert" className="ui-card border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  }
  if (!invoice) return null;

  const canManage = can("owner", "admin", "finance_manager");
  const canEdit = canManage && ["draft", "pending"].includes(invoice.status);
  const canPay = canManage && ["draft", "pending", "overdue", "partially_paid"].includes(invoice.status);
  const asset = invoice.asset_code || "XLM";
  const { paid, remaining, percent } = paymentPosition(invoice);
  const isPartial = invoice.status === "partially_paid";
  const currentStageIndex = STAGE_KEYS.findIndex((key) => STAGE_LABELS[key] === stage);

  return (
    <div className="animate-fade-in space-y-5">
      <Link href="/invoices" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-400 transition-colors hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Back to invoices
      </Link>

      <PageHeader
        eyebrow={invoice.invoice_number ? `Invoice ${invoice.invoice_number}` : "Invoice"}
        title={invoice.description || "Invoice detail"}
        description={`Created ${formatDate(invoice.created_at)} · Due ${formatDate(invoice.due_date)}`}
        actions={
          <>
            <button type="button" onClick={onDownload} disabled={busy === "pdf"} className="ui-btn-secondary">
              <Download className="h-4 w-4" /> {busy === "pdf" ? "Preparing…" : "Download PDF"}
            </button>
            {canManage && invoice.status === "draft" ? (
              <button type="button" onClick={onSubmitInvoice} disabled={!!busy} className="ui-btn-secondary">
                <Send className="h-4 w-4" /> {busy === "submit" ? "Submitting…" : "Submit"}
              </button>
            ) : null}
            {canEdit ? (
              <button type="button" onClick={() => setEditing(true)} disabled={!!busy} className="ui-btn-secondary">
                <Pencil className="h-4 w-4" /> Edit
              </button>
            ) : null}
            {canPay ? (
              <>
                <button type="button" onClick={onPay} disabled={!!busy} className="ui-btn-accent">
                  {busy === "pay" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                  {busy === "pay" ? stage || "Working…" : "Pay with Stellar"}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmCancel(true)}
                  disabled={!!busy}
                  className="ui-btn-ghost min-w-[36px] text-rose-600 hover:bg-rose-50"
                  aria-label="Cancel invoice"
                  title="Cancel invoice"
                >
                  <XCircle className="h-4 w-4" />
                </button>
              </>
            ) : null}
          </>
        }
      />

      {signError ? (
        <div role="alert" className="ui-card border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{signError}</div>
      ) : null}

      {busy && stage ? (
        <div className="ui-card p-4" role="status" aria-live="polite">
          <p className="ui-kicker">Transaction progress · {stage}</p>
          <ol className="mt-3 grid gap-2 sm:grid-cols-5">
            {STAGE_KEYS.map((key, index) => {
              const tone = index < currentStageIndex ? "border-accent-200 bg-accent-50 text-accent-700"
                : index === currentStageIndex ? "border-navy-800 bg-navy-900 text-white"
                  : "border-line bg-slate-50 text-ink-400";
              return (
                <li key={key} className={`flex items-center gap-2 rounded-control border px-2.5 py-2 text-2xs font-medium ${tone}`}>
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[9px]" aria-hidden="true">
                    {index < currentStageIndex ? <CheckCircle2 className="h-3 w-3" /> : index + 1}
                  </span>
                  <span className="truncate">{STAGE_LABELS[key]}</span>
                </li>
              );
            })}
          </ol>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-5">
          <SectionCard title="Invoice summary" description="Value, settlement position and parties">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="ui-kicker">Invoice amount</p>
                <p className="mt-2 font-display text-3xl tracking-tight text-ink-900">
                  {formatMoney(invoice.amount, { decimals: 4 })}
                  <span className="ml-2 text-base font-medium text-ink-400">{asset}</span>
                </p>
              </div>
              <StatusBadge status={invoice.status} />
            </div>

            <div className="mt-5 rounded-card border border-line bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="ui-kicker">Settlement progress</p>
                <span className="text-xs font-semibold text-ink-700">{percent}%</span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-200" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label="Invoice settlement progress">
                <div className="h-full rounded-full bg-accent-500 transition-[width] duration-300 ease-spring" style={{ width: `${percent}%` }} />
              </div>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="ui-kicker">Amount paid</p>
                  <p className="mt-1 text-sm font-semibold text-ink-900">{formatMoney(paid, { decimals: 4 })} <span className="text-xs font-medium text-ink-400">{asset}</span></p>
                </div>
                <div className="sm:text-right">
                  <p className="ui-kicker">Outstanding</p>
                  <p className="mt-1 text-sm font-semibold text-ink-900">{formatMoney(remaining, { decimals: 4 })} <span className="text-xs font-medium text-ink-400">{asset}</span></p>
                </div>
              </div>
              <p className="mt-3 border-t border-line pt-3 text-xs leading-relaxed text-ink-500">
                {isPartial
                  ? `Partially paid: ${formatMoney(paid, { decimals: 4 })} has been settled and ${formatMoney(remaining, { decimals: 4 })} ${asset} remains outstanding. The status changes only when on-chain payments are confirmed.`
                  : percent === 100
                    ? "Fully settled. No outstanding balance remains on this invoice."
                    : "No confirmed payment has been applied to this invoice yet."}
              </p>
            </div>

            {canPay ? (
              <div className="mt-5 rounded-card border border-accent-100 bg-accent-50 p-4">
                <label htmlFor="pay-amount" className="ui-label">
                  Payment amount <span className="font-normal normal-case tracking-normal text-ink-500">(leave blank for the full outstanding balance)</span>
                </label>
                <div className="flex items-center gap-2">
                  <input
                    id="pay-amount"
                    inputMode="decimal"
                    value={payAmount}
                    onChange={(event) => setPayAmount(event.target.value)}
                    placeholder={invoice.remaining_amount || invoice.amount}
                    className="ui-input"
                  />
                  <span className="whitespace-nowrap text-sm font-semibold text-ink-700">{asset}</span>
                </div>
                <p className="mt-2 text-xs leading-relaxed text-ink-500">Partial payments are verified on-chain before the status is updated.</p>
              </div>
            ) : null}

            <dl className="mt-6 grid gap-x-6 gap-y-5 border-t border-line pt-5 sm:grid-cols-2">
              <div><dt className="ui-kicker">Supplier</dt><dd className="mt-1.5 text-sm font-medium text-ink-900">{supplier?.business_name || "—"}</dd></div>
              <div><dt className="ui-kicker">Reference</dt><dd className="mt-1.5 text-sm text-ink-900">{invoice.reference || "—"}</dd></div>
              <div><dt className="ui-kicker">Due date</dt><dd className="mt-1.5 text-sm text-ink-900">{formatDate(invoice.due_date)}</dd></div>
              <div><dt className="ui-kicker">Asset issuer</dt><dd className="mt-1.5 truncate font-mono text-xs text-ink-700">{invoice.asset_issuer ? truncateAddress(invoice.asset_issuer) : "Native XLM"}</dd></div>
              {supplier?.wallet_address ? (
                <div className="sm:col-span-2"><dt className="ui-kicker">Receiving address</dt><dd className="mt-1.5 break-all font-mono text-xs text-ink-700">{supplier.wallet_address}</dd></div>
              ) : null}
            </dl>
          </SectionCard>

          {invoice.items?.length ? (
            <SectionCard title="Line items" description="Breakdown recorded on the invoice">
              <div className="overflow-x-auto">
                <table className="ui-table min-w-[480px]">
                  <thead>
                    <tr className="border-b border-line bg-slate-50/60">
                      <th scope="col" className="ui-th">Description</th><th scope="col" className="ui-th text-right">Qty</th>
                      <th scope="col" className="ui-th text-right">Unit price</th><th scope="col" className="ui-th text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {invoice.items.map((item, index) => (
                      <tr key={item.id || index}>
                        <td className="ui-td text-ink-900">{item.description}</td>
                        <td className="ui-td text-right tabular-nums text-ink-500">{String(item.quantity)}</td>
                        <td className="ui-td text-right tabular-nums text-ink-500">{formatMoney(item.unit_price, { decimals: 4 })}</td>
                        <td className="ui-td text-right font-semibold tabular-nums text-ink-900">{formatMoney(Number(item.quantity) * Number(item.unit_price), { decimals: 4 })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </SectionCard>
          ) : null}
        </div>

        <div className="space-y-5">
          <SectionCard title="Payment history" description={`${payments.length} payment record(s)`}>
            {payments.length ? (
              <ul className="space-y-3">
                {payments.map((payment) => (
                  <li key={payment.id} className="rounded-card border border-line p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-ink-900">{formatMoney(payment.amount, { decimals: 4 })} <span className="text-xs font-medium text-ink-400">{payment.asset_code || asset}</span></span>
                      <StatusBadge status={payment.status || "pending"} />
                    </div>
                    <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-ink-400">
                      <span>{formatDate(payment.created_at)}</span>
                      {payment.hash ? (
                        <Link href={`/transactions/${encodeURIComponent(payment.hash)}`} className="font-mono text-accent-700 hover:underline">{truncateAddress(payment.hash, 8, 6)}</Link>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={<Wallet className="h-6 w-6" aria-hidden="true" />} title="No payments yet" description="Confirmed payments will appear here automatically." />
            )}
          </SectionCard>

          <SectionCard title="Approval history" description="Decisions recorded in the audit trail">
            <InvoiceApprovalHistory id={id} />
          </SectionCard>

          <SectionCard title="Attachments" description="Documents stored against this invoice">
            <InvoiceAttachments id={id} canManage={canManage} />
          </SectionCard>
        </div>
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
          onSaved={(updated) => { setData((current) => current ? { ...current, invoice: updated } : current); setEditing(false); }}
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

interface AuditEvent {
  id: string;
  action: string;
  entity_id?: string | null;
  details?: Record<string, unknown> | null;
  created_at?: string;
}

/** Reads real audit records; no approval state is inferred. */
function InvoiceApprovalHistory({ id }: { id: string }) {
  const { data, loading } = useApiResource<unknown>(() => api.get(`/audit-logs?action=invoice&per_page=100`), [id]);
  const events = asList<AuditEvent>(data).filter(
    (event) => event.entity_id === id && /created|submitted|approved|rejected|cancelled|updated/i.test(event.action),
  );
  if (loading) return <p className="py-6 text-center text-xs text-ink-400">Loading approval history…</p>;
  if (!events.length) return <EmptyState compact icon={<ShieldCheck className="h-6 w-6" aria-hidden="true" />} title="No approval activity yet" description="Submitted, approved and rejected decisions will be listed here." />;
  return (
    <ol className="relative space-y-3 border-l border-line pl-5">
      {events.slice(0, 8).map((event) => {
        const reason = typeof event.details?.reason === "string" ? event.details.reason : "";
        return (
          <li key={event.id} className="relative rounded-control border border-line px-3 py-2.5">
            <span className="absolute -left-[25px] top-3 h-2 w-2 rounded-full bg-accent-500 ring-4 ring-white" aria-hidden="true" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-ink-900">{humanize(event.action.replace(/^invoice\./, ""))}</p>
              <p className="text-2xs text-ink-400">{formatDateTime(event.created_at)}</p>
            </div>
            {reason ? <p className="mt-1 text-xs leading-relaxed text-ink-500">{reason}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

interface InvoiceAttachment { id: string; filename: string; content_type?: string; size?: number; created_at?: string; }

/** Lists and downloads documents through the backend's attachment endpoints. */
function InvoiceAttachments({ id, canManage }: { id: string; canManage: boolean }) {
  const toast = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);
  const { data, loading } = useApiResource<unknown>(() => api.get(`/invoices/${id}/attachments`), [id]);
  const attachments = asList<InvoiceAttachment>(data).filter((item) => typeof item.filename === "string");

  const download = async (attachment: InvoiceAttachment) => {
    setDownloading(attachment.id);
    try {
      const { blob, filename } = await api.download(`/invoices/${id}/attachments/${attachment.id}/download`, attachment.filename);
      downloadBlob(blob, filename);
      toast.success("Attachment downloaded", filename);
    } catch (reason) {
      toast.error("Could not download attachment", getErrorMessage(reason));
    } finally {
      setDownloading(null);
    }
  };

  if (loading) return <p className="py-6 text-center text-xs text-ink-400">Loading attachments…</p>;
  if (!attachments.length) return <EmptyState compact icon={<Paperclip className="h-6 w-6" aria-hidden="true" />} title="No attachments yet" description={canManage ? "Documents uploaded through the invoice API appear here." : "Documents attached to this invoice appear here."} />;
  return (
    <ul className="space-y-2">
      {attachments.map((attachment) => (
        <li key={attachment.id} className="flex flex-wrap items-center justify-between gap-3 rounded-control border border-line px-3 py-2.5">
          <div className="flex min-w-0 items-center gap-2.5">
            <FileText className="h-4 w-4 shrink-0 text-accent-600" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-ink-900">{attachment.filename}</p>
              <p className="text-2xs text-ink-400">
                {typeof attachment.size === "number" ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : attachment.content_type || "Document"}
                {attachment.created_at ? ` · ${formatDate(attachment.created_at)}` : ""}
              </p>
            </div>
          </div>
          <button type="button" onClick={() => void download(attachment)} disabled={downloading === attachment.id}
            className="ui-btn-secondary min-h-[36px] px-2.5 py-1.5 text-xs" aria-label={`Download ${attachment.filename}`}>
            {downloading === attachment.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Download
          </button>
        </li>
      ))}
    </ul>
  );
}
