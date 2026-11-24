"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Building2,
  ChevronDown,
  CircleDollarSign,
  FileCheck2,
  FileText,
  Handshake,
  LayoutDashboard,
  LogOut,
  Menu,
  ReceiptText,
  Settings,
  ShieldCheck,
  Wallet,
  X,
} from "lucide-react";
import { useAuth } from "@/app/providers";
import { initials } from "@/lib/format";

interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  exact?: boolean;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, exact: true }],
  },
  {
    label: "Operations",
    items: [
      { href: "/suppliers", label: "Suppliers", icon: Building2 },
      { href: "/invoices", label: "Invoices", icon: FileText },
      { href: "/agreements", label: "Agreements", icon: Handshake },
      { href: "/payments/approve", label: "Approvals", icon: FileCheck2 },
      { href: "/wallet", label: "Wallet", icon: Wallet },
      { href: "/transactions", label: "Transactions", icon: ReceiptText },
    ],
  },
  {
    label: "Insights & settings",
    items: [
      { href: "/reports", label: "Reports", icon: CircleDollarSign },
      { href: "/notifications", label: "Notifications", icon: Bell },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

function isActive(pathname: string, item: NavItem): boolean {
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, businesses, activeBusinessId, selectBusiness, logout, role } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);

  useEffect(() => {
    setMobileOpen(false);
    setSwitcherOpen(false);
  }, [pathname]);

  const currentLabel = useMemo(() => {
    for (const group of NAV_GROUPS) {
      const found = group.items.find((item) => isActive(pathname, item));
      if (found) return found.label;
    }
    return "Workspace";
  }, [pathname]);

  const sidebar = (
    <div className="flex h-full flex-col bg-navy-900 text-white">
      <div className="flex h-16 items-center gap-2.5 border-b border-white/10 px-5">
        <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent-600 shadow-sm" aria-hidden="true">
          <CircleDollarSign className="h-5 w-5" />
        </span>
        <div>
          <p className="font-display text-lg leading-none tracking-tight">BizFlow</p>
          <p className="mt-1 text-[9px] font-medium uppercase tracking-[0.18em] text-white/40">Business payments</p>
        </div>
        <button
          type="button"
          className="ml-auto rounded-lg p-1.5 text-white/70 hover:bg-white/10 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-5" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-6">
            <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-white/35">{group.label}</p>
            <ul className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(pathname, item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200 ease-spring focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 ${
                        active ? "bg-accent-600/20 text-white shadow-[inset_2px_0_0_0_#3B82F6]" : "text-white/60 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      <Icon className={`h-[18px] w-[18px] ${active ? "text-accent-200" : "text-white/40 group-hover:text-white/70"}`} />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-white/10 p-4">
        <div className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2.5">
          <ShieldCheck className="h-4 w-4 text-emerald-400" aria-hidden="true" />
          <div className="text-[11px] leading-tight">
            <p className="font-semibold text-white/90">Stellar Testnet</p>
            <p className="text-white/40">No real funds involved</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="mt-2 flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-white/50 transition hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
        >
          <LogOut className="h-[18px] w-[18px]" />
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F6F8FB]">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[264px] lg:block">{sidebar}</aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-navy-950/60" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <aside className="relative h-full w-[270px] animate-slide-up shadow-modal">{sidebar}</aside>
        </div>
      ) : null}

      <div className="lg:pl-[264px]">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur-md sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-lg p-2 text-slate-600 hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600 lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="hidden min-w-0 sm:block">
            <p className="text-[11px] font-medium uppercase tracking-wider text-slate-400">Workspace</p>
            <p className="truncate text-sm font-semibold text-navy-900">{currentLabel}</p>
          </div>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <span className="hidden items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-700 sm:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              TESTNET
            </span>

            <div className="relative">
              <button
                type="button"
                onClick={() => setSwitcherOpen((open) => !open)}
                aria-expanded={switcherOpen}
                aria-haspopup="listbox"
                className="flex max-w-[190px] items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-sm transition hover:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-navy-900 text-[10px] font-bold text-white">
                  {initials(businesses.find((b) => b.id === activeBusinessId)?.name || "Biz")}
                </span>
                <span className="truncate font-medium text-navy-900">
                  {businesses.find((b) => b.id === activeBusinessId)?.name || "Select business"}
                </span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              </button>
              {switcherOpen ? (
                <div
                  role="listbox"
                  className="absolute right-0 top-full z-40 mt-2 w-64 animate-slide-up overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-modal"
                >
                  {businesses.length ? (
                    businesses.map((business) => (
                      <button
                        key={business.id}
                        type="button"
                        role="option"
                        aria-selected={business.id === activeBusinessId}
                        onClick={() => selectBusiness(business.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition hover:bg-slate-50 ${
                          business.id === activeBusinessId ? "bg-accent-50 text-accent-700" : "text-navy-900"
                        }`}
                      >
                        <span className="truncate">{business.name}</span>
                        <span className="text-[10px] uppercase text-slate-400">{business.role || role}</span>
                      </button>
                    ))
                  ) : (
                    <Link href="/onboarding" className="block rounded-lg px-3 py-2 text-sm text-accent-600 hover:bg-slate-50">
                      Create a business
                    </Link>
                  )}
                </div>
              ) : null}
            </div>

            <Link
              href="/notifications"
              className="rounded-lg p-2 text-slate-500 transition hover:bg-slate-100 hover:text-navy-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600"
              aria-label="Notifications"
            >
              <Bell className="h-5 w-5" />
            </Link>
            <div className="hidden h-8 w-8 items-center justify-center rounded-full bg-accent-100 text-xs font-bold text-accent-700 sm:flex" title={user?.email || ""}>
              {initials(user?.full_name || user?.email || "User")}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
