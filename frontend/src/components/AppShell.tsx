"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  Search,
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
  keywords?: string;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [{ href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, exact: true, keywords: "home metrics" }],
  },
  {
    label: "Operations",
    items: [
      { href: "/invoices", label: "Invoices", icon: FileText, keywords: "billing payments" },
      { href: "/suppliers", label: "Suppliers", icon: Building2, keywords: "vendors directory" },
      { href: "/agreements", label: "Agreements", icon: Handshake, keywords: "contracts terms" },
      { href: "/payments/approve", label: "Payments", icon: FileCheck2, keywords: "approvals signing" },
      { href: "/escrow", label: "Escrow", icon: ShieldCheck, keywords: "funding milestones release" },
      { href: "/transactions", label: "Transactions", icon: ReceiptText, keywords: "history ledger" },
      { href: "/wallet", label: "Wallet", icon: Wallet, keywords: "freighter connection" },
    ],
  },
  {
    label: "Insights & settings",
    items: [
      { href: "/reports", label: "Reports", icon: CircleDollarSign, keywords: "analytics exports" },
      { href: "/notifications", label: "Notifications", icon: Bell, keywords: "alerts activity" },
      { href: "/settings", label: "Settings", icon: Settings, keywords: "workspace preferences" },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

function isActive(pathname: string, item: NavItem): boolean {
  return item.exact
    ? pathname === item.href
    : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { user, businesses, activeBusinessId, selectBusiness, logout, role } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMobileOpen(false);
    setSwitcherOpen(false);
    setProfileOpen(false);
    setSearch("");
  }, [pathname]);

  useEffect(() => {
    function close(event: MouseEvent) {
      if (!searchRef.current?.contains(event.target as Node)) setSearch("");
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const currentItem = useMemo(
    () => ALL_ITEMS.find((item) => isActive(pathname, item)),
    [pathname],
  );
  const activeBusiness = businesses.find((business) => business.id === activeBusinessId);
  const results = search.trim()
    ? ALL_ITEMS.filter((item) =>
        `${item.label} ${item.keywords ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : [];

  const sidebar = (
    <div className="flex h-full flex-col bg-navy-900 text-white">
      <div className="flex h-[68px] items-center gap-3 border-b border-white/10 px-5">
        <span className="flex h-9 w-9 items-center justify-center rounded-control bg-accent-600 shadow-sm" aria-hidden="true">
          <CircleDollarSign className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="font-display text-base font-semibold leading-none tracking-tight">BizFlow</p>
          <p className="mt-1.5 text-2xs font-medium uppercase tracking-[0.16em] text-white/40">Business payments</p>
        </div>
        <button
          type="button"
          className="ml-auto rounded-control p-1.5 text-white/70 transition hover:bg-white/10 lg:hidden"
          onClick={() => setMobileOpen(false)}
          aria-label="Close navigation"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-5" aria-label="Main navigation">
        {NAV_GROUPS.map((group) => (
          <div key={group.label} className="mb-6">
            <p className="mb-2 px-3 text-2xs font-semibold uppercase tracking-[0.16em] text-white/35">{group.label}</p>
            <ul className="space-y-0.5">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(pathname, item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`group flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium transition-colors duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 ${
                        active
                          ? "bg-white/10 text-white shadow-[inset_2px_0_0_0_#2E9C8E]"
                          : "text-white/60 hover:bg-white/[0.06] hover:text-white"
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
        <div className="flex items-center gap-2 rounded-control bg-white/5 px-3 py-2.5">
          <ShieldCheck className="h-4 w-4 text-accent-200" aria-hidden="true" />
          <div className="text-[11px] leading-tight">
            <p className="font-semibold text-white/90">Stellar Testnet</p>
            <p className="text-white/40">No real funds involved</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="mt-2 flex w-full items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium text-white/50 transition hover:bg-white/5 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-400"
        >
          <LogOut className="h-[18px] w-[18px]" />
          Sign out
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-canvas">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[260px] lg:block">{sidebar}</aside>
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-navy-950/60" onClick={() => setMobileOpen(false)} aria-hidden="true" />
          <aside className="relative h-full w-[280px] animate-slide-up shadow-modal">{sidebar}</aside>
        </div>
      ) : null}

      <div className="lg:pl-[260px]">
        <header className="sticky top-0 z-30 flex h-[68px] items-center gap-3 border-b border-line bg-white/95 px-4 backdrop-blur sm:px-6 lg:px-8">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            className="rounded-control p-2 text-ink-500 transition hover:bg-slate-100 lg:hidden"
            aria-label="Open navigation"
          >
            <Menu className="h-5 w-5" />
          </button>

          <div className="hidden min-w-0 md:block">
            <p className="ui-kicker">{NAV_GROUPS.find((group) => group.items.includes(currentItem as NavItem))?.label ?? "Workspace"}</p>
            <p className="truncate text-sm font-semibold text-ink-900">{currentItem?.label ?? "Workspace"}</p>
          </div>

          <div ref={searchRef} className="relative ml-auto hidden w-full max-w-[260px] sm:block">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" aria-hidden="true" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search workspace"
              aria-label="Search navigation"
              className="ui-input w-full py-2 pl-9 text-sm"
            />
            {results.length ? (
              <div className="absolute right-0 top-full z-40 mt-2 w-full animate-slide-up overflow-hidden rounded-card border border-line bg-white p-1.5 shadow-raised">
                {results.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setSearch("")}
                    className="flex items-center gap-2 rounded-control px-2.5 py-2 text-sm text-ink-700 hover:bg-slate-50"
                  >
                    <item.icon className="h-4 w-4 text-ink-400" />
                    {item.label}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>

          <div className="ml-auto flex items-center gap-1.5 sm:ml-0 sm:gap-2">
            <span className="hidden items-center gap-1.5 rounded-control border border-accent-200 bg-accent-50 px-2.5 py-1 text-2xs font-semibold text-accent-700 xl:inline-flex">
              <span className="h-1.5 w-1.5 rounded-full bg-accent-500" />
              TESTNET
            </span>

            <div className="relative">
              <button
                type="button"
                onClick={() => setSwitcherOpen((open) => !open)}
                aria-expanded={switcherOpen}
                aria-haspopup="listbox"
                className="flex max-w-[180px] items-center gap-2 rounded-control border border-line bg-white px-2.5 py-1.5 text-sm transition hover:border-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-navy-900 text-[10px] font-bold text-white">
                  {initials(activeBusiness?.name || "Biz")}
                </span>
                <span className="truncate font-medium text-ink-900">{activeBusiness?.name || "Select business"}</span>
                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-ink-400" />
              </button>
              {switcherOpen ? (
                <div
                  role="listbox"
                  className="absolute right-0 top-full z-40 mt-2 w-64 animate-slide-up overflow-hidden rounded-card border border-line bg-white p-1.5 shadow-raised"
                >
                  {businesses.length ? (
                    businesses.map((business) => (
                      <button
                        key={business.id}
                        type="button"
                        role="option"
                        aria-selected={business.id === activeBusinessId}
                        onClick={() => selectBusiness(business.id)}
                        className={`flex w-full items-center justify-between gap-2 rounded-control px-3 py-2 text-left text-sm transition hover:bg-slate-50 ${
                          business.id === activeBusinessId ? "bg-accent-50 text-accent-700" : "text-ink-900"
                        }`}
                      >
                        <span className="truncate">{business.name}</span>
                        <span className="text-2xs uppercase text-ink-400">{business.role || role}</span>
                      </button>
                    ))
                  ) : (
                    <Link href="/onboarding" className="block rounded-control px-3 py-2 text-sm text-accent-700 hover:bg-slate-50">
                      Create a business
                    </Link>
                  )}
                </div>
              ) : null}
            </div>

            <Link href="/wallet" className="hidden items-center gap-1.5 rounded-control px-2.5 py-2 text-sm text-ink-500 transition hover:bg-slate-100 hover:text-ink-900 sm:inline-flex" aria-label="Wallet">
              <Wallet className="h-[18px] w-[18px]" />
              Wallet
            </Link>

            <Link
              href="/notifications"
              className="relative rounded-control p-2 text-ink-500 transition hover:bg-slate-100 hover:text-ink-900 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600"
              aria-label="Notifications"
            >
              <Bell className="h-5 w-5" />
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent-500 ring-2 ring-white" aria-hidden="true" />
            </Link>

            <div className="relative">
              <button
                type="button"
                onClick={() => setProfileOpen((open) => !open)}
                aria-expanded={profileOpen}
                aria-label="User profile"
                title={user?.email || ""}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-accent-100 text-xs font-bold text-accent-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-600"
              >
                {initials(user?.full_name || user?.email || "User")}
              </button>
              {profileOpen ? (
                <div className="absolute right-0 top-full z-40 mt-2 w-56 animate-slide-up overflow-hidden rounded-card border border-line bg-white p-1.5 shadow-raised">
                  <p className="truncate px-3 py-2 text-sm font-semibold text-ink-900">{user?.full_name || "User"}</p>
                  <p className="truncate px-3 pb-2 text-xs text-ink-400">{user?.email}</p>
                  <div className="ui-divider my-1" />
                  <Link href="/settings" onClick={() => setProfileOpen(false)} className="block rounded-control px-3 py-2 text-sm text-ink-700 hover:bg-slate-50">
                    Workspace settings
                  </Link>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 sm:px-6 sm:py-8 lg:px-8">{children}</main>
      </div>
    </div>
  );
}
