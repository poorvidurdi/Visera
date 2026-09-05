# Visera

Real-time market change detector and notification service.  
Tracks a per-user watchlist of financial symbols, scores every price movement against the user's last-acknowledged price, and pushes live ticks over WebSocket.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Architecture Overview](#architecture-overview)
3. [Module Contracts](#module-contracts)
4. [Swapping `marketFeed.js` for a Real Vendor](#swapping-marketfeedjs-for-a-real-vendor)
5. [Swapping `db.js` for Postgres + Redis](#swapping-dbjs-for-postgres--redis)
6. [Score Formula — Weights & Thresholds](#score-formula--weights--thresholds)
7. [REST API Reference](#rest-api-reference)
8. [WebSocket Protocol](#websocket-protocol)
9. [Environment Variables](#environment-variables)
10. [Running Tests](#running-tests)

---

## Quick Start

```bash
npm install
npm start          # starts on http://localhost:3000
```

Set `PORT` to override the default port.

---

## Architecture Overview

```
server.js          – Express + WebSocket glue; all routes
lib/
  marketFeed.js    – price source abstraction (simulated random-walk today)
  db.js            – persistence abstraction (JSON file today)
  changeDetector.js – pure scoring function, no I/O
public/
  index.html       – single-page frontend
test/
  changeDetector.test.js
  db.test.js
```

Each `lib/` module is an **architectural seam**: the rest of the system only touches the functions listed in its `module.exports`. No consumer reaches into internal state (e.g. the private `symbols` Map in `marketFeed.js` or the `store` object in `db.js`).

---

## Module Contracts

### `lib/marketFeed.js`

| Export | Signature | Description |
|---|---|---|
| `ensureSymbol` | `(symbol: string) → void` | Register a ticker so it receives ticks. Idempotent. |
| `getSnapshot` | `(symbol?: string) → Object \| null` | Return the latest plain snapshot for one symbol (or all). |
| `on` | `(event: string, cb: Function) → void` | Subscribe to feed events (`'tick'`). |
| `start` | `(intervalMs?: number) → void` | Start the polling/tick loop. |
| `tick` | `(symbol?: string) → void` | Manually advance one tick cycle (used in tests / debug). |
| `forcePrice` | `(symbol, price, opts?) → Object \| null` | **Dev only.** Inject an exact price and emit a synthetic tick. |

Snapshot shape emitted on every `'tick'` event:

```js
{
  symbol, price, prevClose,
  high52, low52,
  volume, avgVolume, volumeRatio,
  rollingReturns,   // number[]  last up to 50 per-tick returns
  volatility,       // rolling std-dev of returns
  lastUpdate,       // Date.now() ms
  isStale           // true if no tick in >15 s
}
```

### `lib/db.js`

| Export | Signature | Description |
|---|---|---|
| `ensureUser` | `(userId) → Object` | Upsert user record; returns the user object. |
| `getWatchlist` | `(userId) → Array` | Return watchlist items for a user. |
| `addSymbol` | `(userId, symbol, alertPrice?) → Array` | Add or update a watchlist entry. |
| `removeSymbol` | `(userId, symbol) → Array` | Remove a watchlist entry. |
| `setAlertPrice` | `(userId, symbol, alertPrice) → Array` | Set/clear the alert threshold for a symbol. |
| `recordLastSeen` | `(userId, symbol, priceData, details?) → Object` | Persist the last-acknowledged snapshot. |
| `getLastSeen` | `(userId, symbol) → Object \| null` | Retrieve the last-acknowledged record. |
| `getUsersWatchingSymbol` | `(symbol) → string[]` | All userIds that hold `symbol` in their watchlist. |

### `lib/changeDetector.js`

| Export | Signature | Description |
|---|---|---|
| `computeChange` | `(current, lastSeen, alertPrice?) → Result` | Pure scoring function — no I/O or side effects. |

`Result` shape:

```js
{
  score: number,              // 0–100
  bucket: 'significant' | 'notable' | 'new' | 'quiet',
  reasons: string[],          // human-readable firing reasons
  pctMoveSinceLastSeen: number
}
```

---

## Swapping `marketFeed.js` for a Real Vendor

`marketFeed.js` is the **only** file that knows how prices arrive. `server.js` never touches the internal `symbols` Map — it only calls the six exported functions listed above.

### What to replace

Implement the same six exports in a new file (e.g. `lib/marketFeed.vendor.js`) and swap the `require` line in `server.js`:

```js
// server.js  — one line change
const feed = require('./lib/marketFeed.vendor');
```

### Adapter skeleton

```js
// lib/marketFeed.vendor.js
const EventEmitter = require('events');
const emitter = new EventEmitter();

// e.g. Alpaca, Polygon, Binance WebSocket SDK
const vendorClient = require('your-vendor-sdk');

// Internal symbol registry (stays private — never exported)
const tracked = new Set();

function ensureSymbol(symbol) {
  const sym = symbol.trim().toUpperCase();
  if (tracked.has(sym)) return;
  tracked.add(sym);
  vendorClient.subscribe(sym);           // vendor call
}

function getSnapshot(symbol) {
  if (!symbol) {
    // return an object keyed by symbol for all tracked symbols
    const result = {};
    for (const sym of tracked) result[sym] = normalise(vendorClient.latest(sym));
    return result;
  }
  const sym = symbol.trim().toUpperCase();
  const raw = vendorClient.latest(sym);  // vendor call
  if (!raw) return null;
  return normalise(raw);
}

function on(event, cb)     { emitter.on(event, cb); }
function start(intervalMs) { /* vendor streams don't need polling; can be a no-op */ }
function tick(symbol)      { /* optional: manually trigger a snapshot fetch */ }
function forcePrice(sym, price, opts) { /* dev only — can be a no-op in prod */ }

// Forward vendor events into the shared emitter
vendorClient.on('quote', raw => {
  emitter.emit('tick', normalise(raw));
});

function normalise(raw) {
  // Map vendor-specific fields to the snapshot contract
  return {
    symbol:        raw.S,
    price:         raw.ap ?? raw.lp,
    prevClose:     raw.pc,
    high52:        raw.h52,
    low52:         raw.l52,
    volume:        raw.v,
    avgVolume:     raw.av,
    volumeRatio:   raw.av > 0 ? raw.v / raw.av : 0,
    rollingReturns: [],   // populate from a local ring buffer if needed
    volatility:    0.0015, // derive from rolling returns or a vendor field
    lastUpdate:    Date.now(),
    isStale:       false,
  };
}

module.exports = { ensureSymbol, getSnapshot, on, start, tick, forcePrice };
```

### Key invariants to preserve

- `getSnapshot()` must return `null` (not throw) for unknown symbols.
- Every `'tick'` event payload must include the full snapshot shape — `changeDetector.js` reads `volumeRatio`, `volatility`, `high52`, `low52`, and `isStale` from it.
- `isStale` should be `true` when the feed has been silent for > 15 s (or your chosen threshold).

---

## Swapping `db.js` for Postgres + Redis

`db.js` is the **only** file that knows about storage. No other module accesses `store`, `data.json`, or any file-system primitives.

### Design intent (documented in `db.js`)

| Data | Recommended store |
|---|---|
| Watchlists & user records | **PostgreSQL** — relational, durable |
| `lastSeen` price snapshots | **Redis** — hot, ephemeral, high-throughput |

### Suggested Postgres schema

```sql
CREATE TABLE users (
  user_id    TEXT PRIMARY KEY,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE watchlist (
  user_id     TEXT REFERENCES users(user_id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  alert_price NUMERIC,
  PRIMARY KEY (user_id, symbol)
);
```

### Suggested Redis schema

```
Key:    lastseen:{userId}:{SYMBOL}
Type:   Hash
Fields: price, ts, volatility, high52, low52, seen_at
TTL:    optional (e.g. 7 days)
```

### Adapter skeleton

```js
// lib/db.postgres.js
const { Pool } = require('pg');
const Redis    = require('ioredis');

const pg    = new Pool({ connectionString: process.env.DATABASE_URL });
const redis = new Redis(process.env.REDIS_URL);

async function ensureUser(userId) {
  await pg.query(
    `INSERT INTO users (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]
  );
  return { watchlist: await getWatchlist(userId), lastSeen: {} };
}

async function getWatchlist(userId) {
  const { rows } = await pg.query(
    `SELECT symbol, added_at, alert_price FROM watchlist WHERE user_id = $1`, [userId]
  );
  return rows.map(r => ({ symbol: r.symbol, addedAt: r.added_at, alertPrice: r.alert_price }));
}

async function addSymbol(userId, symbol, alertPrice = null) {
  await pg.query(
    `INSERT INTO watchlist (user_id, symbol, alert_price)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, symbol) DO UPDATE SET alert_price = EXCLUDED.alert_price`,
    [userId, symbol.toUpperCase(), alertPrice]
  );
  return getWatchlist(userId);
}

async function removeSymbol(userId, symbol) {
  await pg.query(
    `DELETE FROM watchlist WHERE user_id = $1 AND symbol = $2`,
    [userId, symbol.toUpperCase()]
  );
  return getWatchlist(userId);
}

async function setAlertPrice(userId, symbol, alertPrice) {
  return addSymbol(userId, symbol, alertPrice);
}

async function recordLastSeen(userId, symbol, priceData) {
  const sym = symbol.toUpperCase();
  const key = `lastseen:${userId}:${sym}`;
  await redis.hset(key, {
    price:      priceData.price,
    ts:         priceData.lastUpdate ?? Date.now(),
    volatility: priceData.volatility ?? '',
    high52:     priceData.high52 ?? '',
    low52:      priceData.low52 ?? '',
    seen_at:    new Date().toISOString(),
  });
  return getLastSeen(userId, sym);
}

async function getLastSeen(userId, symbol) {
  const key = `lastseen:${userId}:${symbol.toUpperCase()}`;
  const data = await redis.hgetall(key);
  if (!data || !data.price) return null;
  return {
    price:      Number(data.price),
    ts:         Number(data.ts),
    volatility: data.volatility ? Number(data.volatility) : null,
    high52:     data.high52     ? Number(data.high52)     : null,
    low52:      data.low52      ? Number(data.low52)      : null,
    seenAt:     data.seen_at,
  };
}

async function getUsersWatchingSymbol(symbol) {
  const { rows } = await pg.query(
    `SELECT user_id FROM watchlist WHERE symbol = $1`, [symbol.toUpperCase()]
  );
  return rows.map(r => r.user_id);
}

module.exports = {
  ensureUser, getWatchlist, addSymbol, removeSymbol,
  setAlertPrice, recordLastSeen, getLastSeen, getUsersWatchingSymbol,
};
```

Swap in `server.js`:

```js
const db = require('./lib/db.postgres');
```

> **Async migration note:** the current `db.js` functions are synchronous. The Postgres/Redis adapter will be async. All route handlers in `server.js` that call `db.*()` will need to be converted to `async` and have `await` added before each call.

---

## Score Formula — Weights & Thresholds

`computeChange(current, lastSeen, alertPrice)` in `lib/changeDetector.js` accumulates a score from up to four independent signals, then classifies it into a bucket. All constants live in one place — edit the source to retune.

### Signal contributions

| # | Signal | Activation condition | Points added | Per-signal cap |
|---|---|---|---|---|
| 1 | **Volatility-normalised move** | `ratio = movePct / (volatility × 100) ≥ 2` | `ratio` | **45** |
| 2 | **Volume anomaly** | `volumeRatio = volume / avgVolume ≥ 1.8` | `volumeRatio` | **30** |
| 3 | **52-week high crossed** | `lastSeenPrice < high52` **and** `currentPrice ≥ high52` (first crossing only) | **+20** | — |
| 4 | **52-week low crossed** | `lastSeenPrice > low52` **and** `currentPrice ≤ low52` (first crossing only) | **+20** | — |
| 5 | **User alert price crossed** | Sign of `(price − alertPrice)` flips between `lastSeen` and `current` | **+35** | — |

Raw sum is capped at **100** before bucket assignment.

### Stale data penalty

If `current.isStale === true` (feed silent for > 15 s), the **total score is multiplied by 0.35** after capping.

### Bucket classification

| Bucket | Score range (after stale adjustment) | Meaning |
|---|---|---|
| `significant` | ≥ 45 | Likely requires immediate attention |
| `notable` | 18 – 44 | Worth reviewing |
| `quiet` | 0 – 17 | Normal movement |
| `new` | No `lastSeen` baseline exists | First observation for this user/symbol |

Display priority in `/api/changes` response: `significant → notable → new → quiet`, then score descending within each bucket.

### Worked examples

| Scenario | Signals fired | Raw sum | After stale | Final score | Bucket |
|---|---|---|---|---|---|
| 10% move on 0.1% vol stock | vol-norm ratio = 100 → cap | 45 | n/a | **45** | `significant` |
| Volume 2.5× average, price flat | vol anomaly 2.5 | 2.5 | n/a | **2.5** | `quiet` |
| Alert price crossed, nothing else | alert +35 | 35 | n/a | **35** | `notable` |
| 52w high + alert crossed | 20 + 35 | 55 | n/a | **55** | `significant` |
| All signals maxed out | 45 + 30 + 20 + 35 = 130 → cap | 100 | n/a | **100** | `significant` |
| Stale snapshot, vol-norm capped | 45 × 0.35 | 45 | 15.75 | **15.75** | `quiet` |
| No `lastSeen` record | — | — | — | **5** (or 1.75 if stale) | `new` |

---

## REST API Reference

| Method | Path | Body | Response | Description |
|---|---|---|---|---|
| `POST` | `/api/session` | `{ userId? }` | `{ userId }` | Issue / reuse a userId |
| `GET` | `/api/watchlist/:userId` | — | `{ userId, watchlist }` | Fetch watchlist |
| `POST` | `/api/watchlist/:userId` | `{ symbol, alertPrice? }` | `{ userId, watchlist }` | Add symbol |
| `DELETE` | `/api/watchlist/:userId/:symbol` | — | `{ userId, watchlist }` | Remove symbol |
| `PUT` | `/api/watchlist/:userId/:symbol/alert` | `{ alertPrice }` | `{ userId, watchlist }` | Set alert (send `null` to clear) |
| `GET` | `/api/changes/:userId` | — | `{ userId, changes }` | Scored change report |
| `POST` | `/api/ack/:userId/:symbol` | — | `{ userId, symbol, lastSeen }` | Record current price as lastSeen |
| `POST` | `/api/ack-all/:userId` | — | `{ userId, acked }` | Record lastSeen for entire watchlist |
| `POST` | `/api/debug/force-price/:symbol` | `{ price, high52?, low52? }` | `{ snapshot, crossings }` | **Dev only** (disabled in production) |

---

## WebSocket Protocol

Connect to `ws://localhost:3000/ws`.

**Client → Server:**
```json
{ "type": "subscribe", "symbols": ["AAPL", "BTCUSDT"] }
```
Replaces the current subscription set entirely. Send again to update.

**Server → Client:**
```json
{ "type": "tick", "data": <snapshot> }
```
Delivered only for symbols the client has subscribed to. No score computation happens on this path — scores are computed on demand via `GET /api/changes/:userId`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP / WS listen port |
| `DATA_FILE` | `./data.json` | Path to the JSON persistence file (current implementation) |
| `NODE_ENV` | *(unset)* | Set to `production` to disable the debug force-price route |
