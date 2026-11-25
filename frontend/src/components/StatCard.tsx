import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";

interface StatCardProps {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
  trend?: { value: string; direction: "up" | "down" };
  accent?: "blue" | "green" | "amber" | "slate";
}

const iconTone = {
  blue: "bg-accent-50 text-accent-600",
  green: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  slate: "bg-slate-100 text-slate-600",
};

export function StatCard({ label, value, hint, icon, trend, accent = "blue" }: StatCardProps) {
  return (
    <div className="ui-card p-5 transition-colors duration-150 hover:border-accent-200">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</p>
        {icon ? (
          <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${iconTone[accent]}`} aria-hidden="true">
            {icon}
          </span>
        ) : null}
      </div>
      <p className="ui-metric mt-4 leading-none sm:text-[28px]">{value}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {trend ? (
          <span
            className={`inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-xs font-medium ${
              trend.direction === "up" ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
            }`}
          >
            {trend.direction === "up" ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
            {trend.value}
          </span>
        ) : null}
        {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
      </div>
    </div>
  );
}
