"use client";

import { useState } from "react";
import Link from "next/link";
import { Bell, Check, CheckCheck } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { FilterTabs } from "@/components/DataTable";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/components/ToastProvider";
import { api, getErrorMessage } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { useApiResource } from "@/lib/useApiResource";
import type { Notification } from "@/lib/types";

type Filter = "all" | "unread";

function unwrap(value: unknown): Notification[] {
  if (Array.isArray(value)) return value as Notification[];
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) return (value as { items: Notification[] }).items;
  return [];
}

export default function NotificationsPage() {
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const { data, loading, error, reload, setData } = useApiResource<unknown>(() => api.get(`/notifications${filter === "unread" ? "?unread_only=true" : ""}`), [filter]);
  const notifications = unwrap(data);
  const unread = notifications.filter((item) => !(item.is_read ?? item.read)).length;

  const markRead = async (notification: Notification) => {
    setBusy(notification.id);
    try {
      await api.patch(`/notifications/${notification.id}/read`);
      reload();
    } catch (reason) {
      toast.error("Could not update notification", getErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const markAll = async () => {
    setBusy("all");
    try {
      await api.patch("/notifications/read-all");
      setData((current: unknown) => unwrap(current).map((item) => ({ ...item, is_read: true })));
      toast.success("All notifications marked as read");
    } catch (reason) {
      toast.error("Could not update notifications", getErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Workspace"
        title="Notifications"
        description={`Stay on top of approvals, settlements and agreement updates.${unread ? ` ${unread} unread.` : ""}`}
        actions={
          <button onClick={() => void markAll()} disabled={!!busy || !unread} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50 disabled:opacity-50">
            <CheckCheck className="h-4 w-4" /> {busy === "all" ? "Updating…" : "Mark all read"}
          </button>
        }
      />

      {error ? <div role="alert" className="mb-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <div className="mb-4">
        <FilterTabs value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unread", label: "Unread", count: unread }]} />
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
        {loading ? (
          <div className="divide-y divide-slate-100">
            {Array.from({ length: 5 }).map((_, index) => <div key={index} className="h-20 animate-pulse bg-slate-50/60" />)}
          </div>
        ) : notifications.length ? (
          <ul className="divide-y divide-slate-100">
            {notifications.map((notification) => {
              const isRead = notification.is_read ?? notification.read;
              return (
                <li key={notification.id} className={`flex items-start gap-4 px-5 py-4 transition-colors hover:bg-slate-50/70 ${isRead ? "" : "bg-accent-50/30"}`}>
                  <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${isRead ? "bg-slate-100 text-slate-400" : "bg-accent-100 text-accent-600"}`}>
                    <Bell className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm ${isRead ? "font-medium text-slate-700" : "font-semibold text-navy-900"}`}>{notification.title}</p>
                      {!isRead ? <span className="h-1.5 w-1.5 rounded-full bg-accent-600" aria-label="Unread" /> : null}
                    </div>
                    {notification.message ? <p className="mt-1 text-sm leading-relaxed text-slate-600">{notification.message}</p> : null}
                    <p className="mt-1.5 text-xs text-slate-400">{formatRelativeTime(notification.created_at)}</p>
                  </div>
                  {!isRead ? (
                    <button onClick={() => void markRead(notification)} disabled={!!busy} className="rounded-lg p-2 text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-600 disabled:opacity-50" aria-label="Mark as read" title="Mark as read">
                      {busy === notification.id ? <Check className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState icon={<Bell className="h-6 w-6" />} title={filter === "unread" ? "No unread notifications" : "No notifications yet"} description="Payment confirmations, approval requests and agreement updates will appear here." action={<Link href="/invoices" className="text-sm font-semibold text-accent-600 hover:underline">Go to invoices</Link>} />
        )}
      </div>
    </div>
  );
}
