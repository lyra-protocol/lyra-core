/**
 * The watchdog process.
 *
 * All the IO for `watch.ts`, kept apart from the judgement so the rules can be
 * tested without a server. Reads systemd, the collector's HTTP surface and the
 * log; writes to a webhook and a small state file.
 *
 * Runs as its own unit. If it shared a process with the agent it would die with
 * the agent, which is the one moment it has to survive.
 */

import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { DEFAULT_THRESHOLDS, evaluate, headerSafe, toSend, type Alert, type Observed } from "./watch.js";

const run = promisify(execFile);

const UNITS = ["lyra-paper", "lyra-serve", "lyra-harvester"];
const COLLECTOR = process.env.LYRA_WATCH_COLLECTOR ?? "http://127.0.0.1:8788";
const LOG = process.env.LYRA_WATCH_LOG ?? "/opt/lyra/data/paper.log";
const STATE = process.env.LYRA_WATCH_STATE ?? "/opt/lyra/data/alerts.json";
const WEBHOOK = process.env.LYRA_ALERT_WEBHOOK ?? "";
const INTERVAL_MS = Number(process.env.LYRA_WATCH_INTERVAL_MS ?? 120_000);

const log = (line: string) => process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);

async function serviceStates(): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const unit of UNITS) {
    try {
      // `systemctl is-active` exits non-zero when inactive, which promisify
      // surfaces as a throw — the failure path is the answer, not an error.
      const { stdout } = await run("systemctl", ["is-active", unit]);
      out[unit] = stdout.trim() === "active";
    } catch {
      out[unit] = false;
    }
  }
  return out;
}

async function getJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${COLLECTOR}${path}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Whether the log shows reconciliation currently refusing to trade.
 *
 * Halt state lives in the agent's memory, not the database, so the log is the
 * only place it is observable from outside. Only the tail is read, and only
 * recent lines count — a halt from this morning that was resolved is not a
 * halt now.
 */
async function haltState(now: number): Promise<{ halted: boolean; detail: string }> {
  try {
    const text = await readFile(LOG, "utf8");
    const lines = text.split("\n").slice(-400);
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes("BLOCKED") && !line.includes("HALTED")) continue;
      const at = Date.parse(line.slice(1, 25));
      if (!Number.isFinite(at) || now - at > 10 * 60 * 1000) break;
      const detail = line.split(/BLOCKED|HALTED/)[1]?.trim().slice(0, 200) ?? "";
      return { halted: true, detail };
    }
  } catch { /* no log yet is not a halt */ }
  return { halted: false, detail: "" };
}

async function observe(): Promise<Observed> {
  const now = Date.now();
  const [services, wallet, activity, halt] = await Promise.all([
    serviceStates(),
    getJson<{ dailyLossUsed: number; positions: { asset: string; stopPx: string | null }[] }>("/api/wallet"),
    getJson<{ decisions: { at: number }[] }>("/api/activity?limit=1"),
    haltState(now),
  ]);

  return {
    services,
    newestDecisionAt: activity?.decisions?.[0]?.at ?? null,
    dailyLossUsed: wallet?.dailyLossUsed ?? null,
    openPositions: wallet?.positions ?? null,
    halted: halt.halted,
    haltDetail: halt.detail,
    collectorReachable: wallet !== null,
    now,
  };
}

/**
 * Sends one alert.
 *
 * Shaped for ntfy — plain-text body with Title and Priority headers — because
 * it needs no account, no API key and no inbound port, and the phone app is the
 * whole setup. The same request is harmless to any other webhook that accepts a
 * POST, so pointing LYRA_ALERT_WEBHOOK elsewhere works without changing this.
 */
async function send(alert: Alert): Promise<void> {
  if (!WEBHOOK) { log(`WOULD ALERT [${alert.severity}] ${alert.title} — ${alert.detail}`); return; }
  try {
    const res = await fetch(WEBHOOK, {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        Title: headerSafe(`Lyra: ${alert.title}`),
        Priority: alert.severity === "critical" ? "urgent" : "default",
        Tags: alert.severity === "critical" ? "rotating_light" : "warning",
      },
      body: alert.detail,
      signal: AbortSignal.timeout(10_000),
    });
    log(`sent ${alert.id} (${res.status})`);
  } catch (error) {
    // A failed alert must not stop the loop; the condition is still true next pass.
    log(`ALERT SEND FAILED for ${alert.id}: ${(error as Error).message}`);
  }
}

async function readState(): Promise<Record<string, number>> {
  try { return JSON.parse(await readFile(STATE, "utf8")) as Record<string, number>; }
  catch { return {}; }
}

async function writeState(state: Record<string, number>): Promise<void> {
  try { await writeFile(STATE, JSON.stringify(state), "utf8"); }
  catch (error) { log(`could not persist alert state: ${(error as Error).message}`); }
}

async function tick(): Promise<void> {
  const observed = await observe();
  const alerts = evaluate(observed, DEFAULT_THRESHOLDS);
  const previous = await readState();
  const { send: due, resolved, nextState } = toSend(alerts, previous, observed.now);

  for (const alert of due) await send(alert);

  for (const id of resolved) {
    await send({
      id: `${id}:resolved`,
      severity: "warning",
      title: `resolved: ${id}`,
      detail: "This condition is no longer present.",
    });
  }

  await writeState(nextState);

  if (alerts.length === 0) log("healthy");
  else log(`${alerts.length} condition(s): ${alerts.map((a) => a.id).join(", ")}`);
}

log(`watching every ${Math.round(INTERVAL_MS / 1000)}s — ${WEBHOOK ? "webhook configured" : "NO WEBHOOK, logging only"}`);
void tick();
setInterval(() => void tick(), INTERVAL_MS);
