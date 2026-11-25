/**
 * Real Stellar / Freighter integration. Testnet only.
 *
 * Security rules enforced here:
 *  - No private keys, seed phrases or secrets are ever requested, read or stored.
 *  - The wallet must be on Testnet before any signature is requested.
 *  - The user sees the full, parsed transaction and must explicitly approve it.
 *  - Transaction hashes come from the backend / signed transaction, never invented.
 */

import { Networks, TransactionBuilder } from "@stellar/stellar-sdk";
import {
  getAddress as freighterGetAddress,
  getNetwork as freighterGetNetwork,
  isConnected as freighterIsConnected,
  requestAccess as freighterRequestAccess,
  signTransaction as freighterSignTransaction,
} from "@stellar/freighter-api";
import { api, getErrorMessage } from "./api";
import { formatStellarAmount, stroopsToXlm, truncateAddress } from "./format";
import type { Payment, PreparedPayment, TransactionDetails, WalletBalance } from "./types";

export const TESTNET_PASSPHRASE = Networks.TESTNET;
export const HORIZON_URL = "https://horizon-testnet.stellar.org";
export const EXPLORER_BASE = "https://stellar.expert/explorer/testnet/tx";

export type WalletErrorCode =
  | "NOT_INSTALLED"
  | "NOT_CONNECTED"
  | "ACCESS_DENIED"
  | "NETWORK_MISMATCH"
  | "REJECTED"
  | "CANCELLED"
  | "ACCOUNT_MISMATCH"
  | "SIGNING_FAILED"
  | "ERROR";

export class WalletError extends Error {
  readonly code: WalletErrorCode;

  constructor(message: string, code: WalletErrorCode = "ERROR") {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

type FreighterResult = { error?: { message?: string; code?: number } };

function freighterMessage(result: FreighterResult, fallback: string): string {
  return result.error?.message || fallback;
}

function isRejection(message: string): boolean {
  return /reject|denied|declin|cancel|abort/i.test(message);
}

/** Synchronous detection using the injected provider; safe to call during render. */
export function hasFreighterProvider(): boolean {
  if (typeof window === "undefined") return false;
  const win = window as Window & { freighter?: unknown; freighterApi?: unknown };
  return Boolean(win.freighter || win.freighterApi);
}

export async function isFreighterInstalled(): Promise<boolean> {
  if (hasFreighterProvider()) return true;
  if (typeof window === "undefined") return false;
  try {
    const result = await freighterIsConnected();
    return !result.error && result.isConnected;
  } catch {
    return false;
  }
}

/** Requests access and returns the connected public key. Never returns a secret. */
export async function connectWallet(): Promise<string> {
  if (!(await isFreighterInstalled())) {
    throw new WalletError("Freighter is not installed. Install the Freighter browser extension to continue.", "NOT_INSTALLED");
  }
  try {
    const access = await freighterRequestAccess();
    if (!access.error && access.address) return access.address;

    const address = await freighterGetAddress();
    if (address.error || !address.address) {
      const message = freighterMessage(address, "Wallet access was not granted.");
      throw new WalletError(isRejection(message) ? "You declined the wallet connection request." : message, "ACCESS_DENIED");
    }
    return address.address;
  } catch (error) {
    if (error instanceof WalletError) throw error;
    const message = getErrorMessage(error);
    throw new WalletError(isRejection(message) ? "You declined the wallet connection request." : message, "ACCESS_DENIED");
  }
}

/** Returns the currently connected public key, or null when not connected. */
export async function getWalletAddress(): Promise<string | null> {
  if (!(await isFreighterInstalled())) return null;
  try {
    const result = await freighterGetAddress();
    return result.error || !result.address ? null : result.address;
  } catch {
    return null;
  }
}

export interface FreighterNetwork {
  network: string;
  networkPassphrase: string;
}

export async function getNetwork(): Promise<FreighterNetwork> {
  try {
    const result = await freighterGetNetwork();
    if (result.error) throw new WalletError(freighterMessage(result, "Could not read the wallet network."), "ERROR");
    return { network: result.network || "Unknown", networkPassphrase: result.networkPassphrase || "" };
  } catch (error) {
    if (error instanceof WalletError) throw error;
    throw new WalletError(getErrorMessage(error), "ERROR");
  }
}

export async function assertTestnet(): Promise<FreighterNetwork> {
  const network = await getNetwork();
  // The passphrase is the authoritative network identity. A wallet that merely
  // *names* its network "testnet" must not be accepted for signing.
  const isTestnet = network.networkPassphrase === TESTNET_PASSPHRASE;
  if (!isTestnet) {
    throw new WalletError(
      `Freighter is connected to "${network.network}". BizFlow only settles on Stellar Testnet — switch networks in Freighter and try again.`,
      "NETWORK_MISMATCH",
    );
  }
  return network;
}

/** Requests a real signature. The XDR is produced by the backend, never here. */
export async function signTransaction(xdr: string, address?: string): Promise<string> {
  await assertTestnet();
  try {
    const result = await freighterSignTransaction(xdr, {
      networkPassphrase: TESTNET_PASSPHRASE,
      ...(address ? { address } : {}),
    });
    if (result.error) {
      const message = freighterMessage(result, "Freighter could not sign this transaction.");
      throw new WalletError(isRejection(message) ? "You rejected the signature request in Freighter." : message, isRejection(message) ? "REJECTED" : "SIGNING_FAILED");
    }
    if (!result.signedTxXdr) {
      throw new WalletError("Freighter returned an empty signature. Nothing was submitted.", "SIGNING_FAILED");
    }
    return result.signedTxXdr;
  } catch (error) {
    if (error instanceof WalletError) throw error;
    const message = getErrorMessage(error);
    throw new WalletError(isRejection(message) ? "You rejected the signature request in Freighter." : message, isRejection(message) ? "REJECTED" : "SIGNING_FAILED");
  }
}

/** Parses the unsigned XDR so the confirmation modal shows actual on-chain data. */
export function parseTransactionDetails(xdr: string, fallbackHash?: string): TransactionDetails {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, TESTNET_PASSPHRASE);
    const inner = "innerTransaction" in tx ? tx.innerTransaction : tx;
    const operations = (inner as unknown as { operations: Array<Record<string, unknown>> }).operations ?? [];

    let destination = "—";
    let amount = "—";
    let asset = "XLM";
    let assetIssuer: string | null = null;
    let operationType = "payment";

    for (const op of operations) {
      const type = String(op.type ?? "unknown");
      operationType = type;
      if (type === "payment" || type === "pathPaymentStrictReceive" || type === "pathPaymentStrictSend") {
        const dest = op.destination;
        const rawAmount = type === "payment" ? op.amount : op.destAmount ?? op.destMin ?? op.amount;
        const opAsset = op.asset ?? op.destAsset;
        destination = typeof dest === "string" ? dest : "—";
        amount = rawAmount === undefined ? "—" : formatStellarAmount(String(rawAmount));
        if (opAsset && typeof opAsset === "object") {
          const a = opAsset as { isNative?: () => boolean; code?: string; issuer?: string };
          if (a.isNative?.()) {
            asset = "XLM";
            assetIssuer = null;
          } else {
            asset = a.code ?? "Unknown";
            assetIssuer = a.issuer ?? null;
          }
        }
        break;
      }
      if (type === "invokeHostFunction") {
        const func = op.func as { name?: string; contractId?: string } | undefined;
        operationType = func?.name ? `Soroban: ${String(func.name).replace(/_/g, " ")}` : "Soroban invoke";
        destination = func?.contractId ? truncateAddress(String(func.contractId), 8, 8) : "Escrow contract";
        break;
      }
    }

    const memoObject = (inner as unknown as { memo?: { value?: unknown } }).memo;
    const memoValue = memoObject?.value;
    const memo = typeof memoValue === "string" && memoValue ? memoValue : memoValue ? String(memoValue) : "(none)";
    const fee = stroopsToXlm(tx.fee);
    let hash = fallbackHash || "";
    if (!hash) {
      try {
        hash = tx.hash().toString("hex");
      } catch {
        hash = "";
      }
    }

    return {
      source: String(inner.source ?? "—"),
      destination,
      amount,
      asset,
      assetIssuer,
      memo,
      fee,
      network: "Stellar Testnet",
      hash,
      operationType,
    };
  } catch {
    return {
      source: "Available in Freighter before signing",
      destination: "Available in Freighter before signing",
      amount: "—",
      asset: "—",
      memo: "(none)",
      fee: "—",
      network: "Stellar Testnet",
      hash: fallbackHash || "",
      operationType: "unknown",
    };
  }
}

async function ensureWalletAddress(preferred?: string): Promise<string> {
  await assertTestnet();
  const address = (await getWalletAddress()) || (await connectWallet());
  if (preferred && address !== preferred) {
    throw new WalletError(
      `The connected wallet (${truncateAddress(address)}) does not match the payment source (${truncateAddress(preferred)}). Switch accounts in Freighter and try again.`,
      "ACCOUNT_MISMATCH",
    );
  }
  return address;
}

export interface BuildAndSignPaymentOptions {
  invoiceId: string;
  sourceAccount: string;
  /** Optional partial-payment amount. Omit to settle the full outstanding balance. */
  amount?: string;
  /** Called with the real parsed transaction; resolve true only on explicit user approval. */
  confirm: (details: TransactionDetails) => Promise<boolean>;
  onProgress?: (stage: "connecting" | "preparing" | "review" | "signing" | "submitting") => void;
}

/** Full prepare -> explicit confirmation -> sign -> submit flow for an invoice. */
export async function buildAndSignPayment(options: BuildAndSignPaymentOptions): Promise<Payment> {
  const { invoiceId, sourceAccount, amount, confirm, onProgress } = options;
  onProgress?.("connecting");
  const address = await ensureWalletAddress(sourceAccount);

  onProgress?.("preparing");
  const prepared = await api.post<PreparedPayment>("/payments/prepare", {
    invoice_id: invoiceId,
    source_account: address,
    ...(amount ? { amount } : {}),
  });
  if (!prepared?.xdr || !prepared?.payment_id) {
    throw new WalletError("The backend did not return a transaction to sign. No payment was made.", "ERROR");
  }

  const details = parseTransactionDetails(prepared.xdr, prepared.hash);
  onProgress?.("review");
  const approved = await confirm(details);
  if (!approved) throw new WalletError("Transaction cancelled. Nothing was signed or submitted.", "CANCELLED");

  onProgress?.("signing");
  const signedXdr = await signTransaction(prepared.xdr, address);

  onProgress?.("submitting");
  return api.post<Payment>(`/payments/${prepared.payment_id}/submit`, { signed_xdr: signedXdr });
}

export interface EscrowActionOptions {
  agreementId: string;
  milestoneId?: string;
  amount?: string;
  confirm: (details: TransactionDetails) => Promise<boolean>;
  onProgress?: (stage: "connecting" | "preparing" | "review" | "signing" | "submitting") => void;
}

/** Helper shared by escrow fund / approve / release: prepare, show, sign, submit. */
async function runEscrowFlow(
  options: EscrowActionOptions,
  path: string,
  submitPath: string,
): Promise<Payment> {
  const { agreementId, milestoneId, amount, confirm, onProgress } = options;
  onProgress?.("connecting");
  const address = await ensureWalletAddress();
  onProgress?.("preparing");
  const prepared = await api.post<PreparedPayment>(path, {
    source_account: address,
    ...(amount ? { amount } : {}),
  });
  if (!prepared?.xdr || !prepared?.payment_id) {
    throw new WalletError("The backend did not return a Soroban transaction to sign.", "ERROR");
  }
  const details = parseTransactionDetails(prepared.xdr, prepared.hash);
  onProgress?.("review");
  if (!(await confirm(details))) {
    throw new WalletError("Transaction cancelled. Nothing was signed or submitted.", "CANCELLED");
  }
  onProgress?.("signing");
  const signedXdr = await signTransaction(prepared.xdr, address);
  onProgress?.("submitting");
  return api.post<Payment>(submitPath, { signed_xdr: signedXdr });
}

export function buildAndSignEscrowFund(options: EscrowActionOptions): Promise<Payment> {
  return runEscrowFlow(
    options,
    `/agreements/${options.agreementId}/prepare-fund`,
    `/agreements/${options.agreementId}/fund-escrow`,
  );
}

export function buildAndSignMilestoneApproval(options: EscrowActionOptions): Promise<Payment> {
  if (!options.milestoneId) throw new WalletError("milestoneId is required", "ERROR");
  return runEscrowFlow(
    options,
    `/agreements/${options.agreementId}/milestones/${options.milestoneId}/prepare-approve`,
    `/agreements/${options.agreementId}/milestones/${options.milestoneId}/approve`,
  );
}

export interface ReleaseMilestoneOptions {
  agreementId: string;
  milestoneId: string;
  confirm: (details: TransactionDetails) => Promise<boolean>;
  onProgress?: (stage: "connecting" | "preparing" | "review" | "signing" | "submitting") => void;
}

export async function buildAndSignMilestoneRelease(options: ReleaseMilestoneOptions): Promise<Payment> {
  const { agreementId, milestoneId, confirm, onProgress } = options;
  onProgress?.("connecting");
  const address = await ensureWalletAddress();
  const base = `/agreements/${agreementId}/milestones/${milestoneId}`;

  onProgress?.("preparing");
  const prepared = await api.post<PreparedPayment>(`${base}/prepare-release`, { source_account: address });
  if (!prepared?.xdr || !prepared?.payment_id) {
    throw new WalletError("The backend did not return a Soroban transaction to sign.", "ERROR");
  }

  const details = parseTransactionDetails(prepared.xdr, prepared.hash);
  onProgress?.("review");
  const approved = await confirm(details);
  if (!approved) throw new WalletError("Release cancelled. Nothing was signed or submitted.", "CANCELLED");

  onProgress?.("signing");
  const signedXdr = await signTransaction(prepared.xdr, address);

  onProgress?.("submitting");
  return api.post<Payment>(`${base}/release`, { signed_xdr: signedXdr });
}

/** Public Horizon call for display only — never used to authorise a payment. */
export async function getBalances(publicKey: string): Promise<WalletBalance[]> {
  const response = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(publicKey)}`, { cache: "no-store" });
  if (response.status === 404) return [];
  if (!response.ok) throw new Error("Could not load balances from the Stellar Testnet network.");
  const data = (await response.json()) as {
    balances?: Array<{ asset_type: string; asset_code?: string; asset_issuer?: string; balance: string }>;
  };
  return (data.balances || []).map((entry) => ({
    asset: entry.asset_type === "native" ? "XLM" : entry.asset_code || "Unknown",
    issuer: entry.asset_type === "native" ? null : entry.asset_issuer || null,
    balance: entry.balance,
  }));
}

export function explorerUrl(hash: string): string {
  return `${EXPLORER_BASE}/${encodeURIComponent(hash)}`;
}
