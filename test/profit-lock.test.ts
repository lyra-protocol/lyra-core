import { describe, expect, it } from "vitest";
import { profitLockStop } from "../src/decide/sizing.js";

describe("profit locking", () => {
  it("moves a long to breakeven after one quarter of the target path", () => {
    expect(profitLockStop({
      side: "long", size: "10", entryPx: "100", markPx: "102.5", targetPx: "110",
      currentStopPx: "95", entryFees: "0.15",
    })).toBe("100.06");
  });

  it("locks one quarter of the planned move after halfway", () => {
    expect(profitLockStop({
      side: "long", size: "10", entryPx: "100", markPx: "105", targetPx: "110",
      currentStopPx: "100", entryFees: "0.15",
    })).toBe("102.5");
  });

  it("locks half of the planned move after three quarters for a short", () => {
    expect(profitLockStop({
      side: "short", size: "10", entryPx: "100", markPx: "85", targetPx: "80",
      currentStopPx: "95", entryFees: "0.15",
    })).toBe("90");
  });

  it("never loosens a tighter stop", () => {
    expect(profitLockStop({
      side: "short", size: "10", entryPx: "100", markPx: "90", targetPx: "80",
      currentStopPx: "89", entryFees: "0.15",
    })).toBeNull();
  });

  it("does nothing before the first milestone or for an invalid target", () => {
    expect(profitLockStop({
      side: "long", size: "10", entryPx: "100", markPx: "101", targetPx: "110",
      currentStopPx: "95", entryFees: "0.15",
    })).toBeNull();
    expect(profitLockStop({
      side: "long", size: "10", entryPx: "100", markPx: "105", targetPx: "90",
      currentStopPx: "95", entryFees: "0.15",
    })).toBeNull();
  });
});