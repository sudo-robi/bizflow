"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, CalendarDays, CheckCircle2, CircleAlert, FileCheck2, Handshake, Loader2, LockKeyhole, Pencil, Wallet } from "lucide-react";
import { ConfirmModal } from "@/components/ConfirmModal";
import { EditAgreementModal } from "@/components/EditAgreementModal";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { SignTransactionModal } from "@/components/SignTransactionModal";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";
import { formatDate, formatMoney } from "@/lib/format";
import {
  buildAndSignEscrowFund,
  buildAndSignMilestoneApproval,
  buildAndSignMilestoneRelease,
  connectWallet,
  getWalletAddress,
} from "@/lib/stellar";
import { useApiResource } from "@/lib/useApiResource";
import type { Agreement, Milestone, TransactionDetails } from "@/lib/types";

const STAGE_LABELS: Record<string, string> = {
  connecting: "Connecting wallet",
  preparing: "Preparing Soroban transaction",
  review: "Awaiting approval",
  signing: "Waiting for Freighter",
  submitting: "Submitting to network",
};

function jsonDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

export default function AgreementDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const toast = useToast();
  const { role, can } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [details, setDetails] = useState<TransactionDetails | null>(null);
  const [signError, setSignError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ title: string; message: string; label: string; tone?: "danger" | "primary"; run: () => Promise<void> } | null>(null);
  const decisionRef = useRef<{ resolve: (value: boolean) => void } | null>(null);

  const { data: agreement, loading, error, reload, setData } = useApiResource<Agreement>(() => api.get(`/agreements/${id}`), [id]);

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
      if (label === "fund" || label.startsWith("approve-") || label.startsWith("release-")) setSignError(message);
      toast.error("Action failed", message);
    } finally {
      setBusy(null);
      setStage("");
    }
  };

  const simpleAction = (path: string, success: string, label: string) =>
    runAction(label, async () => {
      await api.post(`/agreements/${id}${path}`);
      toast.success(success);
      reload();
    });

  const askAction = (config: { title: string; message: string; label: string; path: string; success: string; tone?: "danger" | "primary"; labelKey: string }) =>
    setConfirmAction({
      title: config.title,
      message: config.message,
      label: config.label,
      tone: config.tone,
      run: async () => {
        await api.post(`/agreements/${id}${config.path}`);
        setConfirmAction(null);
        toast.success(config.success);
        reload();
      },
    });

  const ensureWallet = async (): Promise<string> => {
    let source = await getWalletAddress();
    if (!source) {
      toast.info("Connect Freighter", "Approve the connection request to continue.");
      source = await connectWallet();
    }
    return source;
  };

  const onFund = () => runAction("fund", async () => {
    setSignError(null);
    await ensureWallet();
    await buildAndSignEscrowFund({
      agreementId: id,
      amount: agreement?.total_amount,
      confirm: askApproval,
      onProgress: (next) => setStage(STAGE_LABELS[next] || next),
    });
    setDetails(null);
    toast.success("Escrow funded", "The Soroban funding transaction was verified on-chain.");
    reload();
  });

  const onApprove = (milestone: Milestone) => runAction(`approve-${milestone.id}`, async () => {
    setSignError(null);
    await ensureWallet();
    await buildAndSignMilestoneApproval({
      agreementId: id,
      milestoneId: milestone.id,
      confirm: askApproval,
      onProgress: (next) => setStage(STAGE_LABELS[next] || next),
    });
    setDetails(null);
    toast.success("Milestone approved", "The approval was verified on-chain and can now be released.");
    reload();
  });

  const onRelease = (milestone: Milestone) => runAction(`release-${milestone.id}`, async () => {
    setSignError(null);
    await ensureWallet();
    const result = await buildAndSignMilestoneRelease({
      agreementId: id,
      milestoneId: milestone.id,
      confirm: askApproval,
      onProgress: (next) => setStage(STAGE_LABELS[next] || next),
    });
    setDetails(null);
    toast.success("Milestone released", `Soroban payment ${result.id} was submitted.`);
    reload();
  });

  if (loading) return <div className="py-16 text-center text-sm text-slate-500">Loading agreement…</div>;
  if (error) return <div role="alert" className="rounded-lg border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  if (!agreement) return null;

  const isAdmin = can("owner", "admin");
  const isSupplierRole = role === "supplier";
  // funded_amount is a decimal string ("0" when empty); a funding hash is an
  // equally authoritative signal that escrow has been funded on-chain.
  const isFunded = Number(agreement.funded_amount) > 0 || !!agreement.fund_transaction_hash;
  const fundedLabel = Number(agreement.funded_amount) > 0
    ? `${formatMoney(agreement.funded_amount, { decimals: 4 })} ${agreement.asset_code || "XLM"}`
    : agreement.fund_transaction_hash
      ? "Funded (verified on-chain)"
      : "Not funded";
  const milestones = agreement.milestones || [];
  const released = milestones.filter((milestone) => milestone.status === "released").length;

  return (
    <div className="animate-fade-in">
      <Link href="/agreements" className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-navy-900">
        <ArrowLeft className="h-4 w-4" /> Back to agreements
      </Link>

      <PageHeader
        eyebrow={agreement.reference ? `Agreement ${agreement.reference}` : "Agreement"}
        title={agreement.title}
        description={`With ${agreement.supplier?.business_name || "supplier"} · Expires ${formatDate(agreement.expiry_date)}`}
        actions={
          <>
            {isAdmin && agreement.status === "draft" ? (
              <button onClick={() => simpleAction("/submit", "Agreement submitted for acceptance.", "submit")} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50 disabled:opacity-50">
                <FileCheck2 className="h-4 w-4" /> {busy === "submit" ? "Submitting…" : "Submit for acceptance"}
              </button>
            ) : null}
            {isAdmin && agreement.status === "draft" ? (
              <button onClick={() => setEditing(true)} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50 disabled:opacity-50">
                <Pencil className="h-4 w-4" /> Edit
              </button>
            ) : null}
            {isSupplierRole && agreement.status === "awaiting_acceptance" ? (
              <button onClick={() => simpleAction("/accept", "Agreement accepted. It is now active.", "accept")} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3.5 py-2.5 text-sm font-semibold text-white hover:bg-accent-700 disabled:opacity-50">
                <Handshake className="h-4 w-4" /> {busy === "accept" ? "Accepting…" : "Accept agreement"}
              </button>
            ) : null}
            {isSupplierRole && agreement.status === "awaiting_acceptance" ? (
              <button onClick={() => askAction({ title: "Reject agreement?", message: "The business will be notified that you declined this agreement.", label: "Reject agreement", labelKey: "reject", path: "/reject", success: "Agreement rejected.", tone: "danger" })} disabled={!!busy} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-600">Reject</button>
            ) : null}
            {isAdmin && agreement.status === "awaiting_acceptance" ? (
              <button onClick={() => askAction({ title: "Cancel agreement?", message: "This draft agreement will be cancelled.", label: "Cancel agreement", labelKey: "cancel", path: "/cancel", success: "Agreement cancelled.", tone: "danger" })} disabled={!!busy} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-600">Cancel</button>
            ) : null}
            {isAdmin && agreement.status === "active" && !isFunded ? (
              <button onClick={() => void onFund()} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3.5 py-2.5 text-sm font-semibold text-white hover:bg-accent-700 disabled:opacity-60">
                <Wallet className="h-4 w-4" /> {busy === "fund" ? stage || "Funding…" : "Fund escrow"}
              </button>
            ) : null}
            {(isAdmin || isSupplierRole) && agreement.status === "active" ? (
              <button onClick={() => askAction({ title: "Raise a dispute?", message: "This agreement will be marked disputed and milestone releases paused pending review.", label: "Raise dispute", labelKey: "dispute", path: "/dispute", success: "Dispute recorded.", tone: "danger" })} disabled={!!busy} className="rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-600">Dispute</button>
            ) : null}
          </>
        }
      />

      {signError ? <div role="alert" className="mb-5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{signError}</div> : null}

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-5">
          <SectionCard title="Agreement summary">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-slate-500">Total value</p>
                <p className="mt-1 font-display text-3xl tracking-tight text-navy-900">{formatMoney(agreement.total_amount, { decimals: 4 })} <span className="text-lg text-slate-400">{agreement.asset_code || "XLM"}</span></p>
              </div>
              <StatusBadge status={agreement.status} />
            </div>
            <dl className="mt-6 grid gap-5 border-t border-slate-100 pt-5 sm:grid-cols-2">
              <div><dt className="text-xs text-slate-500">Supplier</dt><dd className="mt-1 text-sm font-medium text-navy-900">{agreement.supplier?.business_name || "—"}</dd></div>
              <div><dt className="text-xs text-slate-500">Expiry</dt><dd className="mt-1 text-sm text-navy-900">{formatDate(agreement.expiry_date)}</dd></div>
              <div><dt className="text-xs text-slate-500">Funded</dt><dd className="mt-1 text-sm text-navy-900">{fundedLabel}</dd></div>
              <div><dt className="text-xs text-slate-500">Escrow contract</dt><dd className="mt-1 truncate font-mono text-xs text-navy-900">{agreement.escrow_contract_id || "Not deployed"}</dd></div>
              {agreement.description ? <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Description</dt><dd className="mt-1 text-sm leading-relaxed text-slate-600">{agreement.description}</dd></div> : null}
              {agreement.conditions ? <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Conditions</dt><dd className="mt-1 whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-600">{jsonDisplay(agreement.conditions)}</dd></div> : null}
              {agreement.approval_requirements ? <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Approval requirements</dt><dd className="mt-1 whitespace-pre-wrap font-mono text-xs leading-relaxed text-slate-600">{jsonDisplay(agreement.approval_requirements)}</dd></div> : null}
            </dl>
          </SectionCard>

          <SectionCard title="Milestones" description={`${released} of ${milestones.length} released`}>
            {milestones.length ? (
              <ol className="relative space-y-4 border-l border-slate-200 pl-6">
                {milestones.map((milestone, index) => {
                  const isReleased = milestone.status === "released";
                  const isApproved = milestone.status === "approved";
                  const canApprove = isAdmin && agreement.status === "active" && isFunded && milestone.status === "pending";
                  const canRelease = isAdmin && agreement.status === "active" && isFunded && isApproved;
                  return (
                    <li key={milestone.id} className="relative">
                      <span className={`absolute -left-[31px] top-1 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white ${isReleased ? "bg-emerald-500 text-white" : "bg-slate-200"}`}>
                        {isReleased ? <CheckCircle2 className="h-4 w-4" /> : <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                      </span>
                      <div className="rounded-lg border border-slate-100 p-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-slate-500">Milestone {index + 1}</p>
                            <p className="mt-0.5 text-sm font-semibold text-navy-900">{milestone.description}</p>
                            <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500"><CalendarDays className="h-3.5 w-3.5" /> {formatDate(milestone.due_date)}</p>
                          </div>
                          <div className="text-right">
                            <p className="font-display text-lg text-navy-900">{formatMoney(milestone.amount, { decimals: 4 })}</p>
                            <StatusBadge status={milestone.status || "pending"} />
                          </div>
                        </div>
                        {milestone.release_transaction_hash ? (
                          <Link href={`/transactions/${encodeURIComponent(milestone.release_transaction_hash)}`} className="mt-3 block truncate font-mono text-[11px] text-accent-600 hover:underline">
                            {milestone.release_transaction_hash}
                          </Link>
                        ) : null}
                        {canApprove ? (
                          <button onClick={() => void onApprove(milestone)} disabled={!!busy} className="mt-3 inline-flex items-center gap-2 rounded-lg border border-accent-200 bg-white px-3 py-2 text-xs font-semibold text-accent-700 hover:bg-accent-50 disabled:opacity-50">
                            {busy === `approve-${milestone.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                            {busy === `approve-${milestone.id}` ? stage || "Working…" : "Approve milestone on-chain"}
                          </button>
                        ) : null}
                        {canRelease ? (
                          <button onClick={() => void onRelease(milestone)} disabled={!!busy} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-accent-600 px-3 py-2 text-xs font-semibold text-white hover:bg-accent-700 disabled:opacity-50">
                            {busy === `release-${milestone.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wallet className="h-3.5 w-3.5" />}
                            {busy === `release-${milestone.id}` ? stage || "Working…" : "Release with Stellar"}
                          </button>
                        ) : null}
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <p className="py-8 text-center text-sm text-slate-500">No milestones defined.</p>
            )}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="Escrow status">
            <div className="space-y-4">
              <div className="flex items-start gap-3 rounded-lg border border-slate-100 p-4">
                <LockKeyhole className={`mt-0.5 h-5 w-5 ${isFunded ? "text-emerald-600" : "text-slate-400"}`} />
                <div>
                  <p className="text-sm font-medium text-navy-900">{isFunded ? "Escrow funded" : "Awaiting funding"}</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">
                    {isFunded
                      ? `Funds are held in the escrow contract (${fundedLabel}) until each milestone is released.`
                      : "The buyer must fund escrow with a verified on-chain deposit before milestones can be released."}
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-lg border border-slate-100 p-4">
                <CircleAlert className={`mt-0.5 h-5 w-5 ${agreement.status === "disputed" ? "text-rose-600" : "text-slate-400"}`} />
                <div>
                  <p className="text-sm font-medium text-navy-900">{agreement.status === "disputed" ? "Disputed" : "No active dispute"}</p>
                  <p className="mt-1 text-xs leading-relaxed text-slate-500">Escrow release is paused while an agreement is disputed.</p>
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="On-chain events" description="Audit trail for this agreement">
            <AgreementEvents id={id} />
          </SectionCard>
        </div>
      </div>

      <ConfirmModal
        open={!!confirmAction}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => void confirmAction?.run()}
        title={confirmAction?.title || "Confirm action"}
        message={confirmAction?.message || ""}
        confirmLabel={confirmAction?.label || "Confirm"}
        tone={confirmAction?.tone || "primary"}
        loading={!!busy}
      />

      {editing ? (
        <EditAgreementModal
          agreement={agreement}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setData(updated); setEditing(false); }}
        />
      ) : null}

      <SignTransactionModal
        open={!!details}
        details={details}
        busy={!!busy && !!stage && stage !== "Awaiting approval"}
        stage={stage}
        error={signError}
        onApprove={() => decide(true)}
        onCancel={() => decide(false)}
      />
    </div>
  );
}

function AgreementEvents({ id }: { id: string }) {
  const { data, loading } = useApiResource<unknown[]>(() => api.get(`/agreements/${id}/events`), [id]);
  const events = Array.isArray(data) ? data : ((data as { items?: unknown[] } | null)?.items || []);
  if (loading) return <p className="text-xs text-slate-400">Loading events…</p>;
  if (!events.length) return <p className="py-6 text-center text-xs text-slate-500">No on-chain events recorded yet.</p>;
  return (
    <ul className="space-y-3">
      {events.slice(0, 8).map((event, index) => {
        const record = event as Record<string, unknown>;
        return (
          <li key={index} className="rounded-lg border border-slate-100 p-3">
            <p className="text-xs font-medium text-navy-900">{String(record.event_type || record.type || record.action || "Event")}</p>
            <p className="mt-1 truncate font-mono text-[11px] text-slate-500">{String(record.transaction_hash || record.hash || "")}</p>
            <p className="mt-1 text-[11px] text-slate-400">{formatDate(String(record.created_at || ""))}</p>
          </li>
        );
      })}
    </ul>
  );
}
