"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, setActiveBusinessId } from "@/lib/api";
import type { Business, Membership, Role, User } from "@/lib/types";
import { ToastProvider } from "@/components/ToastProvider";

const STORAGE_KEY = "bizflow.active_business_id";

interface AuthContextValue {
  user: User | null;
  businesses: Business[];
  memberships: Membership[];
  activeBusinessId: string | null;
  activeBusiness: Business | null;
  role: Role | null;
  loading: boolean;
  ready: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  selectBusiness: (id: string) => void;
  logout: () => Promise<void>;
  can: (...allowed: Role[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function Providers({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [activeBusinessId, setActiveBusinessIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const me = await api.get<{ user: User; memberships: Membership[] }>("/auth/me", { public: true });
      const list = await api.get<Business[]>("/businesses", { public: true });
      const safeList = Array.isArray(list) ? list : [];
      setUser(me.user ?? null);
      setMemberships(Array.isArray(me.memberships) ? me.memberships : []);
      setBusinesses(safeList);

      let saved: string | null = null;
      try {
        saved = window.localStorage.getItem(STORAGE_KEY);
      } catch {
        saved = null;
      }
      const next = safeList.find((item) => item.id === saved)?.id ?? safeList[0]?.id ?? null;
      setActiveBusinessIdState(next);
      setActiveBusinessId(next);
    } catch (reason) {
      setUser(null);
      setBusinesses([]);
      setActiveBusinessIdState(null);
      setActiveBusinessId(null);
      setError(reason instanceof Error ? reason.message : "Could not load your workspace.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the module-level header value in sync during render so child pages
  // already send the right X-Business-ID in their first request.
  setActiveBusinessId(activeBusinessId);

  const selectBusiness = useCallback((id: string) => {
    setActiveBusinessIdState(id);
    setActiveBusinessId(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Non-sensitive preference only; storage may be disabled.
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout", undefined, { public: true });
    } catch {
      // Always clear the local session even if the network call fails.
    }
    setActiveBusinessId(null);
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    setUser(null);
    setBusinesses([]);
    router.push("/login");
    router.refresh();
  }, [router]);

  const activeBusiness = useMemo(
    () => businesses.find((item) => item.id === activeBusinessId) ?? null,
    [businesses, activeBusinessId],
  );

  const role = useMemo<Role | null>(() => {
    if (!activeBusinessId) return null;
    const fromList = businesses.find((item) => item.id === activeBusinessId)?.role;
    const fromMembership = memberships.find((entry) => entry.business?.id === activeBusinessId)?.role;
    return (fromList || fromMembership || null) as Role | null;
  }, [activeBusinessId, businesses, memberships]);

  const can = useCallback(
    (...allowed: Role[]) => (role ? allowed.includes(role) : false),
    [role],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      businesses,
      memberships,
      activeBusinessId,
      activeBusiness,
      role,
      loading,
      ready: !loading && !!user && !!activeBusinessId,
      error,
      refresh,
      selectBusiness,
      logout,
      can,
    }),
    [user, businesses, memberships, activeBusinessId, activeBusiness, role, loading, error, refresh, selectBusiness, logout, can],
  );

  return (
    <AuthContext.Provider value={value}>
      <ToastProvider>{children}</ToastProvider>
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside Providers");
  return context;
}
