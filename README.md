# lyra-core

Lyra's agent core. Currently one thing: **the venue position harvester.**

## Why this exists before the rest of the agent

Hyperliquid publishes the counterparties of every trade, and the current
positions of any address — size, entry, leverage, unrealised PnL, and the exact
price at which the position is forcibly closed.

It does **not** publish history. `clearinghouseState` returns current state only.
There is no archive, no paid tier, and nobody selling one.

So a position-history dataset can only be built by watching continuously,
starting whenever you start. **A day not observed is a day nobody can ever
recover** — not with money, not with effort, not later.

That is why this runs before the strategy is finished. Everything else can be
built at any time. This can only be built now.

## What it collects

| Table | Contents |
|---|---|
| `address` | Every address seen trading, discovered from the public trade feed |
| `position` | Append-only log of position **changes** — size, entry, leverage, liquidation price |
| `position_current` | Latest state per (address, coin), with `last_seen_ts` proving continuous existence |
| `account` | Account value, margin used, withdrawable, per poll |
| `mid` | Mid prices, so a snapshot can be interpreted against the price that was live when taken |

Every numeric value is stored as **TEXT, exactly as the venue sent it**. A price
of `63586.0` is stored as `"63586.0"`. Not as a float, ever. If Lyra later
reports a number, it is the venue's own bytes.

## Running it

```sh
npm install
npm run build
node dist/main.js
```

It runs until stopped, handles SIGINT/SIGTERM cleanly, and reconnects forever if
the socket drops. The database defaults to `.lyra/venue.db`; override with
`LYRA_DB`.

To keep it alive across logout:

```sh
nohup node dist/main.js >> harvest.log 2>&1 &
```

## Rate limits

From Hyperliquid's documentation, not guessed:

- **1200 weight per minute per IP**, across all REST requests
- `clearinghouseState` and `allMids` cost **weight 2**

The ceiling is therefore 600 position polls per minute. This runs at **600 weight
(≈300 polls/min)** — half the budget — because being throttled would create a gap
in a dataset that cannot be backfilled, and a gap costs more than slowness.

## Storage

Positions are appended to history only when something the trader *decided*
changes: size, entry, leverage, or liquidation price. Unrealised PnL and margin
move with every tick of the mark price and are deliberately not treated as
changes — they are recomputable from the position plus `mid`.

Without that, re-polling every address every five minutes would cost roughly
**675 MB/day** of duplicate rows.

A position that disappears between polls is recorded as a close (`szi = '0'`).
That event — closed or liquidated — is among the most informative things this
dataset captures, and it cannot be inferred from silence later.

## What it is for

The **Pain Map** (see `../DESIGN.md` §3.8): reconstructing, from public data,
how much money the crowd is currently losing and at what price it capitulates.

Every sentiment measure in existence — funding rates, long/short ratios, put/call
— is a proxy for something unobservable. On Hyperliquid the real quantity is
observable, address by address, in dollars. Existing liquidation heatmaps
*estimate* clusters from aggregate open interest. This enumerates them.

## Licence

MIT.
