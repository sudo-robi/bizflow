import { humanize } from "@/lib/format";

type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "purple";

const TONES: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  success: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  warning: "bg-amber-50 text-amber-700 ring-amber-200",
  danger: "bg-rose-50 text-rose-700 ring-rose-200",
  info: "bg-accent-50 text-accent-700 ring-accent-200",
  purple: "bg-violet-50 text-violet-700 ring-violet-200",
};

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  pending: "warning",
  partially_paid: "info",
  paid: "success",
  overdue: "danger",
  cancelled: "neutral",
  awaiting_acceptance: "warning",
  active: "info",
  completed: "success",
  disputed: "danger",
  funded: "purple",
  released: "success",
  approved: "success",
  confirmed: "success",
  successful: "success",
  failed: "danger",
  rejected: "danger",
  unconfirmed: "warning",
  processing: "info",
  verifying: "info",
  submitted: "info",
  archived: "neutral",
  invited: "warning",
  suspended: "danger",
  unread: "info",
  read: "neutral",
};

export function toneForStatus(status: string): Tone {
  const key = status.toLowerCase().replace(/[\s-]+/g, "_");
  return STATUS_TONE[key] ?? "neutral";
}

interface StatusBadgeProps {
  status: string;
  label?: string;
  dot?: boolean;
  className?: string;
}

export function StatusBadge({ status, label, dot = true, className = "" }: StatusBadgeProps) {
  const tone = TONES[toneForStatus(status)];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset ${tone} ${className}`}
    >
      {dot ? <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" /> : null}
      {label ?? humanize(status)}
    </span>
  );
}
