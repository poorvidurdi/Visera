/**
 * Single Responsibility: Server Entry Point
 *
 * Initializes Express web server, HTTP server instance, WebSocket server instance,
 * serves static frontend assets from /public, and ties together server logic modules.
 *
 * REST routes:
 *   POST   /api/session                        – issues / reuses a userId
 *   GET    /api/watchlist/:userId               – get watchlist
 *   POST   /api/watchlist/:userId               – add symbol { symbol, alertPrice? }
 *   DELETE /api/watchlist/:userId/:symbol       – remove symbol
 *   PUT    /api/watchlist/:userId/:symbol/alert – set alert price { alertPrice }
 *   GET    /api/changes/:userId                 – scored change report (scores computed here, not on tick)
 *   POST   /api/ack/:userId/:symbol             – record lastSeen for one symbol
 *   POST   /api/ack-all/:userId                 – record lastSeen for all watchlist symbols
 *
 * WebSocket (path /ws):
 *   Client → { type: 'subscribe', symbols: ['AAPL', ...] }
 *   Server → { type: 'tick', data: <snapshot> }  (only for subscribed symbols)
 */

const http   = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const feed               = require('./lib/marketFeed');
const { computeChange }  = require('./lib/changeDetector');
const db                 = require('./lib/db');

// ─── App & server setup ────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

// WebSocket server mounted at path /ws
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());
app.use(express.static('public'));

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Bucket priority order for sorting: significant > notable > new > quiet */
const BUCKET_ORDER = { significant: 0, notable: 1, new: 2, quiet: 3 };

/**
 * Generates a short random userId.
 * @returns {string}
 */
function generateUserId() {
  return crypto.randomBytes(8).toString('hex');
}

// ─── REST Routes ───────────────────────────────────────────────────────────────

/**
 * POST /api/session
 * Body: { userId? } – if provided and valid, reuses it; otherwise issues a new one.
 * Response: { userId }
 */
app.post('/api/session', (req, res) => {
  const provided = req.body && req.body.userId;
  const userId   = provided ? String(provided).trim() : null;

  if (userId) {
    db.ensureUser(userId);
    return res.json({ userId });
  }

  const newId = generateUserId();
  db.ensureUser(newId);
  res.json({ userId: newId });
});

/**
 * GET /api/watchlist/:userId
 * Response: { userId, watchlist: [...] }
 */
app.get('/api/watchlist/:userId', (req, res) => {
  const { userId } = req.params;
  const watchlist  = db.getWatchlist(userId);
  res.json({ userId, watchlist });
});

/**
 * POST /api/watchlist/:userId
 * Body: { symbol, alertPrice? }
 * Response: { userId, watchlist: [...] }
 */
app.post('/api/watchlist/:userId', (req, res) => {
  const { userId }              = req.params;
  const { symbol, alertPrice }  = req.body || {};

  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }

  // Register symbol with the market feed so it receives ticks
  feed.ensureSymbol(symbol);

  const watchlist = db.addSymbol(userId, symbol, alertPrice ?? null);
  res.json({ userId, watchlist });
});

/**
 * DELETE /api/watchlist/:userId/:symbol
 * Response: { userId, watchlist: [...] }
 */
app.delete('/api/watchlist/:userId/:symbol', (req, res) => {
  const { userId, symbol } = req.params;
  const watchlist          = db.removeSymbol(userId, symbol);
  res.json({ userId, watchlist });
});

/**
 * PUT /api/watchlist/:userId/:symbol/alert
 * Body: { alertPrice }
 * Response: { userId, watchlist: [...] }
 */
app.put('/api/watchlist/:userId/:symbol/alert', (req, res) => {
  const { userId, symbol } = req.params;
  const { alertPrice }     = req.body || {};

  // undefined means the key was not sent at all — that is a client error.
  // null is valid: it means "clear the alert threshold".
  if (alertPrice === undefined) {
    return res.status(400).json({ error: 'alertPrice is required (send null to clear)' });
  }

  const watchlist = db.setAlertPrice(userId, symbol, alertPrice);
  res.json({ userId, watchlist });
});

/**
 * GET /api/changes/:userId
 *
 * For each watchlist item:
 *   1. Fetch current snapshot from marketFeed (no score computed on every tick)
 *   2. Fetch lastSeen from db
 *   3. Run computeChange(snapshot, lastSeen, item.alertPrice)
 *   4. Merge result with symbol metadata
 *
 * Sorted: significant > notable > new > quiet, then score desc within bucket.
 * Response: { userId, changes: [...] }
 */
app.get('/api/changes/:userId', (req, res) => {
  const { userId } = req.params;
  const watchlist  = db.getWatchlist(userId);

  const changes = watchlist.map(item => {
    const sym      = item.symbol;
    const snapshot = feed.getSnapshot(sym);
    const lastSeen = db.getLastSeen(userId, sym);

    // Ensure the feed tracks this symbol going forward
    if (!snapshot) {
      feed.ensureSymbol(sym);
    }

    const result = computeChange(
      snapshot || { price: NaN },
      lastSeen,
      item.alertPrice
    );

    return {
      symbol:               sym,
      alertPrice:           item.alertPrice,
      addedAt:              item.addedAt,
      snapshot,
      lastSeen,
      score:                result.score,
      bucket:               result.bucket,
      reasons:              result.reasons,
      pctMoveSinceLastSeen: result.pctMoveSinceLastSeen
    };
  });

  // Sort: bucket priority first, then score descending within bucket
  changes.sort((a, b) => {
    const bucketDiff = (BUCKET_ORDER[a.bucket] ?? 99) - (BUCKET_ORDER[b.bucket] ?? 99);
    if (bucketDiff !== 0) return bucketDiff;
    return b.score - a.score;
  });

  res.json({ userId, changes });
});

/**
 * POST /api/ack/:userId/:symbol
 * Records the current live snapshot as lastSeen for that symbol.
 * Response: { userId, symbol, lastSeen }
 */
app.post('/api/ack/:userId/:symbol', (req, res) => {
  const { userId, symbol } = req.params;
  const snapshot           = feed.getSnapshot(symbol);

  if (!snapshot) {
    return res.status(404).json({ error: `No snapshot available for ${symbol}` });
  }

  const lastSeen = db.recordLastSeen(userId, symbol, snapshot);
  res.json({ userId, symbol: symbol.toUpperCase(), lastSeen });
});

/**
 * POST /api/ack-all/:userId
 * Records the current live snapshot as lastSeen for every symbol in the watchlist.
 * Response: { userId, acked: [{ symbol, lastSeen }] }
 */
app.post('/api/ack-all/:userId', (req, res) => {
  const { userId } = req.params;
  const watchlist  = db.getWatchlist(userId);

  const acked = watchlist.map(item => {
    const sym      = item.symbol;
    const snapshot = feed.getSnapshot(sym);
    if (!snapshot) return { symbol: sym, lastSeen: null };
    const lastSeen = db.recordLastSeen(userId, sym, snapshot);
    return { symbol: sym, lastSeen };
  });

  res.json({ userId, acked });
});

// ─── Dev-only debug routes ─────────────────────────────────────────────────

/**
 * POST /api/debug/force-price/:symbol
 * GUARDED: only registered when NODE_ENV !== 'production'.
 *
 * Body: {
 *   price   : number   – new price to inject (required)
 *   high52? : number   – override the 52-week high before applying price
 *   low52?  : number   – override the 52-week low  before applying price
 * }
 *
 * What it does:
 *   1. Calls feed.forcePrice() → sets price in marketFeed and emits a 'tick'
 *      (so any open WebSocket clients subscribed to the symbol get a live update)
 *   2. For every user that holds the symbol in their watchlist, runs
 *      computeChange against their lastSeen so you can immediately verify
 *      alert-crossing / 52w-high / 52w-low / vol-norm reasons without polling.
 *
 * Response: {
 *   snapshot : <the snapshot that was injected>,
 *   crossings: [{ userId, symbol, bucket, score, reasons, pctMoveSinceLastSeen }]
 * }
 *
 * Usage examples:
 *   # Force AAPL to $200 (triggers 52w-high cross if lastSeen was below 199.62)
 *   curl -X POST http://localhost:3000/api/debug/force-price/AAPL \
 *        -H 'Content-Type: application/json' -d '{"price":200}'
 *
 *   # Push AAPL below its 52w low by also resetting the low reference
 *   curl -X POST http://localhost:3000/api/debug/force-price/AAPL \
 *        -H 'Content-Type: application/json' -d '{"price":160,"low52":165}'
 *
 *   # Test alert crossing: set alert to 190 first, then force price through it
 *   # PUT /api/watchlist/:userId/AAPL/alert  {"alertPrice":190}
 *   # POST /api/debug/force-price/AAPL      {"price":191}
 */
if (process.env.NODE_ENV !== 'production') {
  app.post('/api/debug/force-price/:symbol', (req, res) => {
    const sym   = String(req.params.symbol || '').trim().toUpperCase();
    const body  = req.body || {};
    const price = parseFloat(body.price);

    if (!sym) {
      return res.status(400).json({ error: 'symbol is required' });
    }
    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ error: 'price must be a positive number' });
    }

    // Ensure the symbol exists in the feed first
    feed.ensureSymbol(sym);

    const opts = {};
    if (body.high52 !== undefined) opts.high52 = parseFloat(body.high52);
    if (body.low52  !== undefined) opts.low52  = parseFloat(body.low52);

    const snapshot = feed.forcePrice(sym, price, opts);
    if (!snapshot) {
      return res.status(500).json({ error: 'forcePrice returned null — symbol may not have initialised' });
    }

    // Run computeChange against every user that has this symbol in their watchlist
    // so the caller can see crossing results without a separate /api/changes call.
    const crossings = db.getUsersWatchingSymbol(sym).map(userId => {
      const item     = db.getWatchlist(userId).find(i => i.symbol === sym);
      const lastSeen = db.getLastSeen(userId, sym);
      const result   = computeChange(snapshot, lastSeen, item ? item.alertPrice : null);
      return {
        userId,
        symbol: sym,
        alertPrice:           item ? item.alertPrice : null,
        bucket:               result.bucket,
        score:                result.score,
        reasons:              result.reasons,
        pctMoveSinceLastSeen: result.pctMoveSinceLastSeen,
      };
    });

    res.json({ snapshot, crossings });
  });

  console.log('[dev] Debug route active: POST /api/debug/force-price/:symbol');
}

// ─── WebSocket server ──────────────────────────────────────────────────────────

/**
 * Each connected WS client carries a Set of symbols it is subscribed to.
 * The feed 'tick' listener forwards snapshots only to clients that subscribed
 * to that symbol — score computation is intentionally NOT done on this path.
 */
wss.on('connection', ws => {
  ws.subscribedSymbols = new Set();

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return; // ignore malformed frames
    }

    if (msg && msg.type === 'subscribe' && Array.isArray(msg.symbols)) {
      // Replace subscription set with the new list
      ws.subscribedSymbols = new Set(
        msg.symbols
          .filter(s => typeof s === 'string')
          .map(s => s.trim().toUpperCase())
      );

      // Ensure market feed tracks all requested symbols
      for (const sym of ws.subscribedSymbols) {
        feed.ensureSymbol(sym);
      }
    }
  });

  ws.on('error', () => {}); // swallow socket errors; 'close' fires next
});

/**
 * Single shared tick listener — fan-out to all open clients subscribed to the symbol.
 * Hot path: no score computation, just forward the raw snapshot.
 */
feed.on('tick', snapshot => {
  const sym = snapshot.symbol;

  for (const ws of wss.clients) {
    if (ws.readyState !== ws.OPEN) continue;
    if (!ws.subscribedSymbols || !ws.subscribedSymbols.has(sym)) continue;

    ws.send(JSON.stringify({ type: 'tick', data: snapshot }));
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────────

// Start market feed at 2-second tick interval
feed.start(2000);

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Visera server running on http://localhost:${PORT}`);
    console.log(`WebSocket endpoint: ws://localhost:${PORT}/ws`);
  });
}

module.exports = { app, server, wss };
