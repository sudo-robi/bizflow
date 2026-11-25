"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Unplug,
  Wallet as WalletIcon,
} from "lucide-react";
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

/** Every value here comes from a Freighter call or a backend response. */
function connectionState(installed: boolean | null, address: string | null, isTestnet: boolean) {
  if (installed === null) return { label: "Detecting Freighter…", tone: "border-line bg-slate-50 text-ink-500", icon: Loader2 };
  if (!installed) return { label: "Freighter not installed", tone: "border-line bg-slate-50 text-ink-500", icon: AlertTriangle };
  if (!address) return { label: "Wallet not connected", tone: "border-amber-200 bg-amber-50 text-amber-700", icon: AlertTriangle };
  if (!isTestnet) return { label: "Wrong network", tone: "border-amber-200 bg-amber-50 text-amber-700", icon: AlertTriangle };
  return { label: "Ready to sign on Testnet", tone: "border-emerald-200 bg-emerald-50 text-emerald-700", icon: CheckCircle2 };
}

const STATE_GUIDE = [
  { label: "Wallet not connected", note: "Connect Freighter to share your public address." },
  { label: "Wrong network", note: "Switch Freighter to Testnet before any signature is requested." },
  { label: "Awaiting signature", note: "Review the exact amount, destination and memo in the dialog." },
  { label: "Submitted", note: "The signed XDR was sent by the backend to the network." },
  { label: "Pending confirmation", note: "Horizon has not yet returned a confirmed ledger result." },
  { label: "Confirmed", note: "The backend independently verified the ledger record." },
  { label: "Failed", note: "The transaction did not settle. No balance or receipt is credited." },
];

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
  const state = connectionState(installed, address, isTestnet);
  const StateIcon = state.icon;

  return (
    <div className="animate-fade-in space-y-5">
      <PageHeader
        eyebrow="Operations"
        title="Wallet"
        description="Connect Freighter to sign payments. BizFlow only ever reads your public address — never a private key."
        actions={
          <button onClick={() => void refreshWalletState()} className="ui-btn-secondary">
            <RefreshCw className="h-4 w-4" /> Refresh
          </button>
        }
      />

      <div className="flex items-start gap-3 rounded-card border border-accent-200 bg-accent-50 px-4 py-3 text-sm text-accent-700">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>Balances are public Testnet data. Signing is requested only while Freighter is on Testnet, for the exact transaction you review.</p>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-5">
          <SectionCard title="Freighter connection" description="Detected from the browser extension, not assumed">
            {installed === null ? (
              <div className="flex items-center gap-2 py-8 text-sm text-ink-400"><Loader2 className="h-4 w-4 animate-spin" /> Detecting Freighter…</div>
            ) : !installed ? (
              <EmptyState
                icon={<WalletIcon className="h-6 w-6" />}
                title="Freighter is not installed"
                description="Install the Freighter browser extension to sign Stellar transactions securely from this workspace."
                action={
                  <a href="https://www.freighter.app/" target="_blank" rel="noopener noreferrer" className="ui-btn-accent">
                    Get Freighter <ExternalLink className="h-4 w-4" />
                  </a>
                }
              />
            ) : (
              <div className="space-y-4">
                <div className={`flex flex-wrap items-center justify-between gap-4 rounded-card border p-4 ${state.tone}`}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-10 w-10 items-center justify-center rounded-control bg-navy-900 text-white"><WalletIcon className="h-5 w-5" aria-hidden="true" /></span>
                    <div>
                      <p className="ui-kicker">Connection status</p>
                      <p className="mt-1 flex items-center gap-1.5 text-sm font-semibold">
                        <StateIcon className={`h-4 w-4 ${busy === "connect" ? "animate-spin" : ""}`} aria-hidden="true" />
                        {state.label}
                      </p>
                    </div>
                  </div>
                  {address ? (
                    <button onClick={() => void onDisconnect()} disabled={!!busy} className="ui-btn-secondary text-ink-600">
                      <Unplug className="h-4 w-4" /> Disconnect
                    </button>
                  ) : (
                    <button onClick={() => void onConnect()} disabled={!!busy} className="ui-btn-accent">
                      {busy === "connect" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                      {busy === "connect" ? "Connecting…" : "Connect Freighter"}
                    </button>
                  )}
                </div>

                {address ? (
                  <div className="rounded-card border border-line p-4">
                    <p className="ui-kicker">Public address</p>
                    <div className="mt-2 flex items-start gap-3">
                      <p className="min-w-0 flex-1 break-all font-mono text-sm text-ink-900">{address}</p>
                      <button
                        type="button"
                        onClick={() => { void navigator.clipboard.writeText(address); toast.success("Address copied"); }}
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-ink-400 transition hover:bg-slate-100 hover:text-ink-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500"
                        aria-label="Copy public address"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    </div>
                    <a href={explorerUrl(address)} target="_blank" rel="noopener noreferrer" className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-accent-700 hover:underline">
                      View account on Stellar Expert <ExternalLink className="h-3 w-3" />
                    </a>
                  </div>
                ) : null}
              </div>
            )}
          </SectionCard>

          <SectionCard title="Balances" description="Read from Horizon Testnet (public data)">
            {balanceLoading ? (
              <div className="flex items-center gap-2 py-8 text-sm text-ink-400"><Loader2 className="h-4 w-4 animate-spin" /> Loading balances…</div>
            ) : balanceError ? (
              <div role="alert" className="ui-card border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">{balanceError}</div>
            ) : !address ? (
              <EmptyState compact title="No wallet connected" description="Connect Freighter to view Testnet balances." />
            ) : balances.length ? (
              <ul className="divide-y divide-line">
                {balances.map((balance, index) => (
                  <li key={`${balance.asset}-${index}`} className="flex items-center justify-between gap-4 py-3.5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink-900">{balance.asset}</p>
                      {balance.issuer ? <p className="truncate font-mono text-2xs text-ink-400">{truncateAddress(balance.issuer)}</p> : <p className="text-2xs text-ink-400">Native asset</p>}
                    </div>
                    <p className="font-display text-lg text-ink-900">{formatStellarAmount(balance.balance)}</p>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title="Account is unfunded" description="This Testnet account has no balances yet. Fund it with the Stellar Testnet faucet to make payments." />
            )}
          </SectionCard>
        </div>

        <div className="space-y-5">
          <SectionCard title="Network check" description="Verified through Freighter before signing">
            <div className={`rounded-card border p-4 ${isTestnet ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
              <div className="flex items-start gap-3">
                {isTestnet ? <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" aria-hidden="true" /> : <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" aria-hidden="true" />}
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
            {network ? <p className="mt-3 break-all font-mono text-2xs text-ink-500">{network.networkPassphrase}</p> : null}
            {networkError ? <p role="alert" className="mt-3 text-xs text-rose-600">{networkError}</p> : null}
            <button onClick={() => void onCheckNetwork()} disabled={!!busy || !installed} className="ui-btn-secondary mt-4">
              {busy === "network" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Check network again
            </button>
          </SectionCard>

          <SectionCard title="Registered addresses" description="Public keys saved for this business">
            {walletsLoading ? (
              <p className="py-6 text-center text-2xs text-ink-400">Loading…</p>
            ) : wallets?.length ? (
              <ul className="space-y-3">
                {wallets.map((wallet) => (
                  <li key={wallet.id} className="flex items-center justify-between gap-3 rounded-control border border-line p-3">
                    <div className="min-w-0">
                      <p className="truncate font-mono text-xs text-ink-900">{truncateAddress(wallet.public_key, 10, 8)}</p>
                      <p className="mt-0.5 text-2xs uppercase tracking-wider text-ink-400">{wallet.network || "testnet"}</p>
                    </div>
                    <button onClick={() => void onDisconnect(wallet)} disabled={!!busy} className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control text-ink-400 transition hover:bg-rose-50 hover:text-rose-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500" aria-label="Remove registered address">
                      <Unplug className="h-4 w-4" />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact title="No addresses registered" description="Connected public addresses will be listed here." />
            )}
          </SectionCard>

          <SectionCard title="Status vocabulary" description="How wallet and ledger states are reported">
            <ul className="space-y-2.5">
              {STATE_GUIDE.map((item) => (
                <li key={item.label} className="flex items-start gap-2.5 text-xs leading-relaxed">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" aria-hidden="true" />
                  <span><strong className="font-semibold text-ink-900">{item.label}</strong><span className="text-ink-400"> — {item.note}</span></span>
                </li>
              ))}
            </ul>
          </SectionCard>

          <div className="rounded-card border border-accent-100 bg-accent-50 p-5">
            <ShieldCheck className="h-5 w-5 text-accent-600" aria-hidden="true" />
            <p className="mt-3 text-sm font-semibold text-ink-900">Your keys never leave Freighter</p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              We request a signature for a specific transaction XDR. We never ask for seed phrases, private keys or signing authority beyond the transaction you explicitly approve.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
