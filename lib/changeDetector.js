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
function computeChange(current, lastSeen, alertPrice) {
  // Stub implementation
  return {
    score: 0,
    bucket: '',
    reasons: [],
    pctMoveSinceLastSeen: 0
  };
}

module.exports = {
  computeChange
};
