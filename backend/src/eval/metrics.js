// Small, dependency-free metric helpers shared by every eval.

/**
 * Set-based precision/recall/F1.
 * @param {string[]} predicted
 * @param {string[]} gold
 * @returns {{ precision: number, recall: number, f1: number }}
 */
export function precisionRecallF1(predicted, gold) {
  const predictedSet = new Set(predicted);
  const goldSet = new Set(gold);
  const hits = [...predictedSet].filter((item) => goldSet.has(item)).length;
  // Empty-vs-empty is a perfect match; an empty side otherwise scores zero.
  if (predictedSet.size === 0 && goldSet.size === 0) return { precision: 1, recall: 1, f1: 1 };
  const precision = predictedSet.size ? hits / predictedSet.size : 0;
  const recall = goldSet.size ? hits / goldSet.size : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/**
 * @param {boolean[]} outcomes  one entry per labelled case
 * @returns {number} fraction true; 1 when there are no cases
 */
export function accuracy(outcomes) {
  return outcomes.length ? outcomes.filter(Boolean).length / outcomes.length : 1;
}

/** @returns {number} value rounded to 3 decimals so reports are stable */
export function round3(value) {
  return Math.round(value * 1000) / 1000;
}
