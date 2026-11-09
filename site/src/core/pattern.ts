import type { RawPattern } from './types';
import { type Axial, axialKey, neighbors, offsetToAxial, rotateAxial, rotateConnections } from './hex';

export interface PatternCell extends Axial {
  /** connection bits (visual links between hexes of the same module) */
  c: number;
}

/** A pattern in axial coordinates, normalised so that min q = 0 and min r = 0. */
export interface Pattern {
  cells: PatternCell[];
}

export interface Orientation {
  rotation: number; // 0..5
  pattern: Pattern;
  /** cells-only key, identical for rotations that produce the same footprint */
  shapeKey: string;
}

export function normalize(cells: PatternCell[]): Pattern {
  if (cells.length === 0) return { cells: [] };
  let mq = Infinity;
  let mr = Infinity;
  for (const c of cells) {
    if (c.q < mq) mq = c.q;
    if (c.r < mr) mr = c.r;
  }
  return { cells: cells.map((c) => ({ q: c.q - mq + 0, r: c.r - mr + 0, c: c.c })) };
}

/** Converts the game's offset pattern to a normalised axial pattern (cell order preserved). */
export function fromRaw(raw: RawPattern): Pattern {
  // the game always passes connections through CircularShiftLeft6Bits (& 63), even for rotation 0;
  // a few cells in data have 255 (editor artefact) which the game shows as 63.
  return normalize(raw.cells.map(([x, y, c]) => ({ ...offsetToAxial(x, y), c: c & 63 })));
}

/** Rotates by `steps` × 60° (game direction) and re-normalises. Cell order is preserved. */
export function rotate(p: Pattern, steps: number): Pattern {
  return normalize(
    p.cells.map((cell) => ({ ...rotateAxial(cell, steps), c: rotateConnections(cell.c, steps) })),
  );
}

export function shapeKey(p: Pattern): string {
  return p.cells
    .map(axialKey)
    .sort()
    .join(';');
}

/** All 6 rotations (index = rotation). */
export function allRotations(p: Pattern): Orientation[] {
  return [0, 1, 2, 3, 4, 5].map((rotation) => {
    const pattern = rotate(p, rotation);
    return { rotation, pattern, shapeKey: shapeKey(pattern) };
  });
}

/** Rotations with distinct footprints (symmetric shapes have fewer than 6). Used by the solver. */
export function uniqueOrientations(p: Pattern, allowed: readonly number[] = [0, 1, 2, 3, 4, 5]): Orientation[] {
  const seen = new Set<string>();
  const out: Orientation[] = [];
  for (const o of allRotations(p)) {
    if (!allowed.includes(o.rotation) || seen.has(o.shapeKey)) continue;
    seen.add(o.shapeKey);
    out.push(o);
  }
  return out;
}

/**
 * Visual links between cells, like HexMap.AddBidirectionalConnections: a connection bit on either cell
 * joins two neighbouring pattern cells (data often stores the bit on one side only).
 * Returns pairs of cell indices; `stubs` are bits pointing to a cell outside the pattern (drawn to the edge).
 */
export function patternLinks(p: Pattern): { pairs: [number, number][]; stubs: { cell: number; dir: number }[] } {
  const index = new Map(p.cells.map((c, i) => [axialKey(c), i]));
  const pairs: [number, number][] = [];
  const seen = new Set<string>();
  const stubs: { cell: number; dir: number }[] = [];
  p.cells.forEach((c, i) => {
    for (let d = 0; d < 6; d++) {
      if (!(c.c & (1 << d))) continue;
      const n = neighbors(c)[d];
      const j = index.get(axialKey(n));
      if (j === undefined) {
        stubs.push({ cell: i, dir: d });
        continue;
      }
      const k = i < j ? `${i}-${j}` : `${j}-${i}`;
      if (!seen.has(k)) {
        seen.add(k);
        pairs.push([i, j]);
      }
    }
  });
  return { pairs, stubs };
}

/**
 * Index of the cell where the upgrade icon should be drawn: always a cell of the pattern
 * (the geometric centroid may lie outside U-shaped or ring patterns). Chooses the most "interior"
 * cell (most neighbours inside the pattern), ties broken by distance to the centroid, then by order.
 */
export function iconCellIndex(p: Pattern): number {
  if (p.cells.length <= 1) return 0;
  const set = new Set(p.cells.map(axialKey));
  // centroid in cube space (distances are measured in screen-like units)
  const toXY = (a: Axial) => ({ x: 1.5 * a.q, y: Math.sqrt(3) * (a.r + a.q / 2) });
  const pts = p.cells.map(toXY);
  const cx = pts.reduce((s, v) => s + v.x, 0) / pts.length;
  const cy = pts.reduce((s, v) => s + v.y, 0) / pts.length;
  let best = 0;
  let bestN = -1;
  let bestD = Infinity;
  p.cells.forEach((c, i) => {
    const n = neighbors(c).filter((x) => set.has(axialKey(x))).length;
    const d = (pts[i].x - cx) ** 2 + (pts[i].y - cy) ** 2;
    if (n > bestN || (n === bestN && d < bestD - 1e-9)) {
      best = i;
      bestN = n;
      bestD = d;
    }
  });
  return best;
}

export function isConnected(p: Pattern): boolean {
  if (p.cells.length <= 1) return true;
  const set = new Set(p.cells.map(axialKey));
  const start = p.cells[0];
  const seen = new Set([axialKey(start)]);
  const stack: Axial[] = [start];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const n of neighbors(cur)) {
      const k = axialKey(n);
      if (set.has(k) && !seen.has(k)) {
        seen.add(k);
        stack.push(n);
      }
    }
  }
  return seen.size === set.size;
}

export interface PatternIssue {
  level: 'error' | 'warning';
  code: 'empty' | 'outOfBox' | 'duplicateCell' | 'disconnected';
  message: string;
}

/** Validates a raw game pattern. Disconnected patterns exist in the game (3 mods) -> warning only. */
export function validateRaw(raw: RawPattern): PatternIssue[] {
  const issues: PatternIssue[] = [];
  if (!raw.cells.length) issues.push({ level: 'error', code: 'empty', message: 'pattern has no cells' });
  const seen = new Set<string>();
  for (const [x, y] of raw.cells) {
    if (x < 0 || y < 0 || x >= raw.w || y >= raw.h)
      issues.push({ level: 'error', code: 'outOfBox', message: `cell ${x},${y} outside ${raw.w}×${raw.h}` });
    const k = `${x},${y}`;
    if (seen.has(k)) issues.push({ level: 'error', code: 'duplicateCell', message: `duplicate cell ${k}` });
    seen.add(k);
  }
  if (raw.cells.length && !isConnected(fromRaw(raw)))
    issues.push({ level: 'warning', code: 'disconnected', message: 'pattern is not connected' });
  return issues;
}
