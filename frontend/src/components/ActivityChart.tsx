"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ActivityPoint } from "@/lib/types";
import { toNumber } from "@/lib/format";

export default function ActivityChart({ activity }: { activity: ActivityPoint[] }) {
  const data = (activity || []).map((point) => ({
    name: point.label,
    amount: toNumber(point.amount),
  }));
  const summary = data.length
    ? `Settled volume by month: ${data.map((point) => `${point.name}, ${point.amount.toLocaleString()} XLM`).join("; ")}.`
    : "No settled volume recorded yet.";

  return (
    <div>
      <p className="sr-only">{summary}</p>
      <div className="h-64 w-full" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: 0 }}>
            <defs>
              <linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#2563EB" stopOpacity={0.22} />
                <stop offset="100%" stopColor="#2563EB" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#E8EDF4" vertical={false} />
            <XAxis dataKey="name" tick={{ fill: "#8A97A8", fontSize: 11 }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fill: "#8A97A8", fontSize: 11 }} axisLine={false} tickLine={false} width={64} />
            <Tooltip
              contentStyle={{ borderRadius: 10, border: "1px solid #E2E8F0", boxShadow: "0 12px 32px rgba(10,37,64,0.12)", fontSize: 12 }}
              formatter={(value: number, name: string) => [name === "amount" ? `${value.toLocaleString()} XLM` : value, name === "amount" ? "Volume" : "Payments"]}
            />
            <Area type="monotone" dataKey="amount" stroke="#2563EB" strokeWidth={2.5} fill="url(#activityFill)" activeDot={{ r: 5, fill: "#2563EB", stroke: "#fff", strokeWidth: 2 }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
