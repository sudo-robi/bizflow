"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  ArrowUpRight,
  CalendarDays,
  Check,
  CheckCircle2,
  CircleAlert,
  ExternalLink,
  FileCheck2,
  Handshake,
  Loader2,
  LockKeyhole,
  Pencil,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { ConfirmModal } from "@/components/ConfirmModal";
import { EmptyState } from "@/components/EmptyState";
import { EditAgreementModal } from "@/components/EditAgreementModal";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { SignTransactionModal } from "@/components/SignTransactionModal";
import { StatusBadge } from "@/components/StatusBadge";
import { useToast } from "@/components/ToastProvider";
import { useAuth } from "@/app/providers";
import { api, getErrorMessage } from "@/lib/api";
import { formatDate, formatDateTime, formatMoney, humanize, truncateAddress } from "@/lib/format";
import {
  buildAndSignEscrowFund,
  buildAndSignMilestoneApproval,
  buildAndSignMilestoneRelease,
  connectWallet,
  explorerUrl,
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
const STAGE_KEYS = ["connecting", "preparing", "review", "signing", "submitting"] as const;

function jsonDisplay(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/** Every label below is derived from backend milestone state — never inferred from a timer. */
function milestoneState(status?: string): { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral" } {
  const key = (status || "pending").toLowerCase();
  if (key === "released") return { label: "Released on-chain", tone: "success" };
  if (key === "approved") return { label: "Approved, awaiting release", tone: "info" };
  if (key === "disputed" || key === "rejected") return { label: "On hold", tone: "danger" };
  if (key === "paid") return { label: "Paid", tone: "success" };
  return { label: "Awaiting approval", tone: "neutral" };
}

const STATE_TILE: Record<string, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-700",
  info: "border-accent-200 bg-accent-50 text-accent-700",
  warning: "border-amber-200 bg-amber-50 text-amber-700",
  danger: "border-rose-200 bg-rose-50 text-rose-700",
  neutral: "border-line bg-slate-50 text-ink-500",
};

export default function AgreementDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const toast = useToast();
  const { role, can, activeBusiness } = useAuth();
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

  if (loading) return <div className="py-16 text-center text-sm text-ink-400">Loading agreement…</div>;
  if (error) return <div role="alert" className="ui-card border-rose-200 bg-rose-50 p-4 text-sm text-rose-700">{error}</div>;
  if (!agreement) return null;

  const isAdmin = can("owner", "admin");
  const isSupplierRole = role === "supplier";
  // funded_amount is a decimal string ("0" when empty); a funding hash recorded
  // by the backend is an equally authoritative signal that escrow was verified.
  const isFunded = Number(agreement.funded_amount) > 0 || !!agreement.fund_transaction_hash;
  const fundedLabel = Number(agreement.funded_amount) > 0
    ? `${formatMoney(agreement.funded_amount, { decimals: 4 })} ${agreement.asset_code || "XLM"}`
    : agreement.fund_transaction_hash
      ? "Funded (verified on-chain)"
      : "Not funded";
  const milestones = agreement.milestones || [];
  const released = milestones.filter((milestone) => milestone.status === "released").length;
  const progress = milestones.length ? Math.round((released / milestones.length) * 100) : 0;
  const currentStageKey = STAGE_KEYS.find((key) => STAGE_LABELS[key] === stage);
  const currentStageIndex = currentStageKey ? STAGE_KEYS.indexOf(currentStageKey) : -1;

  return (
    <div className="animate-fade-in space-y-5">
      <Link href="/agreements" className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-400 transition-colors hover:text-ink-900">
        <ArrowLeft className="h-4 w-4" /> Back to agreements
      </Link>

      <PageHeader
        eyebrow={agreement.reference ? `Agreement ${agreement.reference}` : "Agreement"}
        title={agreement.title}
        description={`With ${agreement.supplier?.business_name || "supplier"} · Expires ${formatDate(agreement.expiry_date)}`}
        actions={
          <>
            {isAdmin && agreement.status === "draft" ? (
              <button onClick={() => simpleAction("/submit", "Agreement submitted for acceptance.", "submit")} disabled={!!busy} className="ui-btn-secondary">
                <FileCheck2 className="h-4 w-4" /> {busy === "submit" ? "Submitting…" : "Submit for acceptance"}
              </button>
            ) : null}
            {isAdmin && agreement.status === "draft" ? (
              <button onClick={() => setEditing(true)} disabled={!!busy} className="ui-btn-secondary">
                <Pencil className="h-4 w-4" /> Edit
              </button>
            ) : null}
            {isSupplierRole && agreement.status === "awaiting_acceptance" ? (
              <button onClick={() => simpleAction("/accept", "Agreement accepted. It is now active.", "accept")} disabled={!!busy} className="ui-btn-accent">
                <Handshake className="h-4 w-4" /> {busy === "accept" ? "Accepting…" : "Accept agreement"}
              </button>
            ) : null}
            {isSupplierRole && agreement.status === "awaiting_acceptance" ? (
              <button onClick={() => askAction({ title: "Reject agreement?", message: "The business will be notified that you declined this agreement.", label: "Reject agreement", labelKey: "reject", path: "/reject", success: "Agreement rejected.", tone: "danger" })} disabled={!!busy} className="ui-btn-ghost text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                Reject
              </button>
            ) : null}
            {isAdmin && agreement.status === "awaiting_acceptance" ? (
              <button onClick={() => askAction({ title: "Cancel agreement?", message: "This draft agreement will be cancelled.", label: "Cancel agreement", labelKey: "cancel", path: "/cancel", success: "Agreement cancelled.", tone: "danger" })} disabled={!!busy} className="ui-btn-ghost text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                Cancel
              </button>
            ) : null}
            {isAdmin && agreement.status === "active" && !isFunded ? (
              <button onClick={() => void onFund()} disabled={!!busy} className="ui-btn-accent">
                <Wallet className="h-4 w-4" /> {busy === "fund" ? stage || "Funding…" : "Fund escrow"}
              </button>
            ) : null}
            {(isAdmin || isSupplierRole) && agreement.status === "active" ? (
              <button onClick={() => askAction({ title: "Raise a dispute?", message: "This agreement will be marked disputed and milestone releases paused pending review.", label: "Raise dispute", labelKey: "dispute", path: "/dispute", success: "Dispute recorded.", tone: "danger" })} disabled={!!busy} className="ui-btn-ghost text-rose-600 hover:bg-rose-50 hover:text-rose-700">
                Dispute
              </button>
            ) : null}
          </>
        }
      />

      {signError ? <div role="alert" className="ui-card border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{signError}</div> : null}

      {busy && stage ? (
        <div className="ui-card p-4" role="status" aria-live="polite">
          <p className="ui-kicker">Transaction progress · {stage}</p>
          <ol className="mt-3 grid gap-2 sm:grid-cols-5">
            {STAGE_KEYS.map((key, index) => (
              <li key={key} className={`flex items-center gap-2 rounded-control border px-2.5 py-2 text-2xs font-medium ${index < currentStageIndex ? "border-accent-200 bg-accent-50 text-accent-700" : index === currentStageIndex ? "border-navy-800 bg-navy-900 text-white" : "border-line bg-slate-50 text-ink-400"}`}>
                <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-current text-[9px]">
                  {index < currentStageIndex ? <Check className="h-3 w-3" /> : index + 1}
                </span>
                <span className="truncate">{STAGE_LABELS[key]}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-[1.5fr_1fr]">
        <div className="space-y-5">
          <SectionCard title="Agreement summary" description="Parties, value and funding position">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="ui-kicker">Total value</p>
                <p className="mt-2 font-display text-3xl tracking-tight text-ink-900">
                  {formatMoney(agreement.total_amount, { decimals: 4 })}
                  <span className="ml-2 text-base font-medium text-ink-400">{agreement.asset_code || "XLM"}</span>
                </p>
              </div>
              <StatusBadge status={agreement.status} />
            </div>
            <dl className="mt-5 grid gap-x-6 gap-y-5 border-t border-line pt-5 sm:grid-cols-2">
              <div>
                <dt className="ui-kicker">Supplier</dt>
                <dd className="mt-1.5 flex items-center gap-2 text-sm font-medium text-ink-900">
                  <Handshake className="h-4 w-4 text-accent-600" aria-hidden="true" />
                  {agreement.supplier?.business_name || "—"}
                </dd>
              </div>
              <div>
                <dt className="ui-kicker">Buyer</dt>
                <dd className="mt-1.5 text-sm font-medium text-ink-900">{activeBusiness?.name || "Your workspace"}</dd>
              </div>
              <div>
                <dt className="ui-kicker">Expiry</dt>
                <dd className="mt-1.5 flex items-center gap-1.5 text-sm text-ink-900"><CalendarDays className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" /> {formatDate(agreement.expiry_date)}</dd>
              </div>
              <div>
                <dt className="ui-kicker">Funding status</dt>
                <dd className="mt-1.5 text-sm font-medium text-ink-900">{fundedLabel}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="ui-kicker">Escrow contract</dt>
                <dd className="mt-1.5 break-all font-mono text-xs text-ink-700">{agreement.escrow_contract_id || "Not deployed"}</dd>
              </div>
              {agreement.description ? <div className="sm:col-span-2"><dt className="ui-kicker">Description</dt><dd className="mt-1.5 text-sm leading-relaxed text-ink-700">{agreement.description}</dd></div> : null}
              {agreement.conditions ? <div className="sm:col-span-2"><dt className="ui-kicker">Conditions</dt><dd className="mt-1.5 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-ink-700">{jsonDisplay(agreement.conditions)}</dd></div> : null}
              {agreement.approval_requirements ? <div className="sm:col-span-2"><dt className="ui-kicker">Approval requirements</dt><dd className="mt-1.5 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-ink-700">{jsonDisplay(agreement.approval_requirements)}</dd></div> : null}
            </dl>
          </SectionCard>

          <SectionCard
            title="Milestone timeline"
            description={`${released} of ${milestones.length} released · progress derived from milestone state`}
            actions={<span className="rounded-control bg-slate-100 px-2 py-1 text-xs font-semibold text-ink-600">{progress}%</span>}
          >
            {milestones.length ? (
              <>
                <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} aria-label="Milestones released">
                  <div className="h-full rounded-full bg-accent-500 transition-[width] duration-300 ease-spring" style={{ width: `${progress}%` }} />
                </div>
                <ol className="relative space-y-4 border-l border-line pl-6">
                  {milestones.map((milestone, index) => {
                    const isReleased = milestone.status === "released";
                    const isApproved = milestone.status === "approved";
                    const state = milestoneState(milestone.status);
                    const canApprove = isAdmin && agreement.status === "active" && isFunded && milestone.status === "pending";
                    const canRelease = isAdmin && agreement.status === "active" && isFunded && isApproved;
                    return (
                      <li key={milestone.id} className="relative">
                        <span className={`absolute -left-[31px] top-1 flex h-4 w-4 items-center justify-center rounded-full ring-4 ring-white ${isReleased ? "bg-emerald-500 text-white" : isApproved ? "bg-accent-500 text-white" : milestone.status === "disputed" ? "bg-rose-500 text-white" : "bg-slate-300"}`} aria-hidden="true">
                          {isReleased || isApproved ? <Check className="h-3 w-3" /> : <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                        </span>
                        <div className="rounded-card border border-line bg-white p-4 transition-colors duration-150 hover:border-accent-200">
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0">
                              <p className="ui-kicker">Milestone {index + 1}</p>
                              <p className="mt-1 text-sm font-semibold text-ink-900">{milestone.description}</p>
                              <p className="mt-1.5 flex items-center gap-1.5 text-xs text-ink-400">
                                <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" /> Due {formatDate(milestone.due_date)}
                              </p>
                            </div>
                            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                              <span className="font-display text-lg text-ink-900">{formatMoney(milestone.amount, { decimals: 4 })}</span>
                              <StatusBadge status={milestone.status || "pending"} />
                            </div>
                          </div>
                          <div className="mt-4 grid gap-2 border-t border-line pt-3 text-xs sm:grid-cols-3">
                            <div><p className="ui-kicker">State</p><p className="mt-1 font-medium text-ink-700">{state.label}</p></div>
                            <div><p className="ui-kicker">Approval</p><p className="mt-1 font-medium text-ink-700">{isApproved || isReleased ? "Approved on-chain" : "Not yet approved"}</p></div>
                            <div><p className="ui-kicker">Release</p><p className="mt-1 font-medium text-ink-700">{isReleased ? `Released ${formatDateTime(milestone.released_at)}` : "Pending"}</p></div>
                          </div>
                          {milestone.release_transaction_hash ? (
                            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-control border border-accent-100 bg-accent-50 px-3 py-2">
                              <span className="ui-kicker">Release transaction</span>
                              <Link href={`/transactions/${encodeURIComponent(milestone.release_transaction_hash)}`} className="font-mono text-2xs font-medium text-accent-700 hover:underline">
                                {truncateAddress(milestone.release_transaction_hash, 10, 8)}
                              </Link>
                              <a href={explorerUrl(milestone.release_transaction_hash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-2xs font-medium text-accent-700 hover:underline" aria-label="View release on Stellar Expert">
                                <ExternalLink className="h-3 w-3" /> Explorer
                              </a>
                            </div>
                          ) : null}
                          {canApprove || canRelease ? (
                            <div className="mt-3 flex flex-wrap gap-2">
                              {canApprove ? (
                                <button onClick={() => void onApprove(milestone)} disabled={!!busy} className="ui-btn-secondary border-accent-200 text-accent-700">
                                  {busy === `approve-${milestone.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                                  {busy === `approve-${milestone.id}` ? stage || "Working…" : "Approve milestone on-chain"}
                                </button>
                              ) : null}
                              {canRelease ? (
                                <button onClick={() => void onRelease(milestone)} disabled={!!busy} className="ui-btn-accent">
                                  {busy === `release-${milestone.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                                  {busy === `release-${milestone.id}` ? stage || "Working…" : "Release with Stellar"}
                                </button>
                              ) : null}
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </>
            ) : (
              <EmptyState compact title="No milestones defined" description="Add milestones when creating an agreement to track deliveries separately." />
            )}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="Escrow status" description="Funding and dispute position">
            <div className="space-y-3">
              <div className={`flex items-start gap-3 rounded-card border p-4 ${isFunded ? "border-emerald-200 bg-emerald-50" : "border-line bg-slate-50"}`}>
                <LockKeyhole className={`mt-0.5 h-5 w-5 shrink-0 ${isFunded ? "text-emerald-600" : "text-ink-400"}`} aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-ink-900">{isFunded ? "Escrow funded" : "Awaiting funding"}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-500">
                    {isFunded
                      ? `Funds are held in the escrow contract (${fundedLabel}) until each milestone is released.`
                      : "The buyer must fund escrow with a verified on-chain deposit before milestones can be released."}
                  </p>
                </div>
              </div>
              <div className={`flex items-start gap-3 rounded-card border p-4 ${agreement.status === "disputed" ? "border-rose-200 bg-rose-50" : "border-line bg-slate-50"}`}>
                <CircleAlert className={`mt-0.5 h-5 w-5 shrink-0 ${agreement.status === "disputed" ? "text-rose-600" : "text-ink-400"}`} aria-hidden="true" />
                <div>
                  <p className="text-sm font-semibold text-ink-900">{agreement.status === "disputed" ? "Disputed" : "No active dispute"}</p>
                  <p className="mt-1 text-xs leading-relaxed text-ink-500">Escrow release is paused while an agreement is disputed.</p>
                </div>
              </div>
              <div className="flex items-start gap-3 rounded-card border border-accent-100 bg-accent-50 p-4">
                <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-accent-600" aria-hidden="true" />
                <p className="text-xs leading-relaxed text-accent-700">A release is shown as complete only when the backend reports the milestone as released with a recorded transaction hash.</p>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="Transaction references" description="Hashes returned by the backend, never generated in the browser">
            <TransactionReferences agreement={agreement} />
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

function TransactionReferences({ agreement }: { agreement: Agreement }) {
  const references: Array<{ label: string; hash: string }> = [];
  if (agreement.fund_transaction_hash) references.push({ label: "Escrow funding", hash: agreement.fund_transaction_hash });
  for (const milestone of agreement.milestones || []) {
    if (milestone.release_transaction_hash) references.push({ label: milestone.description, hash: milestone.release_transaction_hash });
  }
  if (!references.length) return <EmptyState compact title="No transaction references yet" description="Funding and release hashes appear here after a verified on-chain action." />;
  return (
    <ul className="space-y-2">
      {references.map((reference, index) => (
        <li key={`${reference.hash}-${index}`} className="rounded-control border border-line px-3 py-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-ink-700">{reference.label}</span>
            <span className={`rounded-control px-1.5 py-0.5 text-2xs font-semibold ${STATE_TILE.success}`}>Verified</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <Link href={`/transactions/${encodeURIComponent(reference.hash)}`} className="font-mono text-2xs text-accent-700 hover:underline">
              {truncateAddress(reference.hash, 12, 10)}
            </Link>
            <a href={explorerUrl(reference.hash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-2xs text-accent-700 hover:underline" aria-label="View transaction on Stellar Expert">
              <ArrowUpRight className="h-3 w-3" /> Explorer
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}

function AgreementEvents({ id }: { id: string }) {
  const { data, loading } = useApiResource<unknown[]>(() => api.get(`/agreements/${id}/events`), [id]);
  const events = Array.isArray(data) ? data : ((data as { items?: unknown[] } | null)?.items || []);
  if (loading) return <p className="py-6 text-center text-xs text-ink-400">Loading events…</p>;
  if (!events.length) return <EmptyState compact title="No on-chain events recorded yet" description="Contract events will appear here as the agreement progresses." />;
  return (
    <ol className="relative space-y-3 border-l border-line pl-5">
      {events.slice(0, 8).map((event, index) => {
        const record = event as Record<string, unknown>;
        const eventHash = String(record.transaction_hash || record.hash || "");
        return (
          <li key={index} className="relative rounded-control border border-line px-3 py-2.5">
            <span className="absolute -left-[25px] top-3 h-2 w-2 rounded-full bg-accent-500 ring-4 ring-white" aria-hidden="true" />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-ink-900">{humanize(String(record.event_type || record.type || record.action || "Event"))}</p>
              <p className="text-2xs text-ink-400">{formatDateTime(String(record.created_at || ""))}</p>
            </div>
            {eventHash ? <p className="mt-1 break-all font-mono text-2xs text-ink-500">{eventHash}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
