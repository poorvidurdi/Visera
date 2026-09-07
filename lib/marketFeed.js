/**
 * Single Responsibility: Market Feed Management
 * 
 * Manages market data subscriptions, fetches price snapshots, triggers tick event notifications,
 * and controls the polling/streaming cycle for tracked financial symbols.
 * 
 * Routing architecture:
 * - Any symbol ending in "USDT" (e.g. BTCUSDT, ETHUSDT) routes to binanceAdapter.js
 *   (Real live Binance REST kline seeding + real-time WebSocket ticker streaming).
 * - All other symbols (equities, indices, benchmark) route to the simulated Brownian engine.
 * 
 * Both sources are exposed through the exact same interface:
 *   ensureSymbol(symbol), getSnapshot(symbol?), on(event, cb), start(), tick(), forcePrice()
 * so nothing else in the codebase needs to know which source a given symbol uses.
 */

const EventEmitter = require('events');
const BinanceAdapter = require('./adapters/binanceAdapter');
const SimulatedAdapter = require('./adapters/SimulatedAdapter');

const emitter = new EventEmitter();

// Seed data for common tickers with realistic starting prices and baseline metrics
const SEED_DATA = {
  AAPL:     { price: 185.50, prevClose: 184.20, high52: 199.62, low52: 164.08, volume: 45000000, avgVolume: 52000000, volatility: 0.0015 },
  MSFT:     { price: 420.10, prevClose: 418.50, high52: 468.35, low52: 309.45, volume: 22000000, avgVolume: 25000000, volatility: 0.0012 },
  GOOGL:    { price: 175.25, prevClose: 174.80, high52: 191.75, low52: 120.21, volume: 18000000, avgVolume: 21000000, volatility: 0.0014 },
  AMZN:     { price: 180.40, prevClose: 179.90, high52: 201.20, low52: 118.35, volume: 31000000, avgVolume: 35000000, volatility: 0.0016 },
  NVDA:     { price: 125.80, prevClose: 124.50, high52: 140.76, low52: 40.85, volume: 65000000, avgVolume: 70000000, volatility: 0.0025 },
  META:     { price: 505.30, prevClose: 501.10, high52: 542.81, low52: 274.38, volume: 14000000, avgVolume: 16000000, volatility: 0.0018 },
  TSLA:     { price: 210.50, prevClose: 208.20, high52: 271.00, low52: 138.80, volume: 55000000, avgVolume: 60000000, volatility: 0.0030 },
  JPM:      { price: 205.60, prevClose: 204.90, high52: 211.84, low52: 143.20, volume: 9000000, avgVolume: 10500000, volatility: 0.0010 },
  BTCUSDT:  { price: 80000.00, prevClose: 79900.00, high52: 80500.00, low52: 25000.00, volume: 120000, avgVolume: 150000, volatility: 0.0040 },
  ETHUSDT:  { price: 3450.00, prevClose: 3410.00, high52: 4090.00, low52: 1520.00, volume: 450000, avgVolume: 500000, volatility: 0.0045 },
  RELIANCE: { price: 2950.00, prevClose: 2935.00, high52: 3217.90, low52: 2220.30, volume: 8000000, avgVolume: 9500000, volatility: 0.0013 },
  TCS:      { price: 3880.00, prevClose: 3865.00, high52: 4254.75, low52: 3310.00, volume: 2500000, avgVolume: 3000000, volatility: 0.0011 },
  INFY:     { price: 1620.00, prevClose: 1610.00, high52: 1733.00, low52: 1355.00, volume: 6000000, avgVolume: 7000000, volatility: 0.0014 },
  SPY:      { price: 545.00, prevClose: 543.50, high52: 565.16, low52: 410.07, volume: 60000000, avgVolume: 65000000, volatility: 0.0008 }
};

// 1. Live Binance WebSocket & REST adapter for USDT pairs
const binanceAdapter = new BinanceAdapter();

// Forward all real-time live ticks emitted by Binance WebSocket
binanceAdapter.on('tick', (snapshot) => {
  emitter.emit('tick', snapshot);
});

// 2. High-fidelity Brownian motion simulation engine for non-crypto symbols
const simulatedAdapter = new SimulatedAdapter(SEED_DATA);

let intervalTimer = null;

/**
 * Checks whether a symbol should route to Binance (ends in USDT).
 * @param {string} symbol
 * @returns {boolean}
 */
function isUSDT(symbol) {
  return typeof symbol === 'string' && symbol.trim().toUpperCase().endsWith('USDT');
}

/**
 * Constructs a plain snapshot object for simulated symbols matching Binance shape.
 * @param {Object} data
 * @returns {Object}
 */
function buildSimulatedSnapshot(data) {
  const now = Date.now();
  const isStale = !data.lastUpdate || (now - data.lastUpdate > 15000);
  const volumeRatio = data.avgVolume > 0 ? (data.volume / data.avgVolume) : 0;

  return {
    symbol: data.symbol,
    price: data.price,
    prevClose: data.prevClose,
    volume: data.volume,
    avgVolume: data.avgVolume,
    high52: data.high52 === Infinity ? data.price : data.high52,
    low52: data.low52 === Infinity ? data.price : data.low52,
    volatility: data.volatility,
    lastUpdate: data.lastUpdate,
    isStale,
    volumeRatio,
    rollingReturns: [...(data.rollingReturns || [])],
    source: 'Simulated Feed'
  };
}

/**
 * Ensures that a given symbol is subscribed to and actively tracked.
 * Routes USDT symbols to BinanceAdapter and others to SimulatedAdapter.
 *
 * @param {string} symbol - Ticker symbol, e.g. 'BTCUSDT' or 'AAPL'.
 */
function ensureSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') return;
  const sym = symbol.trim().toUpperCase();

  if (isUSDT(sym)) {
    binanceAdapter.ensureSymbol(sym, SEED_DATA[sym]);
  } else {
    simulatedAdapter.getState(sym);
  }
}

// Pre-seed all baseline symbols
for (const sym of Object.keys(SEED_DATA)) {
  ensureSymbol(sym);
}

/**
 * Retrieves the most recent market data snapshot for a specific symbol (or all symbols).
 *
 * @param {string} [symbol] - The ticker symbol to query.
 * @returns {Object|null} The latest snapshot object matching the standard shape, or null.
 */
function getSnapshot(symbol) {
  if (!symbol) {
    const result = {};

    // 1. Gather simulated snapshots
    for (const [sym, state] of simulatedAdapter.states.entries()) {
      result[sym] = buildSimulatedSnapshot(state);
    }

    // 2. Gather Binance snapshots
    for (const [sym] of binanceAdapter.states.entries()) {
      const snap = binanceAdapter.getSnapshot(sym);
      if (snap) result[sym] = snap;
    }

    return result;
  }

  if (typeof symbol !== 'string') return null;
  const sym = symbol.trim().toUpperCase();

  if (isUSDT(sym)) {
    return binanceAdapter.getSnapshot(sym);
  }

  const state = simulatedAdapter.getState(sym);
  if (!state) return null;
  return buildSimulatedSnapshot(state);
}

/**
 * Registers an event listener callback for market feed events (e.g. 'tick').
 *
 * @param {'tick'|string} event
 * @param {Function} cb
 */
function on(event, cb) {
  emitter.on(event, cb);
}

/**
 * Executes a tick cycle for simulated symbols.
 * Note: Binance ticks are streamed continuously over WebSocket and are not fabricated.
 *
 * @param {string} [targetSymbol]
 */
async function tick(targetSymbol) {
  if (targetSymbol) {
    const sym = targetSymbol.trim().toUpperCase();
    if (isUSDT(sym)) {
      // Do not fabricate ticks for live Binance symbols
      const snap = binanceAdapter.getSnapshot(sym);
      if (snap && !snap.isStale) {
        emitter.emit('tick', snap);
      }
      return;
    }

    await simulatedAdapter.fetchQuote(sym);
    const state = simulatedAdapter.getState(sym);
    if (state) {
      emitter.emit('tick', buildSimulatedSnapshot(state));
    }
    return;
  }

  // Interval cycle: tick all simulated symbols
  for (const [sym, state] of simulatedAdapter.states.entries()) {
    try {
      await simulatedAdapter.fetchQuote(sym);
      emitter.emit('tick', buildSimulatedSnapshot(state));
    } catch {}
  }
}

/**
 * Starts the market feed tick cycle for simulated assets at the specified interval.
 * Live crypto symbols stream asynchronously via Binance WebSocket.
 *
 * @param {number} [intervalMs=2000]
 */
function start(intervalMs = 2000) {
  if (intervalTimer) {
    clearInterval(intervalTimer);
  }
  intervalTimer = setInterval(() => {
    tick();
  }, intervalMs);
}

/**
 * [DEV ONLY] Directly overrides a symbol's price in the store and emits a synthetic tick.
 *
 * @param {string} symbol
 * @param {number} price
 * @param {{ high52?: number, low52?: number }} [opts]
 * @returns {Object|null}
 */
function forcePrice(symbol, price, opts = {}) {
  if (!symbol || typeof symbol !== 'string') return null;
  const sym = symbol.trim().toUpperCase();

  let data;
  let isBinance = false;

  if (isUSDT(sym)) {
    data = binanceAdapter.states.get(sym);
    isBinance = true;
  } else {
    data = simulatedAdapter.getState(sym);
  }

  if (!data) return null;

  const newPrice = Math.max(0.01, Math.round(Number(price) * 100) / 100);
  if (isNaN(newPrice)) return null;

  const oldPrice = data.price;
  const actualReturn = oldPrice > 0 ? (newPrice - oldPrice) / oldPrice : 0;

  data.price = newPrice;
  data.lastUpdate = Date.now();
  data.isStale = false;

  if (opts.high52 !== undefined) data.high52 = Number(opts.high52);
  if (opts.low52  !== undefined) data.low52  = Number(opts.low52);

  data.high52 = Math.max(data.high52, newPrice);
  data.low52  = Math.min(data.low52,  newPrice);

  if (!data.rollingReturns) data.rollingReturns = [];
  data.rollingReturns.push(actualReturn);
  if (data.rollingReturns.length > 50) data.rollingReturns.shift();

  const snapshot = isBinance
    ? binanceAdapter.getSnapshot(sym)
    : buildSimulatedSnapshot(data);

  emitter.emit('tick', snapshot);
  return snapshot;
}

module.exports = {
  ensureSymbol,
  getSnapshot,
  on,
  start,
  tick,
  forcePrice,
  binanceAdapter,
  simulatedAdapter
};
