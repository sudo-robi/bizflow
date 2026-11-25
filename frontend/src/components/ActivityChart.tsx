"use client";

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ActivityPoint } from "@/lib/types";
import { toNumber } from "@/lib/format";

/** Area trend built from backend-provided activity points, never synthetic data. */
export default function ActivityChart({ activity }: { activity: ActivityPoint[] }) {
  const data = (activity || []).map((point) => ({
    name: point.label,
    amount: toNumber(point.amount),
  }));
  const summary = data.length
    ? `Settled volume by month: ${data.map((point) => `${point.name}, ${point.amount.toLocaleString()} XLM`).join("; ")}.`
    : "No settled volume recorded yet.";

  return (
    <div className="space-y-3">
      <p className="sr-only">{summary}</p>
      <div className="h-56 w-full sm:h-64" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 12, right: 8, left: -18, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#E3E9EF" vertical={false} />
            <XAxis
              dataKey="name"
              tick={{ fill: "#6B859A", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              label={{ value: "Month", position: "insideBottom", offset: -2, fill: "#6B859A", fontSize: 11 }}
            />
            <YAxis
              tick={{ fill: "#6B859A", fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={64}
              tickFormatter={(value: number) => value.toLocaleString()}
              label={{ value: "XLM", angle: -90, position: "insideLeft", fill: "#6B859A", fontSize: 11 }}
            />
            <Tooltip
              contentStyle={{
                borderRadius: 8,
                border: "1px solid #E3E9EF",
                boxShadow: "0 12px 32px rgba(11,31,51,0.12)",
                fontSize: 12,
                color: "#0B1F33",
              }}
              formatter={(value: number, name: string) => [name === "amount" ? `${value.toLocaleString()} XLM` : value, name === "amount" ? "Volume" : "Payments"]}
            />
            <Area
              type="monotone"
              dataKey="amount"
              stroke="#1F8378"
              strokeWidth={2.5}
              fill="#D6EBE8"
              activeDot={{ r: 5, fill: "#1F8378", stroke: "#fff", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <p className="text-center text-2xs text-ink-400">Confirmed volume in XLM, by month</p>
    </div>
  );
}
