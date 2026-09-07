const EventEmitter = require('events');
const https = require('https');
const WebSocket = require('ws');

/**
 * Binance Live Market Data Adapter
 *
 * Connects directly to Binance Public REST APIs and WebSockets to provide
 * real-time streaming market data for symbols ending in 'USDT'.
 *
 * Lifecycle:
 * 1. On init for a symbol: fetches recent 1m klines via REST to seed rolling
 *    returns window and compute baseline volatility, plus 24h ticker for range/close.
 * 2. Connects to wss://stream.binance.com:9443/ws/<symbol>@ticker for live ticks.
 * 3. On each WS message: updates price/volume, appends to rolling returns,
 *    recomputes dynamic volatility, and emits 'tick'.
 * 4. On disconnect: marks isStale=true, begins reconnect loop with backoff,
 *    and NEVER fabricates ticks while disconnected.
 */
class BinanceAdapter extends EventEmitter {
  constructor() {
    super();
    this.states = new Map();
  }

  /**
   * Checks whether this adapter handles the symbol (must end in 'USDT').
   * @param {string} symbol
   * @returns {boolean}
   */
  isSupported(symbol) {
    if (!symbol || typeof symbol !== 'string') return false;
    return symbol.trim().toUpperCase().endsWith('USDT');
  }

  /**
   * Normalizes symbol into uppercase string (e.g. 'btcusdt' -> 'BTCUSDT').
   * @param {string} symbol
   * @returns {string}
   */
  normalizeSymbol(symbol) {
    return (symbol || '').trim().toUpperCase();
  }

  /**
   * Helper: fetches JSON via https with timeout.
   * @param {string} url
   * @param {number} [timeoutMs=4000]
   * @returns {Promise<any|null>}
   */
  _fetchJson(url, timeoutMs = 4000) {
    return new Promise((resolve) => {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch {
            resolve(null);
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });

      req.on('error', () => resolve(null));
    });
  }

  /**
   * Computes sample standard deviation of an array of returns.
   * @param {number[]} returns
   * @returns {number}
   */
  _computeVolatility(returns) {
    if (!Array.isArray(returns) || returns.length < 2) return 0.002;
    const len = returns.length;
    const mean = returns.reduce((acc, r) => acc + r, 0) / len;
    const varSum = returns.reduce((acc, r) => acc + (r - mean) ** 2, 0);
    const stdev = Math.sqrt(varSum / (len - 1));
    return isNaN(stdev) || stdev <= 0 ? 0.002 : Math.max(0.0005, Math.round(stdev * 100000) / 100000);
  }

  /**
   * Initializes a symbol state object and starts background seeding and WS connection.
   * @param {string} symbol - Ticker symbol, e.g. 'BTCUSDT'.
   * @param {Object} [seedData] - Optional initial fallback metrics.
   */
  ensureSymbol(symbol, seedData = {}) {
    const sym = this.normalizeSymbol(symbol);
    if (!sym || !this.isSupported(sym)) return;

    if (this.states.has(sym)) {
      return this.states.get(sym);
    }

    const state = {
      symbol: sym,
      price: seedData.price || 0,
      prevClose: seedData.prevClose || seedData.price || 0,
      volume: seedData.volume || 0,
      avgVolume: seedData.avgVolume || seedData.volume || 100000,
      high52: seedData.high52 || seedData.price || 0,
      low52: seedData.low52 || seedData.price || Infinity,
      volatility: seedData.volatility || 0.002,
      lastUpdate: 0,
      isStale: true,
      rollingReturns: [],
      ws: null,
      reconnectDelay: 1000,
      reconnectTimer: null,
      closed: false,
      source: 'Binance Live Feed'
    };

    this.states.set(sym, state);

    // Seed historical klines and 24h ticker, then establish live WebSocket
    state.initPromise = this._initSymbolData(sym);

    return state;
  }

  /**
   * Seeds historical returns from klines and establishes WebSocket stream.
   * @private
   */
  async _initSymbolData(sym) {
    const state = this.states.get(sym);
    if (!state || state.closed) return;

    // 1. Fetch recent 1m klines and 24h ticker in parallel
    const klinesUrl = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(sym)}&interval=1m&limit=50`;
    const tickerUrl = `https://api.binance.com/api/v3/ticker/24hr?symbol=${encodeURIComponent(sym)}`;

    const [klinesData, tickerData] = await Promise.all([
      this._fetchJson(klinesUrl),
      this._fetchJson(tickerUrl)
    ]);

    // Populate klines rolling returns
    if (Array.isArray(klinesData) && klinesData.length > 1) {
      const returns = [];
      for (let i = 1; i < klinesData.length; i++) {
        const prevClose = parseFloat(klinesData[i - 1][4]);
        const currClose = parseFloat(klinesData[i][4]);
        if (prevClose > 0 && !isNaN(currClose)) {
          returns.push((currClose - prevClose) / prevClose);
        }
      }
      if (returns.length > 0) {
        state.rollingReturns = returns.slice(-50);
        state.volatility = this._computeVolatility(state.rollingReturns);
      }
    }

    // Populate 24h ticker metrics
    if (tickerData && tickerData.lastPrice) {
      const p = parseFloat(tickerData.lastPrice);
      const v = parseFloat(tickerData.volume);
      const h = parseFloat(tickerData.highPrice);
      const l = parseFloat(tickerData.lowPrice);
      const pc = parseFloat(tickerData.prevClosePrice);

      if (!isNaN(p) && p > 0) state.price = p;
      if (!isNaN(v)) state.volume = v;
      if (!isNaN(v) && v > 0) state.avgVolume = v;
      if (!isNaN(h) && h > 0) state.high52 = h;
      if (!isNaN(l) && l > 0) state.low52 = l;
      if (!isNaN(pc) && pc > 0) state.prevClose = pc;

      state.lastUpdate = Date.now();
      state.isStale = false;

      // Emit initial snapshot on REST seed
      const snapshot = this.getSnapshot(sym);
      if (snapshot) this.emit('tick', snapshot);
    }

    // 2. Open live streaming WebSocket (only in persistent Node processes, skip on serverless)
    const isServerless = Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
    if (!isServerless) {
      this._connectWebSocket(sym);
    }
  }

  /**
   * Connects to Binance live WebSocket stream for symbol.
   * @private
   */
  _connectWebSocket(sym) {
    const state = this.states.get(sym);
    if (!state || state.closed) return;

    // Clean up existing socket if any
    if (state.ws) {
      try { state.ws.removeAllListeners(); state.ws.terminate(); } catch {}
      state.ws = null;
    }

    const wsUrl = `wss://stream.binance.com:9443/ws/${sym.toLowerCase()}@ticker`;
    let ws;

    try {
      ws = new WebSocket(wsUrl);
      state.ws = ws;
    } catch {
      this._scheduleReconnect(sym);
      return;
    }

    ws.on('open', () => {
      if (state.closed) { ws.close(); return; }
      state.reconnectDelay = 1000;
      state.isStale = false;
    });

    ws.on('message', (raw) => {
      if (state.closed) return;

      try {
        const data = JSON.parse(raw);
        if (!data || data.e !== '24hrTicker') return;

        const newPrice = parseFloat(data.c);
        const newVolume = parseFloat(data.v);
        const high24 = parseFloat(data.h);
        const low24 = parseFloat(data.l);
        const prevClose = parseFloat(data.x);

        if (isNaN(newPrice) || newPrice <= 0) return;

        const oldPrice = state.price;

        // Push to rolling returns window
        if (oldPrice > 0 && oldPrice !== newPrice) {
          const actualReturn = (newPrice - oldPrice) / oldPrice;
          state.rollingReturns.push(actualReturn);
          if (state.rollingReturns.length > 50) {
            state.rollingReturns.shift();
          }
          state.volatility = this._computeVolatility(state.rollingReturns);
        }

        state.price = newPrice;
        if (!isNaN(newVolume)) state.volume = newVolume;
        if (!isNaN(high24) && high24 > 0) state.high52 = Math.max(state.high52 || 0, high24);
        if (!isNaN(low24) && low24 > 0) state.low52 = Math.min(state.low52 || Infinity, low24);
        if (!isNaN(prevClose) && prevClose > 0) state.prevClose = prevClose;

        state.lastUpdate = Date.now();
        state.isStale = false;

        const snapshot = this.getSnapshot(sym);
        if (snapshot) {
          this.emit('tick', snapshot);
        }
      } catch {}
    });

    ws.on('close', () => {
      state.ws = null;
      state.isStale = true;
      if (!state.closed) {
        this._scheduleReconnect(sym);
      }
    });

    ws.on('error', () => {
      // ws 'close' event will trigger reconnect
      try { ws.close(); } catch {}
    });
  }

  /**
   * Schedules reconnect with exponential backoff.
   * Does NOT fabricate ticks while disconnected.
   * @private
   */
  _scheduleReconnect(sym) {
    const state = this.states.get(sym);
    if (!state || state.closed) return;

    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
    }

    state.isStale = true;

    const delay = state.reconnectDelay || 1000;
    state.reconnectDelay = Math.min(30000, delay * 2);

    state.reconnectTimer = setTimeout(() => {
      if (!state.closed) {
        this._connectWebSocket(sym);
      }
    }, delay);
  }

  /**
   * Retrieves the market data snapshot matching marketFeed.js shape.
   * @param {string} symbol - Ticker symbol
   * @returns {Object|null}
   */
  getSnapshot(symbol) {
    const sym = this.normalizeSymbol(symbol);
    const state = this.states.get(sym);
    if (!state) return null;

    const now = Date.now();
    const isStale = Boolean(state.isStale || !state.lastUpdate || (now - state.lastUpdate > 15000));
    const volumeRatio = state.avgVolume > 0 ? (state.volume / state.avgVolume) : 0;

    return {
      symbol: state.symbol,
      price: state.price,
      prevClose: state.prevClose,
      volume: state.volume,
      avgVolume: state.avgVolume,
      high52: state.high52 === Infinity ? state.price : state.high52,
      low52: state.low52 === Infinity ? state.price : state.low52,
      volatility: state.volatility,
      lastUpdate: state.lastUpdate,
      isStale,
      volumeRatio,
      rollingReturns: [...state.rollingReturns],
      source: 'Binance Live Feed'
    };
  }

  /**
   * Closes all WebSocket streams and clears timers.
   */
  close() {
    for (const state of this.states.values()) {
      state.closed = true;
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      if (state.ws) {
        try { state.ws.removeAllListeners(); state.ws.close(); } catch {}
        state.ws = null;
      }
    }
    this.states.clear();
  }
}

module.exports = BinanceAdapter;
