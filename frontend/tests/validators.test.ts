import { describe, expect, it } from "vitest";
import {
  isValidAmount,
  isValidAssetCode,
  isValidContractId,
  isValidEmail,
  isValidStellarPublicKey,
} from "../src/lib/validators";

// Checksum-valid Stellar Ed25519 public addresses (generated for these tests).
const VALID_KEY_A = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
const VALID_KEY_B = "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U";

describe("isValidStellarPublicKey", () => {
  it("accepts real Ed25519 public addresses", () => {
    expect(isValidStellarPublicKey(VALID_KEY_A)).toBe(true);
    expect(isValidStellarPublicKey(VALID_KEY_B)).toBe(true);
  });

  it("accepts surrounding whitespace and lowercase input", () => {
    expect(isValidStellarPublicKey(`  ${VALID_KEY_A}  `)).toBe(true);
    expect(isValidStellarPublicKey(VALID_KEY_A.toLowerCase())).toBe(true);
  });

  it("rejects malformed keys", () => {
    expect(isValidStellarPublicKey("")).toBe(false);
    expect(isValidStellarPublicKey("GABC")).toBe(false);
    expect(isValidStellarPublicKey(`${VALID_KEY_A}Z`)).toBe(false);
    expect(isValidStellarPublicKey(`${VALID_KEY_A.slice(0, -1)}0`)).toBe(false); // invalid checksum/char
    expect(isValidStellarPublicKey("M".repeat(56))).toBe(false);
    expect(isValidStellarPublicKey("S".repeat(56))).toBe(false); // secret seed shape
    expect(isValidStellarPublicKey("0".repeat(56))).toBe(false);
  });

  it("rejects keys with invalid base32 characters", () => {
    const bad = `G${"1".repeat(55)}`;
    expect(isValidStellarPublicKey(bad)).toBe(false);
  });

  it("does not accept contract addresses as public keys", () => {
    expect(isValidStellarPublicKey("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM")).toBe(false);
  });
});

describe("isValidContractId", () => {
  it("accepts a checksum-valid C... address", () => {
    expect(isValidContractId("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM")).toBe(true);
  });

  it("rejects public keys and nonsense", () => {
    expect(isValidContractId(VALID_KEY_A)).toBe(false);
    expect(isValidContractId("C123")).toBe(false);
  });
});

describe("isValidAmount", () => {
  it("accepts positive decimal strings with up to 7 places", () => {
    expect(isValidAmount("0.0000001")).toBe(true);
    expect(isValidAmount("1250.50")).toBe(true);
    expect(isValidAmount("42")).toBe(true);
  });

  it("rejects zero, negatives, excess precision and junk", () => {
    expect(isValidAmount("0")).toBe(false);
    expect(isValidAmount("-1")).toBe(false);
    expect(isValidAmount("1.12345678")).toBe(false);
    expect(isValidAmount("1e5")).toBe(false);
    expect(isValidAmount("abc")).toBe(false);
    expect(isValidAmount("")).toBe(false);
  });
});

describe("isValidAssetCode", () => {
  it("accepts 1-12 alphanumeric codes", () => {
    expect(isValidAssetCode("XLM")).toBe(true);
    expect(isValidAssetCode("USD")).toBe(true);
    expect(isValidAssetCode("ABCDEFGHIJKL")).toBe(true);
  });

  it("rejects invalid codes", () => {
    expect(isValidAssetCode("")).toBe(false);
    expect(isValidAssetCode("ABCDEFGHIJKLM")).toBe(false);
    expect(isValidAssetCode("US-D")).toBe(false);
  });
});

describe("isValidEmail", () => {
  it("checks basic email shape", () => {
    expect(isValidEmail("finance@acme.com")).toBe(true);
    expect(isValidEmail("finance@acme")).toBe(false);
    expect(isValidEmail("not an email")).toBe(false);
  });
});
