// Tiny numeric helpers shared by the layout modules. Pure.

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

// Median of a list (the mean of the two middle values for an even count); 0 for an empty list.
// Sorts a copy: the callers run once per carry or per command, never per frame.
export function median(values: readonly number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  // Float64Array#sort is numeric (a plain Array#sort would compare as strings).
  const sorted = Float64Array.from(values).sort();
  const mid = n >> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
