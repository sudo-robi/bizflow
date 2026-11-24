/**
 * Self-contained Stellar StrKey validation.
 *
 * A Stellar Ed25519 public key is the base32 encoding (RFC 4648, no padding) of
 * [version byte (6 << 3 = 48)] + [32 raw public-key bytes] + [CRC16-XModem],
 * which yields exactly 56 characters beginning with "G".
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ED25519_PUBLIC_KEY_VERSION = 6 << 3; // 48
const CONTRACT_VERSION = 2 << 3; // 16

function decodeBase32(input: string): Uint8Array | null {
  let buffer = 0;
  let bits = 0;
  const bytes: number[] = [];

  for (const char of input) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) return null;
  return new Uint8Array(bytes);
}

function crc16XModem(bytes: Uint8Array, length: number): number {
  let crc = 0;
  for (let i = 0; i < length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function isValidStrKey(value: string, versionByte: number, prefix: string): boolean {
  if (typeof value !== "string") return false;
  const key = value.trim().toUpperCase();
  if (!new RegExp(`^${prefix}[A-Z2-7]{55}$`).test(key)) return false;
  const raw = decodeBase32(key);
  if (!raw || raw.length !== 35) return false;
  if (raw[0] !== versionByte) return false;
  // StrKey appends the 16-bit checksum low byte first (little-endian).
  return crc16XModem(raw, 33) === ((raw[34] << 8) | raw[33]);
}

/** Validates a real Stellar G... Ed25519 public address (checksum included). */
export function isValidStellarPublicKey(value: string): boolean {
  return isValidStrKey(value, ED25519_PUBLIC_KEY_VERSION, "G");
}

/** Validates a Stellar C... contract / Soroban address. */
export function isValidContractId(value: string): boolean {
  return isValidStrKey(value, CONTRACT_VERSION, "C");
}

/** Human-readable Zod-style error message for wallet address fields. */
export function stellarAddressError(value: string): string | true {
  return isValidStellarPublicKey(value) || "Enter a valid Stellar public address (starts with G).";
}

/** Decimal string with at most 7 fractional digits, greater than zero. */
export function isValidAmount(value: string): boolean {
  if (typeof value !== "string") return false;
  return /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/.test(value.trim()) && Number(value) > 0;
}

/** Stellar asset codes are 1-12 alphanumeric characters (XLM for native). */
export function isValidAssetCode(value: string): boolean {
  return typeof value === "string" && /^[A-Z0-9]{1,12}$/i.test(value.trim());
}

export function isValidEmail(value: string): boolean {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/**
 * Parses a JSON object submitted from a textarea. Returns null for an empty
 * value; throws a clear message when the input is not a JSON object.
 */
export function parseJsonObject(value: string): Record<string, unknown> | null {
  const trimmed = (value || "").trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Enter valid JSON, for example: {"key": "value"}.');
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('Enter a JSON object, for example: {"key": "value"}.');
  }
  return parsed as Record<string, unknown>;
}
