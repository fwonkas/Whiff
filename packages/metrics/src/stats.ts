/** Small numeric helpers. All return null on empty input rather than NaN. */

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

export const mean = (xs: readonly number[]): number | null => (xs.length ? sum(xs) / xs.length : null);

export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export const ratio = (num: number, den: number): number | null => (den > 0 ? num / den : null);

/**
 * Trailing average over the last `window` values that exist. Nulls (e.g. a
 * metric that doesn't apply to one match) are skipped, not treated as zero.
 */
export function rollingMean(values: readonly (number | null)[], window: number): (number | null)[] {
  return values.map((v, i) => {
    if (v === null) return null;
    const recent: number[] = [];
    for (let j = i; j >= 0 && recent.length < window; j--) {
      const x = values[j];
      if (x !== null && x !== undefined) recent.push(x);
    }
    return mean(recent);
  });
}
