/**
 * The watchdog.
 *
 * Deliberately a separate process from the thing it watches. An alerter running
 * inside the agent goes quiet at the exact moment it is needed — when the agent
 * dies — so this one only ever reads from the outside: systemd, the collector's
 * HTTP surface, and the log file.
 *
 * The rule it exists to enforce: **silence must never be mistakable for health.**
 * Lyra halted for three hours today and the only reason anyone knew was that
 * someone happened to ask. A halt on a Saturday would have cost the weekend.
 *
 * Everything here is a pure function of observed state so it can be tested
 * without a server. `watch-main.ts` does the IO.
 */

export type Severity = "critical" | "warning";

export type Alert = {
  /** Stable across firings of the same condition, so repeats can be suppressed. */
  id: string;
  severity: Severity;
  title: string;
  detail: string;
};

export type Observed = {
  /** systemd unit → active. A missing entry is treated as down. */
  services: Record<string, boolean>;
  /** Newest decision, ms since epoch. Null when there are none at all. */
  newestDecisionAt: number | null;
  /** Fraction of session-start equity lost today. */
  dailyLossUsed: number | null;
  openPositions: { asset: string; stopPx: string | null }[] | null;
  /** True when the log shows reconciliation refusing to trade. */
  halted: boolean;
  haltDetail: string;
  /** Whether the collector answered at all. */
  collectorReachable: boolean;
  now: number;
};

export type Thresholds = {
  /** How long the loop may go quiet before that is itself the signal. */
  stalledAfterMs: number;
  /** Daily loss fraction that warrants waking someone before the 7% halt. */
  lossWarnFraction: number;
  lossLimitFraction: number;
};

export const DEFAULT_THRESHOLDS: Thresholds = {
  // She consults every ~70s and the gate skips assets, so a quiet minute is
  // normal and a quiet half hour is not.
  stalledAfterMs: 30 * 60 * 1000,
  // Two thirds of the way to the halt. Late enough not to cry wolf, early
  // enough that there is a decision left to make.
  lossWarnFraction: 0.045,
  lossLimitFraction: 0.07,
};

const pct = (f: number) => `${(f * 100).toFixed(2)}%`;
const mins = (ms: number) => `${Math.round(ms / 60000)} minutes`;

/**
 * Everything currently wrong, worst first.
 *
 * Returns an empty array when healthy — the caller decides whether silence is
 * worth reporting, because this function has no memory of what it said last.
 */
export function evaluate(o: Observed, t: Thresholds = DEFAULT_THRESHOLDS): Alert[] {
  const alerts: Alert[] = [];

  for (const [unit, active] of Object.entries(o.services)) {
    if (!active) {
      alerts.push({
        id: `service_down:${unit}`,
        severity: "critical",
        title: `${unit} is not running`,
        detail:
          `systemd reports ${unit} inactive. ` +
          (unit === "lyra-harvester"
            ? "The dataset stops growing while it is down, and the gap cannot be backfilled — " +
              "Hyperliquid keeps no position history."
            : "She is not trading."),
      });
    }
  }

  if (o.halted) {
    alerts.push({
      id: "halted",
      severity: "critical",
      title: "Lyra has halted",
      detail:
        `Reconciliation is refusing to trade: ${o.haltDetail || "venue and store disagree"}. ` +
        `Existing stops still rest at the venue, so open positions remain protected, but no ` +
        `new position will be opened until this is resolved.`,
    });
  }

  if (!o.collectorReachable) {
    alerts.push({
      id: "collector_unreachable",
      severity: "critical",
      title: "The collector is not answering",
      detail:
        "lyra-serve did not respond. The terminal and both public pages are showing stale " +
        "or missing data to anyone looking at them right now.",
    });
  }

  /*
   * A stalled loop is the quiet failure this whole service exists for.
   *
   * Nothing goes wrong visibly: the site stays up, the last decision sits there
   * looking recent, and she simply stops. Time since the newest decision is the
   * only thing that distinguishes a working agent from a dead one.
   */
  if (o.newestDecisionAt === null) {
    if (o.collectorReachable) {
      alerts.push({
        id: "no_decisions",
        severity: "critical",
        title: "No decisions on record at all",
        detail: "The collector answered but holds no decisions. She has never run, or the store was reset.",
      });
    }
  } else {
    const quiet = o.now - o.newestDecisionAt;
    if (quiet > t.stalledAfterMs) {
      alerts.push({
        id: "loop_stalled",
        severity: "critical",
        title: "The loop has stopped",
        detail:
          `No decision for ${mins(quiet)}. The service may still be reported as running — ` +
          `a stalled loop looks identical to a healthy one from the outside.`,
      });
    }
  }

  /*
   * An unprotected position is the condition the settle fix was written for.
   *
   * It should now be impossible: a fill attaches its stop in the same pass, and
   * reconciliation repairs any that are missing. If it ever returns it must be
   * impossible to miss, which is why it is critical rather than a warning.
   */
  for (const p of o.openPositions ?? []) {
    if (!p.stopPx) {
      alerts.push({
        id: `unprotected:${p.asset}`,
        severity: "critical",
        title: `${p.asset} has no stop`,
        detail:
          `An open ${p.asset} position has no stop price recorded. This should be unreachable — ` +
          `fills attach a stop in the same pass and reconciliation repairs missing ones.`,
      });
    }
  }

  if (o.dailyLossUsed !== null) {
    if (o.dailyLossUsed >= t.lossLimitFraction) {
      alerts.push({
        id: "loss_limit_hit",
        severity: "critical",
        title: `Daily loss limit reached — ${pct(o.dailyLossUsed)}`,
        detail:
          `She has stopped opening positions for the day. Existing positions keep their stops. ` +
          `The limit resets at UTC midnight.`,
      });
    } else if (o.dailyLossUsed >= t.lossWarnFraction) {
      alerts.push({
        id: "loss_warning",
        severity: "warning",
        title: `Down ${pct(o.dailyLossUsed)} today`,
        detail:
          `The breaker halts new positions at ${pct(t.lossLimitFraction)}. ` +
          `${pct(t.lossLimitFraction - o.dailyLossUsed)} of room left.`,
      });
    }
  }

  const rank = (a: Alert) => (a.severity === "critical" ? 0 : 1);
  return alerts.sort((a, b) => rank(a) - rank(b));
}

/**
 * Which alerts to actually send, given what was sent before.
 *
 * An alert that fires every minute trains its reader to ignore it, which is
 * worse than no alert at all. A condition is announced once, then again only
 * after the cooldown, and once more when it clears — because "it stopped" is
 * information too, and without it a silence is ambiguous.
 */
export function toSend(
  current: Alert[],
  lastSent: Record<string, number>,
  now: number,
  cooldownMs = 60 * 60 * 1000,
): { send: Alert[]; resolved: string[]; nextState: Record<string, number> } {
  const send: Alert[] = [];
  const nextState: Record<string, number> = {};

  for (const a of current) {
    const previous = lastSent[a.id];
    if (previous === undefined || now - previous >= cooldownMs) {
      send.push(a);
      nextState[a.id] = now;
    } else {
      nextState[a.id] = previous;
    }
  }

  const active = new Set(current.map((a) => a.id));
  const resolved = Object.keys(lastSent).filter((id) => !active.has(id));

  return { send, resolved, nextState };
}

/**
 * An HTTP header value that will actually send.
 *
 * Header values are ByteStrings — latin-1 — so a single em-dash throws rather
 * than degrading. Found by testing delivery for real: the resolve notices and,
 * far worse, `Daily loss limit reached — 7.00%` all failed to send while the
 * plainer titles went through. The most important alert in the set was the one
 * that would have been silently dropped.
 *
 * Typographic characters are folded to their ASCII equivalents rather than
 * stripped, so a title stays readable instead of losing punctuation.
 */
export function headerSafe(value: string): string {
  return value
    .replace(/[\u2012-\u2015\u2212]/g, "-")
    .replace(/[\u2018\u2019\u201B]/g, "'")
    .replace(/[\u201C-\u201F]/g, '"')
    .replace(/\u2026/g, "...")
    .replace(/[\u00B7\u2022]/g, "-")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, 200);
}
