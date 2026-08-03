/**
 * The watchdog's judgement.
 *
 * These test the conditions that actually happened today, not invented ones:
 * a three-hour halt nobody noticed, positions carrying no stop, and a loop that
 * would have looked healthy from the outside while doing nothing.
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, evaluate, headerSafe, toSend, type Observed } from "../src/watch.js";

const NOW = 1_785_800_000_000;

function healthy(over: Partial<Observed> = {}): Observed {
  return {
    services: { "lyra-paper": true, "lyra-serve": true, "lyra-harvester": true },
    newestDecisionAt: NOW - 60_000,
    dailyLossUsed: 0.004,
    openPositions: [{ asset: "BTC", stopPx: "65000" }],
    halted: false,
    haltDetail: "",
    collectorReachable: true,
    now: NOW,
    ...over,
  };
}

describe("silence is never mistaken for health", () => {
  it("says nothing when everything is fine", () => {
    expect(evaluate(healthy())).toHaveLength(0);
  });

  it("catches a stalled loop, which looks identical to a healthy one", () => {
    // The failure this service exists for: the site stays up, the last decision
    // sits there looking recent, and she has simply stopped.
    const a = evaluate(healthy({ newestDecisionAt: NOW - 45 * 60_000 }));
    expect(a.map((x) => x.id)).toContain("loop_stalled");
    expect(a[0]!.severity).toBe("critical");
  });

  it("tolerates an ordinary quiet minute", () => {
    // She consults every ~70s and the gate skips assets, so a minute of quiet
    // is normal. Alerting on it would train the reader to ignore the alerts.
    expect(evaluate(healthy({ newestDecisionAt: NOW - 5 * 60_000 }))).toHaveLength(0);
  });
});

describe("the conditions that actually occurred", () => {
  it("reports a halt — the one that ran three hours unnoticed", () => {
    const a = evaluate(healthy({ halted: true, haltDetail: "1 position(s) cannot be explained: ETH" }));
    expect(a.map((x) => x.id)).toContain("halted");
    expect(a.find((x) => x.id === "halted")!.detail).toContain("ETH");
    // It must also say what is still safe, or the reader cannot triage it.
    expect(a.find((x) => x.id === "halted")!.detail).toMatch(/stops still rest/);
  });

  it("treats an unprotected position as critical, not a warning", () => {
    const a = evaluate(healthy({ openPositions: [{ asset: "DOGE", stopPx: null }] }));
    const found = a.find((x) => x.id === "unprotected:DOGE");
    expect(found).toBeDefined();
    expect(found!.severity).toBe("critical");
  });

  it("names the service that is down and what it costs", () => {
    const a = evaluate(healthy({ services: { "lyra-paper": true, "lyra-serve": true, "lyra-harvester": false } }));
    const found = a.find((x) => x.id === "service_down:lyra-harvester");
    // The harvester is the one whose downtime is unrecoverable.
    expect(found!.detail).toMatch(/cannot be backfilled/);
  });
});

describe("the loss limit", () => {
  it("warns before the halt, while there is still a decision to make", () => {
    const a = evaluate(healthy({ dailyLossUsed: 0.05 }));
    expect(a.map((x) => x.id)).toContain("loss_warning");
    expect(a.find((x) => x.id === "loss_warning")!.severity).toBe("warning");
  });

  it("escalates once the breaker has actually fired", () => {
    const a = evaluate(healthy({ dailyLossUsed: 0.071 }));
    expect(a.map((x) => x.id)).toContain("loss_limit_hit");
    expect(a.find((x) => x.id === "loss_limit_hit")!.severity).toBe("critical");
    expect(a.map((x) => x.id)).not.toContain("loss_warning");
  });

  it("stays quiet on an ordinary losing day", () => {
    expect(evaluate(healthy({ dailyLossUsed: 0.02 }))).toHaveLength(0);
  });
});

describe("repeats are suppressed", () => {
  const alert = { id: "halted", severity: "critical" as const, title: "t", detail: "d" };

  it("sends a new condition immediately", () => {
    const { send } = toSend([alert], {}, NOW);
    expect(send).toHaveLength(1);
  });

  it("does not send the same condition again inside the cooldown", () => {
    // An alert that fires every two minutes is one nobody reads.
    const { send } = toSend([alert], { halted: NOW - 60_000 }, NOW);
    expect(send).toHaveLength(0);
  });

  it("sends again once the cooldown has passed", () => {
    const { send } = toSend([alert], { halted: NOW - 2 * 60 * 60_000 }, NOW);
    expect(send).toHaveLength(1);
  });

  it("reports a condition clearing, because a silence is otherwise ambiguous", () => {
    const { resolved, nextState } = toSend([], { halted: NOW - 60_000 }, NOW);
    expect(resolved).toEqual(["halted"]);
    expect(nextState).toEqual({});
  });

  it("keeps criticals ahead of warnings", () => {
    const a = evaluate(healthy({ dailyLossUsed: 0.05, halted: true }));
    expect(a[0]!.severity).toBe("critical");
    expect(a.at(-1)!.severity).toBe("warning");
  });
});

describe("alerts can actually be sent", () => {
  it("folds typographic characters that would throw in a header", () => {
    // Header values are ByteStrings. An em-dash does not degrade, it throws —
    // found by testing delivery rather than trusting it, and the alert it broke
    // was the loss limit, the most important one in the set.
    expect(headerSafe("Daily loss limit reached — 7.00%")).toBe("Daily loss limit reached - 7.00%");
    expect(headerSafe("she said “no” — it’s fine…")).toBe('she said "no" - it\'s fine...');
    for (const c of headerSafe("Lyra: down 4.5% · halted")) {
      expect(c.charCodeAt(0)).toBeLessThan(256);
    }
  });

  it("keeps every generated title sendable", () => {
    // The real guarantee: not that one string is safe, but that nothing the
    // evaluator produces can be undeliverable.
    const all = [
      ...evaluate(healthy({ dailyLossUsed: 0.071 })),
      ...evaluate(healthy({ dailyLossUsed: 0.05 })),
      ...evaluate(healthy({ halted: true })),
      ...evaluate(healthy({ openPositions: [{ asset: "BTC", stopPx: null }] })),
      ...evaluate(healthy({ newestDecisionAt: NOW - 45 * 60_000 })),
      ...evaluate(healthy({ services: { "lyra-paper": false } })),
    ];
    expect(all.length).toBeGreaterThan(5);
    for (const a of all) {
      const title = headerSafe(`Lyra: ${a.title}`);
      expect(title.length).toBeGreaterThan(0);
      for (const c of title) expect(c.charCodeAt(0)).toBeLessThan(256);
    }
  });
});
