"use client";

import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ActivityPoint } from "@/lib/types";
import { toNumber } from "@/lib/format";

export function VolumeChart({ activity }: { activity: ActivityPoint[] }) {
  const data = (activity || []).map((point) => ({
    name: point.label,
    value: toNumber(point.amount),
  }));
  const summary = data.length
    ? `Confirmed payment volume by month: ${data.map((point) => `${point.name}, ${point.value.toLocaleString()} XLM`).join("; ")}.`
    : "No confirmed payment volume recorded yet.";
  return (
    <div>
      <p className="sr-only">{summary}</p>
      <div className="h-72 w-full" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 12, right: 8, left: -10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E8EDF4" vertical={false} />
            <XAxis dataKey="name" tick={{ fill: "#8A97A8", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#8A97A8", fontSize: 11 }} axisLine={false} tickLine={false} width={64} />
            <Tooltip cursor={{ fill: "#EFF6FF" }} contentStyle={{ borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 12 }} formatter={(value: number) => [`${value.toLocaleString()} XLM`, "Volume"]} />
            <Bar dataKey="value" fill="#2563EB" radius={[6, 6, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

const COLORS = ["#2563EB", "#0B1F3A", "#93C5FD", "#CBD5E1", "#1D4ED8", "#64748B"];

export function StatusChart({ segments }: { segments: Array<{ name: string; value: number }> }) {
  const data = segments.filter((segment) => segment.value > 0);
  const summary = data.length
    ? `Settlement split: ${data.map((segment) => `${segment.name}, ${segment.value.toLocaleString()}`).join("; ")}.`
    : "No settlement data available.";
  if (!data.length) return <p className="py-20 text-center text-sm text-slate-400">No data to visualise yet.</p>;
  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row">
      <p className="sr-only">{summary}</p>
      <div className="h-56 w-full sm:w-1/2" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3} stroke="none">
              {data.map((segment, index) => <Cell key={segment.name} fill={COLORS[index % COLORS.length]} />)}
            </Pie>
            <Tooltip contentStyle={{ borderRadius: 10, border: "1px solid #E2E8F0", fontSize: 12 }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="w-full space-y-2.5 sm:w-1/2">
        {data.map((segment, index) => (
          <li key={segment.name} className="flex items-center justify-between gap-3 text-sm">
            <span className="flex items-center gap-2 text-slate-600">
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[index % COLORS.length] }} />
              {segment.name}
            </span>
            <span className="font-semibold text-navy-900">{segment.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
