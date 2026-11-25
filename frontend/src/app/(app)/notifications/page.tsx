"use client";

import { useState } from "react";
import Link from "next/link";
import { Bell, Check, CheckCheck } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { FilterTabs } from "@/components/DataTable";
import { Skeleton } from "@/components/LoadingSkeleton";
import { PageHeader } from "@/components/PageHeader";
import { useToast } from "@/components/ToastProvider";
import { api, getErrorMessage } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
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
          <button type="button" onClick={() => void markAll()} disabled={!!busy || !unread} className="ui-btn-secondary min-h-9">
            <CheckCheck className="h-4 w-4" aria-hidden="true" />
            {busy === "all" ? "Updating…" : "Mark all read"}
          </button>
        }
      />

      {error ? <div role="alert" className="ui-panel mb-4 border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div> : null}

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <FilterTabs value={filter} onChange={setFilter} options={[{ value: "all", label: "All" }, { value: "unread", label: "Unread", count: unread }]} />
        <span className="text-2xs text-ink-400">Showing real workspace records</span>
      </div>

      <section className="ui-card overflow-hidden" aria-label="Notification list">
        {loading ? (
          <div className="divide-y divide-line" role="status" aria-label="Loading notifications">
            {Array.from({ length: 5 }).map((_, index) => (
              <div key={index} className="flex items-start gap-4 px-5 py-4">
                <Skeleton className="h-9 w-9 shrink-0 rounded-control" />
                <div className="w-full flex-1 space-y-2"><Skeleton className="h-3.5 w-1/3" /><Skeleton className="h-3 w-2/3" /></div>
              </div>
            ))}
          </div>
        ) : notifications.length ? (
          <ul className="divide-y divide-line" aria-label="Notifications">
            {notifications.map((notification) => {
              const isRead = notification.is_read ?? notification.read;
              return (
                <li key={notification.id} className={`flex items-start gap-3 px-4 py-4 transition-colors duration-200 ease-smooth hover:bg-canvas sm:gap-4 sm:px-5 ${isRead ? "bg-white" : "bg-accent-50/40"}`}>
                  <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-control ${isRead ? "bg-slate-100 text-ink-400" : "bg-accent-100 text-accent-700"}`} aria-hidden="true">
                    <Bell className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm ${isRead ? "font-medium text-ink-500" : "font-semibold text-ink-900"}`}>{notification.title}</p>
                      {!isRead ? <span className="h-1.5 w-1.5 rounded-full bg-accent-600" aria-label="Unread" /> : null}
                    </div>
                    {notification.message ? <p className="mt-1 text-sm leading-relaxed text-ink-500">{notification.message}</p> : null}
                    <time className="mt-1.5 block text-xs text-ink-400" dateTime={notification.created_at} title={notification.created_at ? formatDateTime(notification.created_at) : undefined}>
                      {formatRelativeTime(notification.created_at)}
                    </time>
                  </div>
                  {!isRead ? (
                    <button
                      type="button"
                      onClick={() => void markRead(notification)}
                      disabled={!!busy}
                      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-ink-400 transition-colors duration-150 hover:bg-emerald-50 hover:text-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:opacity-50"
                      aria-label="Mark as read"
                      title="Mark as read"
                    >
                      {busy === notification.id ? <Check className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon={<Bell className="h-6 w-6" />}
            title={filter === "unread" ? "No unread notifications" : "No notifications yet"}
            description="Payment confirmations, approval requests and agreement updates will appear here."
            action={<Link href="/invoices" className="ui-btn-ghost min-h-9 text-accent-700 hover:text-accent-700">Go to invoices</Link>}
          />
        )}
      </section>
    </div>
  );
}
