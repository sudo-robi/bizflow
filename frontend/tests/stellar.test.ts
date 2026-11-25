import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAddress,
  getNetwork as freighterGetNetwork,
  isConnected as freighterIsConnected,
  requestAccess as freighterRequestAccess,
  signTransaction as freighterSignTransaction,
} from "@stellar/freighter-api";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { api } from "../src/lib/api";
import {
  EXPLORER_BASE,
  HORIZON_URL,
  TESTNET_PASSPHRASE,
  WalletError,
  assertTestnet,
  buildAndSignEscrowFund,
  buildAndSignMilestoneApproval,
  buildAndSignMilestoneRelease,
  buildAndSignPayment,
  connectWallet,
  explorerUrl,
  getBalances,
  getNetwork,
  getWalletAddress,
  hasFreighterProvider,
  isFreighterInstalled,
  parseTransactionDetails,
  signTransaction,
} from "../src/lib/stellar";

vi.mock("@stellar/freighter-api", () => ({
  getAddress: vi.fn(),
  getNetwork: vi.fn(),
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));

vi.mock("@stellar/stellar-sdk", () => ({
  Networks: { TESTNET: "Testnet Network Passphrase" },
  TransactionBuilder: { fromXDR: vi.fn() },
}));

vi.mock("../src/lib/api", () => ({
  api: { post: vi.fn() },
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : "Something went wrong. Please try again."),
}));

const mockedGetAddress = vi.mocked(getAddress) as unknown as ReturnType<typeof vi.fn>;
const mockedGetNetwork = vi.mocked(freighterGetNetwork) as unknown as ReturnType<typeof vi.fn>;
const mockedIsConnected = vi.mocked(freighterIsConnected) as unknown as ReturnType<typeof vi.fn>;
const mockedRequestAccess = vi.mocked(freighterRequestAccess) as unknown as ReturnType<typeof vi.fn>;
const mockedSign = vi.mocked(freighterSignTransaction) as unknown as ReturnType<typeof vi.fn>;
const mockedFromXDR = vi.mocked(TransactionBuilder.fromXDR);
const mockedPost = vi.mocked(api.post);

const VALID_ADDRESS = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const VALID_ADDRESS_B = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";

beforeEach(() => {
  vi.resetAllMocks();
  delete (window as unknown as Record<string, unknown>).freighter;
  delete (window as unknown as Record<string, unknown>).freighterApi;
  mockedGetNetwork.mockResolvedValue({ network: "Testnet", networkPassphrase: TESTNET_PASSPHRASE });
  mockedIsConnected.mockResolvedValue({ isConnected: true });
  mockedGetAddress.mockResolvedValue({ address: VALID_ADDRESS });
  mockedRequestAccess.mockResolvedValue({ address: VALID_ADDRESS });
  mockedSign.mockResolvedValue({ signedTxXdr: "signed-xdr" });
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function withProvider() {
  (window as unknown as Record<string, unknown>).freighter = {};
}

/** Minimal fake XDR transaction for parseTransactionDetails. */
function fakeTx(options: {
  operations?: Array<Record<string, unknown>>;
  memo?: unknown;
  fee?: number | string;
  source?: string;
  hash?: string;
  hashThrows?: boolean;
  inner?: boolean;
} = {}) {
  const inner = {
    operations: options.operations ?? [],
    memo: options.memo === undefined ? undefined : { value: options.memo },
    source: options.source ?? "GSOURCE",
  };
  const hash = vi.fn(() => {
    if (options.hashThrows) throw new Error("no hash");
    return { toString: () => options.hash ?? "abc123" };
  });
  const tx = { fee: options.fee ?? 100, hash, ...inner };
  return options.inner ? { innerTransaction: inner, fee: tx.fee, hash: tx.hash } : tx;
}

function nativeAsset() {
  return { isNative: () => true };
}

function issuedAsset(code = "USD", issuer = VALID_ADDRESS_B) {
  return { isNative: () => false, code, issuer };
}

describe("constants and helpers", () => {
  it("exposes the correct public constants", () => {
    expect(TESTNET_PASSPHRASE).toBe("Testnet Network Passphrase");
    expect(HORIZON_URL).toBe("https://horizon-testnet.stellar.org");
    expect(EXPLORER_BASE).toBe("https://stellar.expert/explorer/testnet/tx");
  });

  it("builds an encoded explorer URL", () => {
    expect(explorerUrl("abc/def")).toBe(`${EXPLORER_BASE}/abc%2Fdef`);
  });

  it("creates WalletError with a default ERROR code", () => {
    const error = new WalletError("bad");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("WalletError");
    expect(error.message).toBe("bad");
    expect(error.code).toBe("ERROR");
    expect(new WalletError("x", "REJECTED").code).toBe("REJECTED");
  });
});

describe("hasFreighterProvider / isFreighterInstalled", () => {
  it("detects no provider in a plain jsdom window", () => {
    expect(hasFreighterProvider()).toBe(false);
  });

  it("detects injected provider objects", () => {
    withProvider();
    expect(hasFreighterProvider()).toBe(true);
  });

  it("returns true immediately when a provider is injected", async () => {
    withProvider();
    await expect(isFreighterInstalled()).resolves.toBe(true);
    expect(mockedIsConnected).not.toHaveBeenCalled();
  });

  it("uses freighter isConnected when no provider is injected", async () => {
    await expect(isFreighterInstalled()).resolves.toBe(true);
    expect(mockedIsConnected).toHaveBeenCalledOnce();
  });

  it("returns false when Freighter reports an error or is disconnected", async () => {
    mockedIsConnected.mockResolvedValueOnce({ error: { message: "no" }, isConnected: true });
    await expect(isFreighterInstalled()).resolves.toBe(false);
    mockedIsConnected.mockResolvedValueOnce({ isConnected: false });
    await expect(isFreighterInstalled()).resolves.toBe(false);
  });

  it("returns false when the isConnected call throws", async () => {
    mockedIsConnected.mockRejectedValueOnce(new Error("boom"));
    await expect(isFreighterInstalled()).resolves.toBe(false);
  });
});

describe("connectWallet", () => {
  it("fails with NOT_INSTALLED when Freighter is unavailable", async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: false });
    await expect(connectWallet()).rejects.toMatchObject({ code: "NOT_INSTALLED" });
  });

  it("returns the address from requestAccess", async () => {
    await expect(connectWallet()).resolves.toBe(VALID_ADDRESS);
    expect(mockedRequestAccess).toHaveBeenCalledOnce();
    expect(mockedGetAddress).not.toHaveBeenCalled();
  });

  it("falls back to getAddress when requestAccess errors", async () => {
    mockedRequestAccess.mockResolvedValueOnce({ error: { message: "denied" } });
    await expect(connectWallet()).resolves.toBe(VALID_ADDRESS);
    expect(mockedGetAddress).toHaveBeenCalledOnce();
  });

  it("throws ACCESS_DENIED when getAddress errors, normalising rejection wording", async () => {
    mockedRequestAccess.mockResolvedValueOnce({ error: { message: "nope" } });
    mockedGetAddress.mockResolvedValueOnce({ error: { message: "User rejected the request" } });
    await expect(connectWallet()).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      message: "You declined the wallet connection request.",
    });
  });

  it("uses the Freighter error message for non-rejection failures", async () => {
    mockedRequestAccess.mockResolvedValueOnce({ error: {} });
    mockedGetAddress.mockResolvedValueOnce({ error: { message: "Extension crashed" } });
    await expect(connectWallet()).rejects.toMatchObject({ code: "ACCESS_DENIED", message: "Extension crashed" });
  });

  it("uses a fallback message when getAddress provides none", async () => {
    mockedRequestAccess.mockResolvedValueOnce({ error: {} });
    mockedGetAddress.mockResolvedValueOnce({});
    await expect(connectWallet()).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      message: "Wallet access was not granted.",
    });
  });

  it("wraps thrown non-WalletError failures as ACCESS_DENIED", async () => {
    mockedRequestAccess.mockRejectedValueOnce(new Error("User declined"));
    await expect(connectWallet()).rejects.toMatchObject({
      code: "ACCESS_DENIED",
      message: "You declined the wallet connection request.",
    });
  });

  it("rethrows WalletError instances unchanged", async () => {
    const original = new WalletError("custom", "NETWORK_MISMATCH");
    mockedRequestAccess.mockRejectedValueOnce(original);
    await expect(connectWallet()).rejects.toBe(original);
  });
});

describe("getWalletAddress / getNetwork / assertTestnet", () => {
  it("returns null when Freighter is not installed", async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: false });
    await expect(getWalletAddress()).resolves.toBeNull();
  });

  it("returns the address, or null on error/missing address/throw", async () => {
    await expect(getWalletAddress()).resolves.toBe(VALID_ADDRESS);
    mockedGetAddress.mockResolvedValueOnce({ error: { message: "x" }, address: VALID_ADDRESS });
    await expect(getWalletAddress()).resolves.toBeNull();
    mockedGetAddress.mockResolvedValueOnce({});
    await expect(getWalletAddress()).resolves.toBeNull();
    mockedGetAddress.mockRejectedValueOnce(new Error("x"));
    await expect(getWalletAddress()).resolves.toBeNull();
  });

  it("reads the network with default values", async () => {
    mockedGetNetwork.mockResolvedValueOnce({});
    await expect(getNetwork()).resolves.toEqual({ network: "Unknown", networkPassphrase: "" });
  });

  it("throws WalletError ERROR on Freighter network errors and thrown values", async () => {
    mockedGetNetwork.mockResolvedValueOnce({ error: { message: "Cannot read network" } });
    await expect(getNetwork()).rejects.toMatchObject({ code: "ERROR", message: "Cannot read network" });
    mockedGetNetwork.mockResolvedValueOnce({ error: {} });
    await expect(getNetwork()).rejects.toMatchObject({ code: "ERROR", message: "Could not read the wallet network." });
    mockedGetNetwork.mockRejectedValueOnce(new Error("crashed"));
    await expect(getNetwork()).rejects.toMatchObject({ code: "ERROR", message: "crashed" });
  });

  it("accepts testnet only by exact passphrase, not by network name", async () => {
    await expect(assertTestnet()).resolves.toMatchObject({ network: "Testnet" });
    mockedGetNetwork.mockResolvedValueOnce({ network: "Stellar TESTNET", networkPassphrase: "other" });
    await expect(assertTestnet()).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
    mockedGetNetwork.mockResolvedValueOnce({ network: "custom", networkPassphrase: "Standalone Test Net" });
    await expect(assertTestnet()).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
  });

  it("rejects non-testnet networks with a NETWORK_MISMATCH error", async () => {
    mockedGetNetwork.mockResolvedValueOnce({ network: "Public Net", networkPassphrase: "Public Global Stellar Network" });
    await expect(assertTestnet()).rejects.toMatchObject({
      code: "NETWORK_MISMATCH",
      message: expect.stringContaining('Freighter is connected to "Public Net"'),
    });
  });
});

describe("signTransaction", () => {
  it("requires testnet before requesting a signature", async () => {
    mockedGetNetwork.mockResolvedValueOnce({ network: "Public Net", networkPassphrase: "mainnet" });
    await expect(signTransaction("xdr")).rejects.toMatchObject({ code: "NETWORK_MISMATCH" });
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("signs with the testnet passphrase and the supplied address", async () => {
    await expect(signTransaction("xdr", VALID_ADDRESS)).resolves.toBe("signed-xdr");
    expect(mockedSign).toHaveBeenCalledWith("xdr", {
      networkPassphrase: TESTNET_PASSPHRASE,
      address: VALID_ADDRESS,
    });
  });

  it("omits the address option when no address is supplied", async () => {
    await signTransaction("xdr");
    expect(mockedSign).toHaveBeenCalledWith("xdr", { networkPassphrase: TESTNET_PASSPHRASE });
  });

  it("maps rejection errors to REJECTED with friendly wording", async () => {
    mockedSign.mockResolvedValueOnce({ error: { message: "User rejected signing" } });
    await expect(signTransaction("xdr")).rejects.toMatchObject({
      code: "REJECTED",
      message: "You rejected the signature request in Freighter.",
    });
  });

  it("maps other Freighter errors to SIGNING_FAILED", async () => {
    mockedSign.mockResolvedValueOnce({ error: { message: "Signature failed" } });
    await expect(signTransaction("xdr")).rejects.toMatchObject({ code: "SIGNING_FAILED", message: "Signature failed" });
  });

  it("rejects an empty signature", async () => {
    mockedSign.mockResolvedValueOnce({});
    await expect(signTransaction("xdr")).rejects.toMatchObject({
      code: "SIGNING_FAILED",
      message: "Freighter returned an empty signature. Nothing was submitted.",
    });
  });

  it("wraps thrown rejections and other errors", async () => {
    mockedSign.mockRejectedValueOnce(new Error("user declined"));
    await expect(signTransaction("xdr")).rejects.toMatchObject({
      code: "REJECTED",
      message: "You rejected the signature request in Freighter.",
    });
    mockedSign.mockRejectedValueOnce(new Error("unknown failure"));
    await expect(signTransaction("xdr")).rejects.toMatchObject({ code: "SIGNING_FAILED", message: "unknown failure" });
  });
});

describe("parseTransactionDetails", () => {
  it("parses a native payment and computes the hash/fee", () => {
    mockedFromXDR.mockReturnValueOnce(
      fakeTx({
        operations: [{ type: "payment", destination: VALID_ADDRESS, amount: "12.5000000", asset: nativeAsset() }],
        memo: "invoice-1",
        fee: 200,
        hash: "deadbeef",
      }) as never,
    );
    expect(parseTransactionDetails("xdr")).toEqual({
      source: "GSOURCE",
      destination: VALID_ADDRESS,
      amount: "12.5",
      asset: "XLM",
      assetIssuer: null,
      memo: "invoice-1",
      fee: "0.00002",
      network: "Stellar Testnet",
      hash: "deadbeef",
      operationType: "payment",
    });
  });

  it("parses an issued asset on a path payment and unwraps inner transactions", () => {
    mockedFromXDR.mockReturnValueOnce(
      fakeTx({
        inner: true,
        operations: [
          {
            type: "pathPaymentStrictReceive",
            destination: VALID_ADDRESS_B,
            destAmount: "5.25",
            destAsset: issuedAsset("USDC", "GISSUER"),
          },
        ],
        memo: 42,
      }) as never,
    );
    expect(parseTransactionDetails("xdr")).toMatchObject({
      destination: VALID_ADDRESS_B,
      amount: "5.25",
      asset: "USDC",
      assetIssuer: "GISSUER",
      memo: "42",
      operationType: "pathPaymentStrictReceive",
    });
  });

  it("uses destMin and falls back to op.amount for path payments", () => {
    mockedFromXDR.mockReturnValueOnce(
      fakeTx({
        operations: [{ type: "pathPaymentStrictSend", destination: VALID_ADDRESS, destMin: "1.5", asset: nativeAsset() }],
      }) as never,
    );
    expect(parseTransactionDetails("xdr").amount).toBe("1.5");
    mockedFromXDR.mockReturnValueOnce(
      fakeTx({ operations: [{ type: "pathPaymentStrictSend", destination: VALID_ADDRESS, amount: "2", destAsset: {} }] }) as never,
    );
    expect(parseTransactionDetails("xdr").amount).toBe("2");
  });

  it("handles missing destination/amount/asset details", () => {
    mockedFromXDR.mockReturnValueOnce(
      fakeTx({ operations: [{ type: "payment", destination: 5, asset: { isNative: () => false } }] }) as never,
    );
    expect(parseTransactionDetails("xdr")).toMatchObject({
      destination: "—",
      amount: "—",
      asset: "Unknown",
      assetIssuer: null,
    });
  });

  it("parses a Soroban invokeHostFunction operation", () => {
    mockedFromXDR.mockReturnValueOnce(
      fakeTx({
        operations: [
          {
            type: "invokeHostFunction",
            func: { name: "fund_escrow", contractId: "C".padEnd(56, "A") },
          },
        ],
      }) as never,
    );
    expect(parseTransactionDetails("xdr")).toMatchObject({
      operationType: "Soroban: fund escrow",
      destination: "CAAAAAAA…AAAAAAAA",
    });
  });

  it("falls back for an unnamed Soroban function and no contract", () => {
    mockedFromXDR.mockReturnValueOnce(fakeTx({ operations: [{ type: "invokeHostFunction", func: {} }] }) as never);
    expect(parseTransactionDetails("xdr")).toMatchObject({
      operationType: "Soroban invoke",
      destination: "Escrow contract",
    });
  });

  it("reports unknown operation types with no memo", () => {
    mockedFromXDR.mockReturnValueOnce(fakeTx({ operations: [{ type: "bumpSequence" }] }) as never);
    expect(parseTransactionDetails("xdr")).toMatchObject({ operationType: "bumpSequence", memo: "(none)" });
  });

  it("uses the fallback hash and tolerates a hash() that throws", () => {
    mockedFromXDR.mockReturnValue(fakeTx({ hashThrows: true }) as never);
    expect(parseTransactionDetails("xdr", "backend-hash").hash).toBe("backend-hash");
    expect(parseTransactionDetails("xdr").hash).toBe("");
  });

  it("returns a safe placeholder when XDR parsing fails", () => {
    mockedFromXDR.mockImplementationOnce(() => {
      throw new Error("bad xdr");
    });
    expect(parseTransactionDetails("bad", "fallback")).toEqual({
      source: "Available in Freighter before signing",
      destination: "Available in Freighter before signing",
      amount: "—",
      asset: "—",
      memo: "(none)",
      fee: "—",
      network: "Stellar Testnet",
      hash: "fallback",
      operationType: "unknown",
    });
  });
});

describe("buildAndSignPayment", () => {
  const confirm = vi.fn(async () => true);
  const onProgress = vi.fn();
  const options = {
    invoiceId: "inv-1",
    sourceAccount: VALID_ADDRESS,
    confirm,
    onProgress,
  };

  beforeEach(() => {
    confirm.mockResolvedValue(true);
    mockedPost.mockReset();
    mockedPost
      .mockResolvedValueOnce({ payment_id: "pay-1", xdr: "xdr", hash: "hash" } as never)
      .mockResolvedValueOnce({ id: "pay-1" } as never);
    mockedFromXDR.mockReturnValue(fakeTx() as never);
  });

  it("runs the full prepare -> confirm -> sign -> submit flow", async () => {
    const result = await buildAndSignPayment(options);
    expect(result).toEqual({ id: "pay-1" });
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual(["connecting", "preparing", "review", "signing", "submitting"]);
    expect(mockedPost).toHaveBeenNthCalledWith(1, "/payments/prepare", {
      invoice_id: "inv-1",
      source_account: VALID_ADDRESS,
    });
    expect(mockedPost).toHaveBeenNthCalledWith(2, "/payments/pay-1/submit", { signed_xdr: "signed-xdr" });
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ hash: "hash" }));
  });

  it("includes an optional partial amount in the prepare request", async () => {
    await buildAndSignPayment({ ...options, amount: "5" });
    expect(mockedPost).toHaveBeenNthCalledWith(1, "/payments/prepare", {
      invoice_id: "inv-1",
      source_account: VALID_ADDRESS,
      amount: "5",
    });
  });

  it("rejects when the connected account does not match the payment source", async () => {
    mockedGetAddress.mockResolvedValueOnce({ address: VALID_ADDRESS_B });
    await expect(buildAndSignPayment(options)).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" });
    expect(mockedPost).not.toHaveBeenCalled();
  });

  it("connects the wallet when no address is currently available", async () => {
    mockedGetAddress.mockResolvedValueOnce({ error: {} });
    mockedRequestAccess.mockResolvedValueOnce({ address: VALID_ADDRESS });
    await buildAndSignPayment(options);
    expect(mockedRequestAccess).toHaveBeenCalled();
  });

  it("fails when the backend does not return a usable prepared transaction", async () => {
    mockedPost.mockReset().mockResolvedValueOnce({ xdr: "" } as never);
    await expect(buildAndSignPayment(options)).rejects.toMatchObject({
      code: "ERROR",
      message: "The backend did not return a transaction to sign. No payment was made.",
    });
  });

  it("cancels without signing when the user declines", async () => {
    confirm.mockResolvedValueOnce(false);
    await expect(buildAndSignPayment(options)).rejects.toMatchObject({ code: "CANCELLED" });
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("works without an onProgress callback", async () => {
    await expect(buildAndSignPayment({ ...options, onProgress: undefined })).resolves.toBeDefined();
  });
});

describe("escrow flows", () => {
  const confirm = vi.fn(async () => true);

  beforeEach(() => {
    confirm.mockResolvedValue(true);
    mockedFromXDR.mockReturnValue(fakeTx() as never);
    mockedPost.mockReset();
    mockedPost.mockResolvedValue({ payment_id: "pay-1", xdr: "xdr", hash: "hash" } as never);
  });

  it("funds escrow with the correct prepare and submit paths", async () => {
    await buildAndSignEscrowFund({ agreementId: "ag-1", amount: "10", confirm });
    expect(mockedPost).toHaveBeenNthCalledWith(1, "/agreements/ag-1/prepare-fund", {
      source_account: VALID_ADDRESS,
      amount: "10",
    });
    expect(mockedPost).toHaveBeenNthCalledWith(2, "/agreements/ag-1/fund-escrow", { signed_xdr: "signed-xdr" });
  });

  it("approves a milestone and requires a milestoneId", async () => {
    expect(() =>
      buildAndSignMilestoneApproval({ agreementId: "ag-1", confirm }),
    ).toThrow(expect.objectContaining({ code: "ERROR", message: "milestoneId is required" }));
    await buildAndSignMilestoneApproval({ agreementId: "ag-1", milestoneId: "m-1", confirm });
    expect(mockedPost).toHaveBeenNthCalledWith(1, "/agreements/ag-1/milestones/m-1/prepare-approve", {
      source_account: VALID_ADDRESS,
    });
    expect(mockedPost).toHaveBeenNthCalledWith(2, "/agreements/ag-1/milestones/m-1/approve", { signed_xdr: "signed-xdr" });
  });

  it("releases a milestone with progress reporting", async () => {
    const onProgress = vi.fn();
    await buildAndSignMilestoneRelease({
      agreementId: "ag-1",
      milestoneId: "m-2",
      confirm,
      onProgress,
    });
    expect(mockedPost).toHaveBeenNthCalledWith(1, "/agreements/ag-1/milestones/m-2/prepare-release", {
      source_account: VALID_ADDRESS,
    });
    expect(mockedPost).toHaveBeenNthCalledWith(2, "/agreements/ag-1/milestones/m-2/release", { signed_xdr: "signed-xdr" });
    expect(onProgress.mock.calls.map((c) => c[0])).toEqual(["connecting", "preparing", "review", "signing", "submitting"]);
  });

  it("rejects an invalid prepared escrow transaction", async () => {
    mockedPost.mockReset().mockResolvedValueOnce({ xdr: "xdr" } as never);
    await expect(buildAndSignEscrowFund({ agreementId: "ag-1", confirm })).rejects.toMatchObject({
      code: "ERROR",
      message: "The backend did not return a Soroban transaction to sign.",
    });
  });

  it("cancels escrow flows when the user rejects", async () => {
    confirm.mockResolvedValueOnce(false);
    await expect(buildAndSignEscrowFund({ agreementId: "ag-1", confirm })).rejects.toMatchObject({ code: "CANCELLED" });
    expect(mockedSign).not.toHaveBeenCalled();
  });

  it("cancels milestone release with the dedicated message", async () => {
    confirm.mockResolvedValueOnce(false);
    await expect(
      buildAndSignMilestoneRelease({ agreementId: "ag-1", milestoneId: "m-1", confirm }),
    ).rejects.toMatchObject({ code: "CANCELLED", message: "Release cancelled. Nothing was signed or submitted." });
  });

  it("rejects an invalid prepared milestone release transaction", async () => {
    mockedPost.mockReset().mockResolvedValueOnce({ xdr: "" } as never);
    await expect(
      buildAndSignMilestoneRelease({ agreementId: "ag-1", milestoneId: "m-1", confirm }),
    ).rejects.toMatchObject({ code: "ERROR", message: "The backend did not return a Soroban transaction to sign." });
  });
});

describe("getBalances", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("returns an empty list for unknown accounts (404)", async () => {
    fetchMock.mockResolvedValue({ status: 404, ok: false });
    await expect(getBalances(VALID_ADDRESS)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(`${HORIZON_URL}/accounts/${VALID_ADDRESS}`, { cache: "no-store" });
  });

  it("throws on other network errors", async () => {
    fetchMock.mockResolvedValue({ status: 500, ok: false });
    await expect(getBalances(VALID_ADDRESS)).rejects.toThrow("Could not load balances from the Stellar Testnet network.");
  });

  it("maps native and issued balances, with sensible fallbacks", async () => {
    fetchMock.mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => ({
        balances: [
          { asset_type: "native", balance: "10" },
          { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "G-ISSUER", balance: "5" },
          { asset_type: "credit_alphanum12", balance: "1" },
        ],
      }),
    });
    await expect(getBalances("a/b")).resolves.toEqual([
      { asset: "XLM", issuer: null, balance: "10" },
      { asset: "USDC", issuer: "G-ISSUER", balance: "5" },
      { asset: "Unknown", issuer: null, balance: "1" },
    ]);
    expect(fetchMock.mock.calls[0][0]).toBe(`${HORIZON_URL}/accounts/a%2Fb`);
  });

  it("returns an empty list when the account has no balances field", async () => {
    fetchMock.mockResolvedValue({ status: 200, ok: true, json: async () => ({}) });
    await expect(getBalances(VALID_ADDRESS)).resolves.toEqual([]);
  });
});
