/**
 * Base Market Data Adapter Interface
 * 
 * Defines the contract that all market data vendor integrations must implement.
 */
class BaseAdapter {
  constructor(name) {
    this.name = name;
  }

  /**
   * Checks whether this adapter supports fetching quotes for the given symbol.
   * @param {string} symbol
   * @returns {boolean}
   */
  isSupported(symbol) {
    throw new Error(`isSupported() must be implemented by ${this.name}`);
  }

  /**
   * Fetches latest market quote for a symbol.
   * @param {string} symbol
   * @returns {Promise<{ price: number, volume?: number, high52?: number, low52?: number, prevClose?: number } | null>}
   */
  async fetchQuote(symbol) {
    throw new Error(`fetchQuote() must be implemented by ${this.name}`);
  }
}

module.exports = BaseAdapter;
