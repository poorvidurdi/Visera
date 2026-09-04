const assert = require('assert');
const { computeChange } = require('../lib/changeDetector');

console.log('Running unit tests for changeDetector.computeChange...\n');

// 1. Missing lastSeen
{
  const res = computeChange({ price: 100 }, null);
  assert.strictEqual(res.bucket, 'new');
  assert.strictEqual(res.score, 5);
  assert.deepStrictEqual(res.reasons, []);
  assert.strictEqual(res.pctMoveSinceLastSeen, 0);
  console.log('✓ Missing lastSeen returns bucket "new" and score 5');
}

// 2. Missing lastSeen with isStale
{
  const res = computeChange({ price: 100, isStale: true }, null);
  assert.strictEqual(res.bucket, 'new');
  assert.strictEqual(res.score, 5 * 0.35);
  assert.deepStrictEqual(res.reasons, []);
  assert.strictEqual(res.pctMoveSinceLastSeen, 0);
  console.log('✓ Missing lastSeen with isStale multiplies score by 0.35');
}

// 3. Volatility-normalized move (ratio < 2 => 0 points; ratio >= 2 => min(ratio, 45))
{
  // lastSeen: 100, current: 100.1, volatility: 0.0015 (0.15%)
  // move% = 0.1%, ratio = 0.1 / 0.15 = 0.67 < 2 => no points
  const resLow = computeChange(
    { price: 100.1, volatility: 0.0015 },
    { price: 100 }
  );
  assert.strictEqual(resLow.score, 0);
  assert.strictEqual(resLow.bucket, 'quiet');
  assert.deepStrictEqual(resLow.reasons, []);
  assert.strictEqual(Math.round(resLow.pctMoveSinceLastSeen * 100) / 100, 0.1);
  console.log('✓ Volatility move ratio < 2 does not contribute to score');

  // lastSeen: 100, current: 100.45, volatility: 0.0015 (0.15%)
  // move% = 0.45%, ratio = 0.45 / 0.15 = 3 >= 2 => 3 points
  const resHigh = computeChange(
    { price: 100.45, volatility: 0.0015 },
    { price: 100 }
  );
  assert.strictEqual(resHigh.score, 3);
  assert.strictEqual(resHigh.bucket, 'quiet');
  assert.strictEqual(resHigh.reasons.length, 1);
  assert.ok(resHigh.reasons[0].includes('Volatility-normalized price move'));
  console.log('✓ Volatility move ratio >= 2 adds ratio to score and records reason');

  // Cap at 45
  // lastSeen: 100, current: 110, volatility: 0.001 (0.1%)
  // move% = 10%, ratio = 10 / 0.1 = 100 >= 2 => capped at 45 points
  const resCapped = computeChange(
    { price: 110, volatility: 0.001 },
    { price: 100 }
  );
  assert.strictEqual(resCapped.score, 45);
  assert.strictEqual(resCapped.bucket, 'significant');
  console.log('✓ Volatility move score contribution is capped at 45');
}

// 4. Volume anomaly (volumeRatio >= 1.8 => min(volumeRatio, 30))
{
  // volumeRatio 1.5 < 1.8 => 0 points
  const resLow = computeChange(
    { price: 100, volumeRatio: 1.5 },
    { price: 100 }
  );
  assert.strictEqual(resLow.score, 0);
  assert.deepStrictEqual(resLow.reasons, []);

  // volumeRatio 2.5 >= 1.8 => 2.5 points
  const resMid = computeChange(
    { price: 100, volumeRatio: 2.5 },
    { price: 100 }
  );
  assert.strictEqual(resMid.score, 2.5);
  assert.strictEqual(resMid.reasons.length, 1);
  assert.ok(resMid.reasons[0].includes('Volume anomaly'));

  // volumeRatio 50 => capped at 30 points
  const resCap = computeChange(
    { price: 100, volumeRatio: 50 },
    { price: 100 }
  );
  assert.strictEqual(resCap.score, 30);
  assert.strictEqual(resCap.bucket, 'notable');
  console.log('✓ Volume anomaly contributes volumeRatio (capped at 30) when ratio >= 1.8');
}

// 5. 52-week High/Low crossing (+20 each, only if just crossed)
{
  // High crossing: lastSeen 190 < high52 200, current 205 >= 200 => +20
  const resHighCross = computeChange(
    { price: 205, high52: 200 },
    { price: 190, high52: 200 }
  );
  assert.strictEqual(resHighCross.score, 20);
  assert.strictEqual(resHighCross.bucket, 'notable');
  assert.deepStrictEqual(resHighCross.reasons, ['Crossed 52-week high']);
  console.log('✓ 52-week high crossing adds +20');

  // Already at high: lastSeen 200 >= high52 200, current 205 >= 200 => +0
  const resAlreadyHigh = computeChange(
    { price: 205, high52: 200 },
    { price: 200, high52: 200 }
  );
  assert.strictEqual(resAlreadyHigh.score, 0);
  assert.deepStrictEqual(resAlreadyHigh.reasons, []);
  console.log('✓ 52-week high does not trigger if already at high');

  // Low crossing: lastSeen 110 > low52 100, current 95 <= 100 => +20
  const resLowCross = computeChange(
    { price: 95, low52: 100 },
    { price: 110, low52: 100 }
  );
  assert.strictEqual(resLowCross.score, 20);
  assert.strictEqual(resLowCross.bucket, 'notable');
  assert.deepStrictEqual(resLowCross.reasons, ['Crossed 52-week low']);
  console.log('✓ 52-week low crossing adds +20');

  // Already at low: lastSeen 100 <= low52 100, current 95 <= 100 => +0
  const resAlreadyLow = computeChange(
    { price: 95, low52: 100 },
    { price: 100, low52: 100 }
  );
  assert.strictEqual(resAlreadyLow.score, 0);
  assert.deepStrictEqual(resAlreadyLow.reasons, []);
  console.log('✓ 52-week low does not trigger if already at low');
}

// 6. User alertPrice crossing (+35, sign change relative to alertPrice)
{
  // Upward crossing: lastSeen 90 < alert 100, current 105 >= 100 => +35
  const resUp = computeChange(
    { price: 105 },
    { price: 90 },
    100
  );
  assert.strictEqual(resUp.score, 35);
  assert.strictEqual(resUp.bucket, 'notable');
  assert.deepStrictEqual(resUp.reasons, ['Crossed alert price (100)']);

  // Downward crossing: lastSeen 110 > alert 100, current 95 <= 100 => +35
  const resDown = computeChange(
    { price: 95 },
    { price: 110 },
    100
  );
  assert.strictEqual(resDown.score, 35);
  assert.strictEqual(resDown.bucket, 'notable');
  assert.deepStrictEqual(resDown.reasons, ['Crossed alert price (100)']);

  // Same side (no crossing): lastSeen 90, current 95, alert 100 => 0
  const resSame = computeChange(
    { price: 95 },
    { price: 90 },
    100
  );
  assert.strictEqual(resSame.score, 0);
  assert.deepStrictEqual(resSame.reasons, []);

  // Was already at alertPrice: lastSeen 100, current 105, alert 100 => 0
  const resOnAlert = computeChange(
    { price: 105 },
    { price: 100 },
    100
  );
  assert.strictEqual(resOnAlert.score, 0);
  assert.deepStrictEqual(resOnAlert.reasons, []);

  console.log('✓ Alert price crossing (+35) correctly detects sign changes relative to alertPrice');
}

// 7. Stale multiplier (multiply total score by 0.35)
{
  // Score before stale = 45 (significant), stale multiplies by 0.35 => 15.75 (quiet)
  const resStale = computeChange(
    { price: 110, volatility: 0.001, isStale: true },
    { price: 100 }
  );
  assert.strictEqual(resStale.score, 45 * 0.35);
  assert.strictEqual(resStale.bucket, 'quiet');
  console.log('✓ Stale flag multiplies total score by 0.35 and updates bucket accordingly');
}

// 8. Bucketing thresholds (>=45 significant, >=18 notable, else quiet)
{
  assert.strictEqual(computeChange({ price: 100, volumeRatio: 50 }, { price: 100 }).bucket, 'notable'); // 30
  assert.strictEqual(computeChange({ price: 110, volatility: 0.001 }, { price: 100 }).bucket, 'significant'); // 45
  assert.strictEqual(computeChange({ price: 100 }, { price: 100 }).bucket, 'quiet'); // 0
  console.log('✓ Bucketing thresholds (>=45 significant, >=18 notable, else quiet) verified');
}

// 9. All factors triggering together (capped total score at 100)
{
  // Volatility ratio (45) + Volume ratio (30) + High crossing (20) + Alert crossing (35) = 130 => cap at 100
  const resAll = computeChange(
    { price: 210, volatility: 0.001, volumeRatio: 35, high52: 200 },
    { price: 190, high52: 200 },
    200
  );
  assert.strictEqual(resAll.score, 100);
  assert.strictEqual(resAll.bucket, 'significant');
  assert.strictEqual(resAll.reasons.length, 4);
  console.log('✓ Combined factors correctly cap maximum total score at 100 and record all reasons');
}

console.log('\nALL UNIT TESTS PASSED!');
