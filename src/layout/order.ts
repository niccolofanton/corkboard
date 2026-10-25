// Reading order of boxes laid out in rows (or, along x, in columns): the order "tidy" lays cards out
// in and the order align / separate stack them in. Pure.
import { boxCx, boxCy, boxH, boxW, type Aabb } from '../interact/geometry';
import { median } from './stats';

const byId = (a: { id: string }, b: { id: string }): number =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/**
 * Bands along `axis` ('y': rows, top to bottom; 'x': columns, left to right), each band sorted along the
 * other axis. Items are clustered by centre (a band's tolerance is half the median extent along `axis`,
 * measured from the band's running mean centre), so cards of a row that differ in height stay one row
 * instead of being shuffled by their centres.
 */
export function bandOrder<T extends { id: string; box: Aabb }>(
  items: readonly T[],
  axis: 'x' | 'y' = 'y',
): T[] {
  const along = axis === 'y' ? boxCy : boxCx;
  const across = (b: Aabb): number => (axis === 'y' ? b.minX : b.minY);
  const tol = median(items.map((it) => (axis === 'y' ? boxH(it.box) : boxW(it.box)))) / 2;
  const sorted = items.slice().sort((a, b) => along(a.box) - along(b.box) || byId(a, b));
  const bands: T[][] = [];
  let band: T[] = [];
  let sum = 0;
  for (const it of sorted) {
    const c = along(it.box);
    if (band.length > 0 && c - sum / band.length > tol) {
      bands.push(band);
      band = [];
      sum = 0;
    }
    band.push(it);
    sum += c;
  }
  if (band.length > 0) bands.push(band);

  const ordered: T[] = [];
  for (const b of bands) {
    b.sort((x, y) => across(x.box) - across(y.box) || byId(x, y));
    for (const it of b) ordered.push(it);
  }
  return ordered;
}
