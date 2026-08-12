import { describe, expect, it } from "vitest";
import { profitLockStop } from "../src/decide/sizing.js";

describe("profit locking", () => {
  it("moves a long to breakeven after one quarter of the target path", () => {
    expect(profitLockStop({
      side: "long", entryPx: "100", markPx: "102.5", targetPx: "110", currentStopPx: "95",
    })).toBe("100");
  });

  it("locks one quarter of the planned move after halfway", () => {
    expect(profitLockStop({
      side: "long", entryPx: "100", markPx: "105", targetPx: "110", currentStopPx: "100",
    })).toBe("102.5");
  });

  it("locks half of the planned move after three quarters for a short", () => {
    expect(profitLockStop({
      side: "short", entryPx: "100", markPx: "85", targetPx: "80", currentStopPx: "95",
    })).toBe("90");
  });

  it("never loosens a tighter stop", () => {
    expect(profitLockStop({
      side: "short", entryPx: "100", markPx: "90", targetPx: "80", currentStopPx: "89",
    })).toBeNull();
  });

  it("does nothing before the first milestone or for an invalid target", () => {
    expect(profitLockStop({
      side: "long", entryPx: "100", markPx: "101", targetPx: "110", currentStopPx: "95",
    })).toBeNull();
    expect(profitLockStop({
      side: "long", entryPx: "100", markPx: "105", targetPx: "90", currentStopPx: "95",
    })).toBeNull();
  });
});