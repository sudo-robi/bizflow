import { describe, expect, it } from "vitest";
import { formatRelativeTime, truncateAddress } from "../src/lib/format";
import { stellarAddressError } from "../src/lib/validators";

describe("remaining lib branches", () => {
  it("truncateAddress handles empty input", () => {
    expect(truncateAddress("")).toBe("—");
  });

  it("formatRelativeTime returns 'just now' for sub-minute deltas", () => {
    expect(formatRelativeTime(new Date(Date.now() + 1000).toISOString())).toBe("just now");
  });

  it("stellarAddressError returns true for valid keys and a message otherwise", () => {
    const valid = "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR";
    expect(stellarAddressError(valid)).toBe(true);
    expect(stellarAddressError("GABC")).toBe("Enter a valid Stellar public address (starts with G).");
  });
});
