"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, ExternalLink, Link2, Loader2, RefreshCw, ShieldCheck, Unplug, Wallet as WalletIcon } from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageHeader, SectionCard } from "@/components/PageHeader";
import { useToast } from "@/components/ToastProvider";
import { api, getErrorMessage } from "@/lib/api";
import { formatStellarAmount, truncateAddress } from "@/lib/format";
import {
  assertTestnet,
  connectWallet,
  explorerUrl,
  getBalances,
  getNetwork,
  getWalletAddress,
  hasFreighterProvider,
  isFreighterInstalled,
  type FreighterNetwork,
} from "@/lib/stellar";
import { useApiResource } from "@/lib/useApiResource";
import type { WalletBalance } from "@/lib/types";

interface ConnectedWallet {
  id: string;
  public_key: string;
  network?: string;
  [key: string]: unknown;
}

export default function WalletPage() {
  const toast = useToast();
  const [installed, setInstalled] = useState<boolean | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetwork] = useState<FreighterNetwork | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [balances, setBalances] = useState<WalletBalance[]>([]);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState<string | null>(null);

  const { data: wallets, loading: walletsLoading, reload: reloadWallets } = useApiResource<ConnectedWallet[]>(() => api.get("/wallets"));

  const loadBalances = async (publicKey: string) => {
    setBalanceLoading(true);
    setBalanceError(null);
    try {
      setBalances(await getBalances(publicKey));
    } catch (reason) {
      setBalanceError(getErrorMessage(reason));
    } finally {
      setBalanceLoading(false);
    }
  };

  const refreshWalletState = async () => {
    const isInstalled = await isFreighterInstalled();
    setInstalled(isInstalled);
    if (!isInstalled) {
      setAddress(null);
      setNetwork(null);
      setBalances([]);
      return;
    }
    const connected = await getWalletAddress();
    setAddress(connected);
    if (connected) void loadBalances(connected);
    try {
      setNetwork(await getNetwork());
      setNetworkError(null);
    } catch (reason) {
      setNetworkError(getErrorMessage(reason));
    }
  };

  useEffect(() => {
    setInstalled(hasFreighterProvider());
    void refreshWalletState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onConnect = async () => {
    setBusy("connect");
    try {
      await assertTestnet();
      const publicKey = await connectWallet();
      setAddress(publicKey);
      setNetwork(await getNetwork());
      setNetworkError(null);
      await api.post("/wallets", { public_key: publicKey, network: "testnet" });
      reloadWallets();
      void loadBalances(publicKey);
      toast.success("Wallet connected", "Public address registered on Stellar Testnet.");
    } catch (reason) {
      const message = getErrorMessage(reason);
      setNetworkError(message);
      toast.error("Could not connect wallet", message);
    } finally {
      setBusy(null);
    }
  };

  const onDisconnect = async (wallet?: ConnectedWallet) => {
    setBusy("disconnect");
    try {
      if (wallet) {
        await api.delete(`/wallets/${wallet.id}`);
        reloadWallets();
      }
      setAddress(null);
      setBalances([]);
      toast.success("Wallet disconnected", "This workspace no longer lists the address.");
    } catch (reason) {
      toast.error("Could not disconnect", getErrorMessage(reason));
    } finally {
      setBusy(null);
    }
  };

  const onCheckNetwork = async () => {
    setBusy("network");
    try {
      setNetwork(await assertTestnet());
      setNetworkError(null);
      toast.success("Testnet confirmed", "Your wallet is on the correct network.");
    } catch (reason) {
      const message = getErrorMessage(reason);
      setNetworkError(message);
      toast.warning("Network mismatch", message);
    } finally {
      setBusy(null);
    }
  };

  const isTestnet = network?.networkPassphrase === "Test SDF Network ; September 2015" || /test\s*net/i.test(network?.network || "");

  return (
    <div className="animate-fade-in">
      <PageHeader
        eyebrow="Operations"
        title="Wallet"
        description="Connect Freighter to sign payments. BizFlow only ever reads your public address — never a private key."
        actions={
          <button onClick={() => void refreshWalletState()} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-navy-900 hover:bg-slate-50">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <SectionCard title="Freighter connection">
            {installed === null ? (
              <div className="flex items-center gap-2 py-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Detecting Freighter…</div>
            ) : !installed ? (
              <EmptyState
                icon={<WalletIcon className="h-6 w-6" />}
                title="Freighter is not installed"
                description="Install the Freighter browser extension to sign Stellar transactions securely from this workspace."
                action={
                  <a href="https://www.freighter.app/" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2 text-sm font-semibold text-white hover:bg-accent-700">
                    Get Freighter <ExternalLink className="h-4 w-4" />
                  </a>
                }
              />
            ) : (
              <div className="space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-100 bg-slate-50/70 p-4">
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-navy-900 text-white"><WalletIcon className="h-5 w-5" /></span>
                    <div>
                      <p className="text-xs text-slate-500">Connection status</p>
                      <p className="mt-0.5 flex items-center gap-1.5 text-sm font-semibold text-navy-900">
                        {address ? <><CheckCircle2 className="h-4 w-4 text-emerald-600" /> Connected</> : "Not connected"}
                      </p>
                    </div>
                  </div>
                  {address ? (
                    <button onClick={() => void onDisconnect()} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-rose-50 hover:text-rose-600 disabled:opacity-50">
                      <Unplug className="h-4 w-4" /> Disconnect
                    </button>
                  ) : (
                    <button onClick={() => void onConnect()} disabled={!!busy} className="inline-flex items-center gap-2 rounded-lg bg-accent-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-accent-700 disabled:opacity-50">
                      {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                      {busy === "connect" ? "Connecting…" : "Connect Freighter"}
                    </button>
                  )}
                </div>

                {address ? (
                  <div className="rounded-xl border border-slate-100 p-4">
                    <p className="text-xs font-medium text-slate-500">Public address</p>
                    <div className="mt-2 flex items-start gap-3">
                      <p className="min-w-0 flex-1 break-all font-mono text-sm text-navy-900">{address}</p>
                      <button
                        type="button"
                        onClick={() => { void navigator.clipboard.writeText(address); toast.success("Address copied"); }}
                        className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-navy-900"
                        aria-label="Copy public address"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                    <a href={explorerUrl(address)} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-accent-600 hover:underline">
                      View account on Stellar Expert <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ) : null}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Balances" description="Read from Horizon Testnet (public data)">
            {balanceLoading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Loading balances…</div>
            ) : balanceError ? (
              <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{balanceError}</div>
            ) : !address ? (
              <EmptyState compact title="No wallet connected" description="Connect Freighter to view Testnet balances." />
            ) : balances.length ? (
              <ul className="divide-y divide-slate-100">
                {balances.map((balance, index) => (
                  <li key={`${balance.asset}-${index}`} className="flex items-center justify-between gap-4 py-3.5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-navy-900">{balance.asset}</p>
                      {balance.issuer ? <p className="truncate font-mono text-[11px] text-slate-400">{truncateAddress(balance.issuer)}</p> : null}
                    </div>
                    <p className="font-display text-lg text-navy-900">{formatStellarAmount(balance.balance)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title="Account is unfunded" description="This Testnet account has no balances yet. Fund it with the Stellar Testnet faucet to make payments." />
            )}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="Network check">
            <div className={`rounded-xl border p-4 ${isTestnet ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
              <div className="flex items-start gap-3">
                {isTestnet ? <ShieldCheck className="mt-0.5 h-5 w-5 text-emerald-600" /> : <AlertTriangle className="mt-0.5 h-5 w-5 text-amber-600" />}
                <div>
                  <p className={`text-sm font-semibold ${isTestnet ? "text-emerald-900" : "text-amber-900"}`}>
                    {isTestnet ? "Testnet verified" : network ? `Wrong network: ${network.network}` : "Network unknown"}
                  </p>
                  <p className={`mt-1 text-xs leading-relaxed ${isTestnet ? "text-emerald-700" : "text-amber-800"}`}>
                    {isTestnet
                      ? "BizFlow will only request signatures while Freighter is on Testnet."
                      : "Switch Freighter to Testnet before signing any transaction."}
                  </p>
                </div>
              </div>
            </div>
            {network ? <p className="mt-3 break-all font-mono text-[11px] text-slate-500">{network.networkPassphrase}</p> : null}
            {networkError ? <p role="alert" className="mt-3 text-xs text-rose-600">{networkError}</p> : null}
            <button onClick={() => void onCheckNetwork()} disabled={!!busy || !installed} className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-navy-900 hover:bg-slate-50 disabled:opacity-50">
              {busy === "network" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Check network again
            </button>
          </SectionCard>

          <SectionCard title="Registered addresses" description="Public keys saved for this business">
            {walletsLoading ? (
              <p className="py-6 text-center text-xs text-slate-400">Loading…</p>
            ) : wallets?.length ? (
              <ul className="space-y-3">
                {wallets.map((wallet) => (
                  <li key={wallet.id} className="flex items-center justify-between gap-3 rounded-lg border border-slate-100 p-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-navy-900">{truncateAddress(wallet.public_key, 10, 8)}</p>
                      <p className="mt-0.5 text-[11px] uppercase text-slate-400">{wallet.network || "testnet"}</p>
                    </div>
                    <button onClick={() => void onDisconnect(wallet)} disabled={!!busy} className="rounded-md p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Remove registered address">
                      <Unplug className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title="No addresses registered" description="Connected public addresses will be listed here." />
            )}
          </SectionCard>

          <div className="rounded-xl border border-accent-100 bg-accent-50 p-5">
            <ShieldCheck className="h-5 w-5 text-accent-600" />
            <p className="mt-3 text-sm font-semibold text-navy-900">Your keys never leave Freighter</p>
            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              We request a signature for a specific transaction XDR. We never ask for seed phrases, private keys or signing authority beyond the transaction you explicitly approve.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
