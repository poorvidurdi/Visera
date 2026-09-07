const BinanceAdapter = require('./binanceAdapter');
const SimulatedAdapter = require('./SimulatedAdapter');

/**
 * Composite Market Data Provider
 * 
 * Routes queries to real live market adapters (e.g. Binance for crypto)
 * and falls back gracefully to high-fidelity simulated feeds for equities
 * or when offline.
 */
class MarketDataProvider {
  constructor(seedData = {}) {
    this.binance = new BinanceAdapter();
    this.simulated = new SimulatedAdapter(seedData);
  }

  /**
   * Returns whether a real live feed adapter handles this symbol.
   * @param {string} symbol
   * @returns {boolean}
   */
  isLiveFeed(symbol) {
    return this.binance.isSupported(symbol);
  }

  /**
   * Fetches latest market quote using the appropriate adapter.
   * @param {string} symbol
   * @returns {Promise<Object>}
   */
  async getQuote(symbol) {
    const sym = (symbol || '').trim().toUpperCase();

    if (this.binance.isSupported(sym)) {
      try {
        const liveQuote = await this.binance.fetchQuote(sym);
        if (liveQuote && liveQuote.price) {
          // Merge with simulated volatility stats if needed
          const simState = this.simulated.getState(sym);
          simState.price = liveQuote.price;
          if (liveQuote.volume) simState.volume = liveQuote.volume;
          if (liveQuote.high52) simState.high52 = Math.max(simState.high52 || 0, liveQuote.high52);
          if (liveQuote.low52) simState.low52 = Math.min(simState.low52 || Infinity, liveQuote.low52);
          simState.lastUpdate = Date.now();
          simState.source = liveQuote.source;

          return {
            ...simState,
            rollingReturns: [...simState.rollingReturns]
          };
        }
      } catch (err) {
        // Fallback to simulation on network error
      }
    }

    return this.simulated.fetchQuote(sym);
  }

  /**
   * Initializes tracking for a symbol.
   * @param {string} symbol
   * @param {Object} [seed]
   */
  ensureSymbol(symbol, seed) {
    return this.simulated.initSymbol(symbol, seed);
  }

  getState(symbol) {
    return this.simulated.getState(symbol);
  }
}

module.exports = MarketDataProvider;
