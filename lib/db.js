/**
 * ARCHITECTURAL SEAM / PERSISTENCE LAYER:
 * 
 * At scale, this module serves as the primary abstraction seam to swap storage implementations.
 * - Watchlist & User Records -> PostgreSQL (relational persistence)
 * - LastSeen Price Data -> Redis (hot, ephemeral, high-throughput caching layer)
 * 
 * Internal implementation currently uses a local single-writer JSON file store at ./data.json
 * with debounced setImmediate persistence. External consumers MUST NOT depend on the JSON-file-backed
 * storage details and should interact only via the exported async/sync database API seam.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE = process.env.DATA_FILE || path.resolve(process.cwd(), 'data.json');

let store = {};
let persistScheduled = false;
let isWriting = false;

/**
 * Synchronously loads initial state from data.json if it exists.
 */
function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      if (raw.trim()) {
        store = JSON.parse(raw);
      }
    }
  } catch (err) {
    console.error('Failed to load database file:', err);
    store = {};
  }
}

// Initialize store from disk
loadData();

/**
 * Schedules a single-writer, debounced write to data.json using setImmediate.
 */
function scheduleSave() {
  if (persistScheduled) return;
  persistScheduled = true;

  setImmediate(async () => {
    persistScheduled = false;

    if (isWriting) {
      // Re-schedule if another write operation is currently in progress
      scheduleSave();
      return;
    }

    isWriting = true;
    try {
      const dataToSave = JSON.stringify(store, null, 2);
      await fs.promises.writeFile(DATA_FILE, dataToSave, 'utf8');
    } catch (err) {
      console.error('Failed to persist db to data.json:', err);
    } finally {
      isWriting = false;
    }
  });
}

/**
 * Ensures a user account exists in database storage, creating default records if necessary.
 *
 * @param {string} userId - Unique identifier for the user.
 * @returns {Object} User record store.
 */
function ensureUser(userId) {
  if (!userId) return null;
  const key = String(userId).trim();

  if (!store[key]) {
    store[key] = {
      watchlist: [],
      lastSeen: {},
      updatedAt: new Date().toISOString()
    };
    scheduleSave();
  }

  return store[key];
}

/**
 * Retrieves the symbol watchlist configured for a given user.
 *
 * @param {string} userId - Unique identifier for the user.
 * @returns {Array<Object>} List of watchlist items for the user.
 */
function getWatchlist(userId) {
  const user = ensureUser(userId);
  return user ? user.watchlist : [];
}

/**
 * Adds a financial symbol to a user's watchlist, deduping by uppercased symbol.
 *
 * @param {string} userId - Unique identifier for the user.
 * @param {string} symbol - Ticker symbol to add.
 * @param {number|null} [alertPrice=null] - Target alert threshold price.
 * @returns {Array<Object>} Updated watchlist.
 */
function addSymbol(userId, symbol, alertPrice = null) {
  const user = ensureUser(userId);
  if (!user || !symbol) return [];

  const sym = String(symbol).trim().toUpperCase();
  const existing = user.watchlist.find(item => item.symbol === sym);

  if (existing) {
    if (alertPrice !== undefined && alertPrice !== null) {
      existing.alertPrice = Number(alertPrice);
    }
  } else {
    user.watchlist.push({
      symbol: sym,
      addedAt: new Date().toISOString(),
      alertPrice: (alertPrice !== undefined && alertPrice !== null) ? Number(alertPrice) : null
    });
  }

  user.updatedAt = new Date().toISOString();
  scheduleSave();
  return user.watchlist;
}

/**
 * Removes a financial symbol from a user's watchlist, matching by uppercased symbol.
 *
 * @param {string} userId - Unique identifier for the user.
 * @param {string} symbol - Ticker symbol to remove.
 * @returns {Array<Object>} Updated watchlist.
 */
function removeSymbol(userId, symbol) {
  const user = ensureUser(userId);
  if (!user || !symbol) return [];

  const sym = String(symbol).trim().toUpperCase();
  user.watchlist = user.watchlist.filter(item => item.symbol.toUpperCase() !== sym);

  user.updatedAt = new Date().toISOString();
  scheduleSave();
  return user.watchlist;
}

/**
 * Sets or updates a target alert threshold price for a user's tracked symbol.
 *
 * @param {string} userId - Unique identifier for the user.
 * @param {string} symbol - Ticker symbol.
 * @param {number} alertPrice - Target alert threshold price.
 * @returns {Array<Object>} Updated watchlist.
 */
function setAlertPrice(userId, symbol, alertPrice) {
  const user = ensureUser(userId);
  if (!user || !symbol) return [];

  const sym = String(symbol).trim().toUpperCase();
  let item = user.watchlist.find(i => i.symbol === sym);

  const priceVal = (alertPrice !== undefined && alertPrice !== null) ? Number(alertPrice) : null;

  if (item) {
    item.alertPrice = priceVal;
  } else {
    item = {
      symbol: sym,
      addedAt: new Date().toISOString(),
      alertPrice: priceVal
    };
    user.watchlist.push(item);
  }

  user.updatedAt = new Date().toISOString();
  scheduleSave();
  return user.watchlist;
}

/**
 * Records the latest observed price and metrics for a symbol associated with a user.
 *
 * @param {string} userId - Unique identifier for the user.
 * @param {string} symbol - Ticker symbol.
 * @param {number|Object} priceData - Observed market price or price snapshot object.
 * @param {Object} [details={}] - Optional additional price details.
 * @returns {Object} Recorded lastSeen object.
 */
function recordLastSeen(userId, symbol, priceData, details = {}) {
  const user = ensureUser(userId);
  if (!user || !symbol) return null;

  const sym = String(symbol).trim().toUpperCase();
  const now = new Date();

  let price, ts, volatility, high52, low52;

  if (typeof priceData === 'object' && priceData !== null) {
    price = Number(priceData.price);
    ts = priceData.ts || priceData.lastUpdate || now.getTime();
    volatility = priceData.volatility !== undefined ? priceData.volatility : null;
    high52 = priceData.high52 !== undefined ? priceData.high52 : null;
    low52 = priceData.low52 !== undefined ? priceData.low52 : null;
  } else {
    price = Number(priceData);
    ts = details.ts || details.lastUpdate || now.getTime();
    volatility = details.volatility !== undefined ? details.volatility : null;
    high52 = details.high52 !== undefined ? details.high52 : null;
    low52 = details.low52 !== undefined ? details.low52 : null;
  }

  const existing = user.lastSeen[sym] || {};

  user.lastSeen[sym] = {
    price: !isNaN(price) ? price : (existing.price ?? null),
    ts: ts || existing.ts || now.getTime(),
    volatility: volatility !== null ? volatility : (existing.volatility ?? null),
    high52: high52 !== null ? high52 : (existing.high52 ?? null),
    low52: low52 !== null ? low52 : (existing.low52 ?? null),
    seenAt: now.toISOString()
  };

  user.updatedAt = now.toISOString();
  scheduleSave();
  return user.lastSeen[sym];
}

/**
 * Retrieves the last recorded price entry for a symbol associated with a user.
 *
 * @param {string} userId - Unique identifier for the user.
 * @param {string} symbol - Ticker symbol.
 * @returns {Object|null} Last recorded price object or null if not recorded.
 */
function getLastSeen(userId, symbol) {
  const user = ensureUser(userId);
  if (!user || !symbol) return null;

  const sym = String(symbol).trim().toUpperCase();
  return user.lastSeen[sym] || null;
}

/**
 * [DEV / Internal] Returns the list of userIds that currently have `symbol`
 * in their watchlist.  Used by the debug force-price route to compute
 * crossing results for all affected users in one call.
 *
 * @param {string} symbol - Ticker symbol (case-insensitive).
 * @returns {string[]} Array of userIds.
 */
function getUsersWatchingSymbol(symbol) {
  if (!symbol) return [];
  const sym = String(symbol).trim().toUpperCase();
  return Object.keys(store).filter(userId => {
    const user = store[userId];
    return Array.isArray(user.watchlist) && user.watchlist.some(i => i.symbol === sym);
  });
}

module.exports = {
  ensureUser,
  getWatchlist,
  addSymbol,
  removeSymbol,
  setAlertPrice,
  recordLastSeen,
  getLastSeen,
  getUsersWatchingSymbol,
};
