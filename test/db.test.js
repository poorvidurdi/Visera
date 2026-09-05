const assert = require('assert');
const fs = require('fs');
const path = require('path');

const testDataFile = path.resolve(__dirname, 'test_data.json');
process.env.DATA_FILE = testDataFile;

// Cleanup existing test data file if present
if (fs.existsSync(testDataFile)) {
  fs.unlinkSync(testDataFile);
}

const db = require('../lib/db');

console.log('Running unit tests for db.js...\n');

(async () => {
  try {
    // 1. ensureUser
    const user1 = db.ensureUser('user1');
    assert.ok(user1, 'User record created');
    assert.deepStrictEqual(user1.watchlist, []);
    assert.deepStrictEqual(user1.lastSeen, {});
    assert.ok(typeof user1.updatedAt === 'string');
    console.log('✓ ensureUser creates default user record');

    // 2. addSymbol & deduping by uppercased symbol
    db.addSymbol('user1', 'aapl');
    db.addSymbol('user1', 'AAPL');
    db.addSymbol('user1', 'AaPl', 150);
    const wl = db.getWatchlist('user1');
    assert.strictEqual(wl.length, 1);
    assert.strictEqual(wl[0].symbol, 'AAPL');
    assert.strictEqual(wl[0].alertPrice, 150);
    assert.ok(typeof wl[0].addedAt === 'string');
    console.log('✓ addSymbol dedupes by uppercased symbol');

    db.addSymbol('user1', 'googl', 180);
    assert.strictEqual(db.getWatchlist('user1').length, 2);

    // 3. removeSymbol
    db.removeSymbol('user1', 'googl');
    const wlAfterRemove = db.getWatchlist('user1');
    assert.strictEqual(wlAfterRemove.length, 1);
    assert.strictEqual(wlAfterRemove[0].symbol, 'AAPL');
    console.log('✓ removeSymbol correctly removes item by uppercased symbol');

    // 4. setAlertPrice
    db.setAlertPrice('user1', 'aapl', 190.5);
    const updatedWl = db.getWatchlist('user1');
    assert.strictEqual(updatedWl[0].alertPrice, 190.5);
    console.log('✓ setAlertPrice updates alert price for existing symbol');

    db.setAlertPrice('user1', 'msft', 420);
    const msftWl = db.getWatchlist('user1');
    assert.strictEqual(msftWl.length, 2);
    assert.strictEqual(msftWl[1].symbol, 'MSFT');
    assert.strictEqual(msftWl[1].alertPrice, 420);
    console.log('✓ setAlertPrice adds new symbol if not present in watchlist');

    // 5. recordLastSeen & getLastSeen
    const snapshot = {
      price: 185.50,
      volatility: 0.0015,
      high52: 199.62,
      low52: 164.08,
      ts: 1725488698000
    };
    db.recordLastSeen('user1', 'aapl', snapshot);
    const lastSeen = db.getLastSeen('user1', 'AAPL');
    assert.ok(lastSeen, 'lastSeen record exists');
    assert.strictEqual(lastSeen.price, 185.50);
    assert.strictEqual(lastSeen.volatility, 0.0015);
    assert.strictEqual(lastSeen.high52, 199.62);
    assert.strictEqual(lastSeen.low52, 164.08);
    assert.strictEqual(lastSeen.ts, 1725488698000);
    assert.ok(typeof lastSeen.seenAt === 'string');
    console.log('✓ recordLastSeen & getLastSeen store and retrieve snapshot object correctly');

    // Record numeric price
    db.recordLastSeen('user1', 'msft', 420.10);
    const msftSeen = db.getLastSeen('user1', 'msft');
    assert.strictEqual(msftSeen.price, 420.10);
    assert.ok(msftSeen.ts > 0);
    assert.ok(typeof msftSeen.seenAt === 'string');
    console.log('✓ recordLastSeen handles numeric price input');

    // 6. Persistence check after setImmediate
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(fs.existsSync(testDataFile), 'Data file saved to disk via debounced setImmediate');
    const fileContent = JSON.parse(fs.readFileSync(testDataFile, 'utf8'));
    assert.ok(fileContent.user1, 'User record present in data file');
    assert.strictEqual(fileContent.user1.watchlist.length, 2);
    assert.strictEqual(fileContent.user1.lastSeen.AAPL.price, 185.50);
    console.log('✓ Single-writer debounced persistence writes schema to JSON file correctly');

    console.log('\nALL DB UNIT TESTS PASSED!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  } finally {
    if (fs.existsSync(testDataFile)) {
      fs.unlinkSync(testDataFile);
    }
  }
})();
