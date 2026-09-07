/**
 * Single Responsibility: Anomaly & Price Change Detection
 * 
 * Computes price changes, anomaly scores, classification buckets, percentage movements,
 * and rule-based reasons comparing current market price against baseline last-seen prices and alert thresholds.
 */

/**
 * Computes price change analytics and anomaly metrics between current price, last seen price, and target alert price.
 *
 * @param {number} current - The current market price.
 * @param {number} lastSeen - The baseline price last observed for this user/symbol.
 * @param {number} alertPrice - Target alert threshold price set by the user.
 * @returns {{
 *   score: number,
 *   bucket: string,
 *   reasons: string[],
 *   pctMoveSinceLastSeen: number
 * }} Object containing anomaly score, category bucket, reasons list, and percentage change.
 */
function computeChange(current, lastSeen, alertPrice, benchmark) {
  const currentObj = typeof current === 'object' && current !== null ? current : { price: Number(current) };
  const currentPrice = typeof current === 'number' ? current : (currentObj ? Number(currentObj.price) : NaN);

  const lastSeenObj = typeof lastSeen === 'object' && lastSeen !== null ? lastSeen : (typeof lastSeen === 'number' ? { price: Number(lastSeen) } : null);
  const lastSeenPrice = typeof lastSeen === 'number' ? lastSeen : (lastSeenObj ? Number(lastSeenObj.price) : NaN);

  const isStale = Boolean(currentObj && currentObj.isStale);

  // Handle case where lastSeen is missing or invalid
  if (!lastSeenObj || typeof lastSeenPrice !== 'number' || isNaN(lastSeenPrice)) {
    let score = 5;
    if (isStale) {
      score *= 0.35;
    }
    return {
      score,
      bucket: 'new',
      reasons: [],
      pctMoveSinceLastSeen: 0
    };
  }

  // Calculate percentage move since lastSeen
  const pctMoveSinceLastSeen = lastSeenPrice !== 0 ? ((currentPrice - lastSeenPrice) / lastSeenPrice) * 100 : 0;
  const movePct = Math.round(Math.abs(pctMoveSinceLastSeen) * 1e10) / 1e10;

  let rawScore = 0;
  const reasons = [];

  // 1. Volatility-normalized price move [move% / (volatility*100)], weight up to 45, only counts if ratio >= 2
  const volatility = typeof currentObj.volatility === 'number' ? currentObj.volatility : 0;
  if (volatility > 0) {
    const volatilityPct = volatility * 100;
    const ratio = movePct / volatilityPct;
    if (ratio >= 2) {
      const contrib = Math.min(ratio, 45);
      rawScore += contrib;
      reasons.push(`Volatility-normalized price move (ratio: ${ratio.toFixed(2)})`);
    }
  }

  // 2. Volume anomaly [volumeRatio >= 1.8], weight up to 30
  let volRatio = 0;
  if (typeof currentObj.volumeRatio === 'number') {
    volRatio = currentObj.volumeRatio;
  } else if (typeof currentObj.volume === 'number' && typeof currentObj.avgVolume === 'number' && currentObj.avgVolume > 0) {
    volRatio = currentObj.volume / currentObj.avgVolume;
  }
  if (volRatio >= 1.8) {
    const contrib = Math.min(volRatio, 30);
    rawScore += contrib;
    reasons.push(`Volume anomaly detected (ratio: ${volRatio.toFixed(2)})`);
  }

  // 3. 52-week high/low crossing (binary +20 each, only if it just crossed, not if already there)
  const lastSeenHigh52 = lastSeenObj.high52 !== undefined ? Number(lastSeenObj.high52) : undefined;
  const currentHigh52 = currentObj.high52 !== undefined ? Number(currentObj.high52) : undefined;
  const highRef = lastSeenHigh52 !== undefined ? lastSeenHigh52 : currentHigh52;

  if (highRef !== undefined && !isNaN(highRef)) {
    if (lastSeenPrice < highRef && currentPrice >= highRef) {
      rawScore += 20;
      reasons.push('Crossed 52-week high');
    }
  }

  const lastSeenLow52 = lastSeenObj.low52 !== undefined ? Number(lastSeenObj.low52) : undefined;
  const currentLow52 = currentObj.low52 !== undefined ? Number(currentObj.low52) : undefined;
  const lowRef = lastSeenLow52 !== undefined ? lastSeenLow52 : currentLow52;

  if (lowRef !== undefined && !isNaN(lowRef)) {
    if (lastSeenPrice > lowRef && currentPrice <= lowRef) {
      rawScore += 20;
      reasons.push('Crossed 52-week low');
    }
  }

  // 4. User alertPrice crossing (+35, compare sign change between lastSeen.price and current.price relative to alertPrice)
  const targetAlertPrice = (alertPrice !== undefined && alertPrice !== null && !isNaN(alertPrice))
    ? Number(alertPrice)
    : (currentObj.alertPrice !== undefined ? Number(currentObj.alertPrice) : (lastSeenObj.alertPrice !== undefined ? Number(lastSeenObj.alertPrice) : undefined));

  if (targetAlertPrice !== undefined && targetAlertPrice !== null && !isNaN(targetAlertPrice) && targetAlertPrice > 0) {
    const sign1 = Math.sign(lastSeenPrice - targetAlertPrice);
    const sign2 = Math.sign(currentPrice - targetAlertPrice);
    if (sign1 !== sign2 && sign1 !== 0) {
      rawScore += 35;
      reasons.push(`Crossed alert price (${targetAlertPrice})`);
    }
  }

  // 5. Idiosyncratic vs. Macro Signal Decomposition
  let benchmarkPct = 0;
  if (typeof benchmark === 'number') {
    benchmarkPct = benchmark;
  } else if (benchmark && typeof benchmark === 'object') {
    if (typeof benchmark.pctMove === 'number') benchmarkPct = benchmark.pctMove;
    else if (typeof benchmark.pctMoveSinceLastSeen === 'number') benchmarkPct = benchmark.pctMoveSinceLastSeen;
    else if (benchmark.price && benchmark.prevClose) benchmarkPct = ((benchmark.price - benchmark.prevClose) / benchmark.prevClose) * 100;
  } else if (currentObj && typeof currentObj.benchmarkPct === 'number') {
    benchmarkPct = currentObj.benchmarkPct;
  }

  const excessReturn = Math.round((pctMoveSinceLastSeen - benchmarkPct) * 100) / 100;
  const sym = currentObj.symbol || 'Asset';
  const stockMove = Math.round(pctMoveSinceLastSeen * 100) / 100;
  const absStock = Math.abs(stockMove);
  const absBench = Math.abs(benchmarkPct);
  const absExcess = Math.abs(excessReturn);

  let signalClassification = null;

  if (absStock >= 0.5) {
    // Condition A: Idiosyncratic Move (Stock-specific Alpha / Shock)
    const oppositeDir = Math.sign(stockMove) !== Math.sign(benchmarkPct) && absBench >= 0.2;
    const flatMarketStockSurge = absBench < 0.4 && absStock >= 0.8;
    const strongExcess = absExcess >= 1.0 && absExcess >= absStock * 0.6;

    if (oppositeDir || flatMarketStockSurge || strongExcess) {
      const stockSign = stockMove >= 0 ? '+' : '';
      const benchSign = benchmarkPct >= 0 ? '+' : '';
      const excessSign = excessReturn >= 0 ? '+' : '';

      const narrative = absBench < 0.3
        ? `${sym} ${stockSign}${stockMove.toFixed(1)}% while market was flat — stock-specific move`
        : `${sym} ${stockSign}${stockMove.toFixed(1)}% vs market ${benchSign}${benchmarkPct.toFixed(1)}% (${excessSign}${excessReturn.toFixed(1)}% alpha) — stock-specific move`;

      signalClassification = {
        type: 'idiosyncratic',
        badge: 'Idiosyncratic',
        excessReturn,
        benchmarkPct: Math.round(benchmarkPct * 100) / 100,
        narrative
      };

      if (benchmark !== undefined) {
        reasons.push('Idiosyncratic: ' + narrative);
      }
    } else if (absBench >= 0.5 && Math.sign(stockMove) === Math.sign(benchmarkPct)) {
      // Condition B: Macro-driven Move (Systemic Market Trend)
      const stockSign = stockMove >= 0 ? '+' : '';
      const benchSign = benchmarkPct >= 0 ? '+' : '';

      const narrative = `${sym} ${stockSign}${stockMove.toFixed(1)}%, but so was the market (${benchSign}${benchmarkPct.toFixed(1)}%) — macro-driven, nothing stock-specific`;

      signalClassification = {
        type: 'macro',
        badge: 'Macro-driven',
        excessReturn,
        benchmarkPct: Math.round(benchmarkPct * 100) / 100,
        narrative
      };

      if (benchmark !== undefined) {
        reasons.push('Macro: ' + narrative);
      }
    }
  }

  if (!signalClassification) {
    signalClassification = {
      type: 'in-line',
      badge: 'In-line',
      excessReturn,
      benchmarkPct: Math.round(benchmarkPct * 100) / 100,
      narrative: `${sym} trading in-line with baseline`
    };
  }

  // Total score calculation & capping at 100
  let totalScore = Math.min(100, rawScore);

  // Stale check adjustment
  if (isStale) {
    totalScore *= 0.35;
  }

  // Bucket classification
  let bucket;
  if (totalScore >= 45) {
    bucket = 'significant';
  } else if (totalScore >= 18) {
    bucket = 'notable';
  } else {
    bucket = 'quiet';
  }

  return {
    score: totalScore,
    bucket,
    reasons,
    pctMoveSinceLastSeen,
    signalClassification
  };
}

module.exports = {
  computeChange
};

