"use client";

import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ActivityPoint } from "@/lib/types";
import { toNumber } from "@/lib/format";

const axisTick = { fill: "#6B859A", fontSize: 11 };
const gridStroke = "#E3E9EF";
const tooltipStyle = {
  borderRadius: 8,
  border: `1px solid ${gridStroke}`,
  boxShadow: "0 12px 32px rgba(11,31,51,0.12)",
  fontSize: 12,
  color: "#0B1F33",
};

/** Bars are driven only by the backend's monthly_volume map. */
export function VolumeChart({ activity }: { activity: ActivityPoint[] }) {
  const data = (activity || []).map((point) => ({
    name: point.label,
    value: toNumber(point.amount),
  }));
  const summary = data.length
    ? `Confirmed payment volume by month: ${data.map((point) => `${point.name}, ${point.value.toLocaleString()} XLM`).join("; ")}.`
    : "No confirmed payment volume recorded yet.";

  return (
    <div className="space-y-3">
      <p className="sr-only">{summary}</p>
      <div className="h-64 w-full sm:h-72" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 12, right: 8, left: -10, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
            <XAxis
              dataKey="name"
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              label={{ value: "Month", position: "insideBottom", offset: -2, fill: "#6B859A", fontSize: 11 }}
            />
            <YAxis
              tick={axisTick}
              axisLine={false}
              tickLine={false}
              width={64}
              tickFormatter={(value: number) => value.toLocaleString()}
              label={{ value: "XLM", angle: -90, position: "insideLeft", fill: "#6B859A", fontSize: 11 }}
            />
            <Tooltip
              cursor={{ fill: "#EEF7F6" }}
              contentStyle={tooltipStyle}
              formatter={(value: number) => [`${value.toLocaleString()} XLM`, "Volume"]}
            />
            <Bar dataKey="value" fill="#1F8378" radius={[6, 6, 0, 0]} maxBarSize={40} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-center text-2xs text-ink-400">Confirmed settlement volume in XLM, by month</p>
    </div>
  );
}

/** First two colours are kept stable so the legend stays consistent across reports. */
const COLORS = ["#2563EB", "#0B1F3A", "#2E9C8E", "#AED8D2", "#1F8378", "#64748B"];

/** Paid vs outstanding, derived only from backend aggregates. */
export function StatusChart({ segments }: { segments: Array<{ name: string; value: number }> }) {
  const data = segments.filter((segment) => segment.value > 0);
  const summary = data.length
    ? `Settlement split: ${data.map((segment) => `${segment.name}, ${segment.value.toLocaleString()}`).join("; ")}.`
    : "No settlement data available.";

  if (!data.length) return <p className="py-20 text-center text-sm text-ink-400">No data to visualise yet.</p>;

  return (
    <div className="flex flex-col items-center gap-6 sm:flex-row">
      <p className="sr-only">{summary}</p>
      <div className="h-56 w-full sm:w-1/2" role="img" aria-label={summary}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={55} outerRadius={85} paddingAngle={3} stroke="none">
              {data.map((segment, index) => <Cell key={segment.name} fill={COLORS[index % COLORS.length]} />)}
            </Pie>
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(value: number, name: string) => [`${value.toLocaleString()} XLM`, name]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="w-full sm:w-1/2">
        <p className="ui-kicker mb-3">Amount in XLM</p>
        <ul className="space-y-2.5">
          {data.map((segment, index) => (
            <li key={segment.name} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex items-center gap-2 text-ink-500">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: COLORS[index % COLORS.length] }} aria-hidden="true" />
                {segment.name}
              </span>
              <span className="font-semibold tabular-nums text-ink-900">{segment.value}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
