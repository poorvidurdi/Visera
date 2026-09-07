const BaseAdapter = require('./BaseAdapter');

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
 * Simulated Market Data Adapter
 * 
 * Provides realistic geometric Brownian motion price simulations with
 * Gaussian shocks, rolling returns, dynamic volatility, and volume surges.
 */
class SimulatedAdapter extends BaseAdapter {
  constructor(seedData = {}) {
    super('SimulatedAdapter');
    this.seedData = seedData;
    this.states = new Map();
    this.init();
  }

  init() {
    for (const [sym, info] of Object.entries(this.seedData)) {
      this.initSymbol(sym, info);
    }
  }

  isSupported(symbol) {
    return true; // Fallback handles any symbol
  }

  initSymbol(symbol, seedInfo) {
    const sym = symbol.trim().toUpperCase();
    const info = seedInfo || {
      price: 100.00,
      prevClose: 100.00,
      high52: 120.00,
      low52: 80.00,
      volume: 1000000,
      avgVolume: 1000000,
      volatility: 0.0015
    };

    const state = {
      symbol: sym,
      price: info.price,
      prevClose: info.prevClose,
      high52: info.high52,
      low52: info.low52,
      volume: info.volume,
      avgVolume: info.avgVolume,
      rollingReturns: [],
      volatility: info.volatility,
      lastUpdate: Date.now(),
      source: 'Simulated Feed'
    };

    this.states.set(sym, state);
    return state;
  }

  getState(symbol) {
    const sym = symbol.trim().toUpperCase();
    if (!this.states.has(sym)) {
      this.initSymbol(sym, this.seedData[sym]);
    }
    return this.states.get(sym);
  }

  async fetchQuote(symbol) {
    const data = this.getState(symbol);
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
    data.lastUpdate = Date.now();

    return {
      price: data.price,
      prevClose: data.prevClose,
      high52: data.high52,
      low52: data.low52,
      volume: data.volume,
      avgVolume: data.avgVolume,
      volatility: data.volatility,
      rollingReturns: [...data.rollingReturns],
      source: 'Simulated Feed',
      timestamp: data.lastUpdate
    };
  }
}

module.exports = SimulatedAdapter;
