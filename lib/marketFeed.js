/**
 * Single Responsibility: Market Feed Management
 * 
 * Manages market data subscriptions, fetches price snapshots, triggers tick event notifications,
 * and controls the polling/streaming interval cycle for tracked financial symbols.
 * 
 * Internal implementation acts as a simulated market data engine. Vendor integration
 * can replace tick() internals without touching external consumers.
 */

const EventEmitter = require('events');
const emitter = new EventEmitter();

// Seed data for common tickers with realistic starting prices and market metrics
const SEED_DATA = {
  AAPL: { price: 185.50, prevClose: 184.20, high52: 199.62, low52: 164.08, volume: 45000000, avgVolume: 52000000, volatility: 0.0015 },
  MSFT: { price: 420.10, prevClose: 418.50, high52: 468.35, low52: 309.45, volume: 22000000, avgVolume: 25000000, volatility: 0.0012 },
  GOOGL: { price: 175.25, prevClose: 174.80, high52: 191.75, low52: 120.21, volume: 18000000, avgVolume: 21000000, volatility: 0.0014 },
  AMZN: { price: 180.40, prevClose: 179.90, high52: 201.20, low52: 118.35, volume: 31000000, avgVolume: 35000000, volatility: 0.0016 },
  NVDA: { price: 125.80, prevClose: 124.50, high52: 140.76, low52: 40.85, volume: 65000000, avgVolume: 70000000, volatility: 0.0025 },
  META: { price: 505.30, prevClose: 501.10, high52: 542.81, low52: 274.38, volume: 14000000, avgVolume: 16000000, volatility: 0.0018 },
  TSLA: { price: 210.50, prevClose: 208.20, high52: 271.00, low52: 138.80, volume: 55000000, avgVolume: 60000000, volatility: 0.0030 },
  JPM: { price: 205.60, prevClose: 204.90, high52: 211.84, low52: 143.20, volume: 9000000, avgVolume: 10500000, volatility: 0.0010 },
  BTCUSDT: { price: 62500.00, prevClose: 61800.00, high52: 73750.00, low52: 25000.00, volume: 120000, avgVolume: 150000, volatility: 0.0040 },
  ETHUSDT: { price: 3450.00, prevClose: 3410.00, high52: 4090.00, low52: 1520.00, volume: 450000, avgVolume: 500000, volatility: 0.0045 },
  RELIANCE: { price: 2950.00, prevClose: 2935.00, high52: 3217.90, low52: 2220.30, volume: 8000000, avgVolume: 9500000, volatility: 0.0013 },
  TCS: { price: 3880.00, prevClose: 3865.00, high52: 4254.75, low52: 3310.00, volume: 2500000, avgVolume: 3000000, volatility: 0.0011 },
  INFY: { price: 1620.00, prevClose: 1610.00, high52: 1733.00, low52: 1355.00, volume: 6000000, avgVolume: 7000000, volatility: 0.0014 }
};

// Map storing tracked symbol states
const symbols = new Map();
let intervalTimer = null;

/**
 * Initializes state object for a symbol.
 */
function initSymbolState(symbol, seedInfo) {
  const now = Date.now();
  const info = seedInfo || {
    price: 100.00,
    prevClose: 100.00,
    high52: 120.00,
    low52: 80.00,
    volume: 1000000,
    avgVolume: 1000000,
    volatility: 0.0015
  };

  return {
    symbol,
    price: info.price,
    prevClose: info.prevClose,
    high52: info.high52,
    low52: info.low52,
    volume: info.volume,
    avgVolume: info.avgVolume,
    rollingReturns: [],
    volatility: info.volatility,
    lastUpdate: now
  };
}

// Pre-seed common tickers into internal store
for (const sym of Object.keys(SEED_DATA)) {
  symbols.set(sym, initSymbolState(sym, SEED_DATA[sym]));
}

/**
 * Generates standard normal random variable using Box-Muller transform.
 */
function sampleNormal() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

/**
 * Constructs a plain snapshot object for external consumers.
 * Computes isStale (no tick in >15s) and volumeRatio (volume / avgVolume).
 */
function buildSnapshotObject(data) {
  const now = Date.now();
  const isStale = !data.lastUpdate || (now - data.lastUpdate > 15000);
  const volumeRatio = data.avgVolume > 0 ? (data.volume / data.avgVolume) : 0;

  return {
    symbol: data.symbol,
    price: data.price,
    prevClose: data.prevClose,
    high52: data.high52,
    low52: data.low52,
    volume: data.volume,
    avgVolume: data.avgVolume,
    rollingReturns: [...data.rollingReturns],
    volatility: data.volatility,
    lastUpdate: data.lastUpdate,
    volumeRatio,
    isStale
  };
}

/**
 * Executes a tick cycle for tracked symbols (or a specific symbol).
 * Random-walks price scaled by volatility with ~1.5% event shock chance & volume surge.
 */
function tick(targetSymbol) {
  const now = Date.now();
  const targetSymbols = targetSymbol
    ? [targetSymbol.trim().toUpperCase()]
    : Array.from(symbols.keys());

  for (const sym of targetSymbols) {
    const data = symbols.get(sym);
    if (!data) continue;

    const oldPrice = data.price;

    // ~1.5% chance per tick of a larger "event" shock (6-12x normal vol)
    const isEvent = Math.random() < 0.015;
    const shockMult = isEvent ? (6 + Math.random() * 6) : 1;

    // Random walk scaled by symbol's own volatility
    const returnVal = sampleNormal() * data.volatility * shockMult;
    let newPrice = oldPrice * (1 + returnVal);
    newPrice = Math.max(0.01, Math.round(newPrice * 100) / 100);

    // Volume update: normal tick volume vs event volume surge
    const baseVolTick = Math.max(10, Math.floor(data.avgVolume / 5000));
    const volMultiplier = isEvent ? (8 + Math.random() * 12) : (0.8 + Math.random() * 0.4);
    const tickVolume = Math.floor(baseVolTick * volMultiplier);
    data.volume += tickVolume;

    // Update 52-week bounds
    data.high52 = Math.max(data.high52, newPrice);
    data.low52 = Math.min(data.low52, newPrice);

    // Update rolling returns array
    const actualReturn = (newPrice - oldPrice) / oldPrice;
    data.rollingReturns.push(actualReturn);
    if (data.rollingReturns.length > 50) {
      data.rollingReturns.shift();
    }

    // Update per-tick volatility standard deviation from rolling returns
    if (data.rollingReturns.length >= 2) {
      const len = data.rollingReturns.length;
      const mean = data.rollingReturns.reduce((acc, r) => acc + r, 0) / len;
      const varSum = data.rollingReturns.reduce((acc, r) => acc + (r - mean) ** 2, 0);
      const stdev = Math.sqrt(varSum / (len - 1));
      if (stdev > 0) {
        data.volatility = Math.max(0.0005, Math.round(stdev * 100000) / 100000);
      }
    }

    data.price = newPrice;
    data.lastUpdate = now;

    const snapshot = buildSnapshotObject(data);
    emitter.emit('tick', snapshot);
  }
}

/**
 * Ensures that a given symbol is subscribed to and actively tracked by the market feed.
 *
 * @param {string} symbol - The ticker symbol to subscribe to (e.g., 'AAPL', 'BTCUSDT').
 * @returns {void}
 */
function ensureSymbol(symbol) {
  if (!symbol || typeof symbol !== 'string') return;
  const sym = symbol.trim().toUpperCase();
  if (symbols.has(sym)) return;

  const seed = SEED_DATA[sym];
  symbols.set(sym, initSymbolState(sym, seed));
}

/**
 * Retrieves the most recent market data snapshot for a specific symbol (or all symbols).
 *
 * @param {string} [symbol] - The ticker symbol to query.
 * @returns {Object|null} The latest snapshot object for the symbol, or null if un-tracked.
 */
function getSnapshot(symbol) {
  if (!symbol) {
    const result = {};
    for (const [sym, data] of symbols.entries()) {
      result[sym] = buildSnapshotObject(data);
    }
    return result;
  }

  if (typeof symbol !== 'string') return null;
  const sym = symbol.trim().toUpperCase();
  const data = symbols.get(sym);
  if (!data) return null;

  return buildSnapshotObject(data);
}

/**
 * Registers an event listener callback for market feed events (e.g., 'tick').
 *
 * @param {'tick'|string} event - The event name to listen for.
 * @param {Function} cb - The callback function invoked when the event fires.
 * @returns {void}
 */
function on(event, cb) {
  emitter.on(event, cb);
}

/**
 * Starts the market feed polling or tick emission loop at the specified interval.
 *
 * @param {number} intervalMs - The tick cycle interval in milliseconds.
 * @returns {void}
 */
function start(intervalMs = 1000) {
  if (intervalTimer) {
    clearInterval(intervalTimer);
  }
  intervalTimer = setInterval(() => {
    tick();
  }, intervalMs);
}

module.exports = {
  ensureSymbol,
  getSnapshot,
  on,
  start,
  tick
};
