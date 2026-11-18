/** Rough P2PKH sizes at 1 sat/byte: each input ~148 B, plus the tx overhead and one output. */
export const FEE_PER_INPUT = 150n;
export const FEE_BASE = 60n;

/**
 * Picks the fewest coins (largest first) whose total covers `target` plus the fee of spending them.
 * Returns their indexes in `values`, or null if all coins together are not enough.
 */
export function selectCoins(values: readonly bigint[], target: bigint, feePerInput = FEE_PER_INPUT, baseFee = FEE_BASE): number[] | null {
  const order = values.map((v, i) => [v, i] as const).sort((a, b) => (b[0] > a[0] ? 1 : b[0] < a[0] ? -1 : 0));
  const picked: number[] = [];
  let sum = 0n;
  for (const [value, index] of order) {
    picked.push(index);
    sum += value;
    if (sum >= target + baseFee + feePerInput * BigInt(picked.length)) return picked;
  }
  return null;
}
