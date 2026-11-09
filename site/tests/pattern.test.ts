import { describe, expect, it } from 'vitest';
import { fromRaw, isConnected, rotate, uniqueOrientations, validateRaw } from '../src/core/pattern';
import type { RawPattern } from '../src/core/types';

const raw = (w: number, h: number, cells: [number, number][]): RawPattern => ({
  w,
  h,
  cells: cells.map(([x, y]) => [x, y, 0]),
});

describe('pattern', () => {
  it('normalises to min q/r = 0', () => {
    const p = fromRaw(raw(3, 3, [[1, 1], [2, 1]]));
    expect(Math.min(...p.cells.map((c) => c.q))).toBe(0);
    expect(Math.min(...p.cells.map((c) => c.r))).toBe(0);
  });

  it('counts unique orientations of symmetric shapes', () => {
    expect(uniqueOrientations(fromRaw(raw(1, 1, [[0, 0]])))).toHaveLength(1);
    // straight vertical line of 3 -> 3 distinct orientations
    expect(uniqueOrientations(fromRaw(raw(1, 3, [[0, 0], [0, 1], [0, 2]])))).toHaveLength(3);
    // triangle of 3 mutually adjacent hexes -> 2 orientations
    expect(uniqueOrientations(fromRaw(raw(2, 2, [[0, 0], [0, 1], [1, 0]])))).toHaveLength(2);
    // ring of 6 around an empty centre -> 1
    const ring = raw(3, 3, [[1, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1]]); // neighbours of odd column (1,1)
    expect(isConnected(fromRaw(ring))).toBe(true);
    expect(uniqueOrientations(fromRaw(ring))).toHaveLength(1);
  });

  it('respects allowed rotations (locked rarity -> only rotation 0)', () => {
    const p = fromRaw(raw(1, 3, [[0, 0], [0, 1], [0, 2]]));
    expect(uniqueOrientations(p, [0]).map((o) => o.rotation)).toEqual([0]);
  });

  it('rotation keeps the cell count and cell order', () => {
    const p = fromRaw({ w: 2, h: 2, cells: [[0, 0, 8], [0, 1, 1], [1, 0, 0]] });
    const r = rotate(p, 1);
    expect(r.cells).toHaveLength(3);
    expect(r.cells[0].c).toBe(4); // S(8) -> SE(4) after one step
  });

  it('validates raw patterns', () => {
    expect(validateRaw(raw(2, 2, []))[0].code).toBe('empty');
    expect(validateRaw(raw(2, 2, [[3, 0]])).some((i) => i.code === 'outOfBox')).toBe(true);
    expect(validateRaw(raw(3, 3, [[0, 0], [2, 2]])).map((i) => i.code)).toEqual(['disconnected']);
    expect(validateRaw(raw(2, 2, [[0, 0], [0, 1]]))).toEqual([]);
  });
});

describe('icon cell', () => {
  it('is the middle of a line and the bend of a U, never outside', async () => {
    const { iconCellIndex } = await import('../src/core/pattern');
    expect(iconCellIndex(fromRaw(raw(1, 3, [[0, 0], [0, 1], [0, 2]])))).toBe(1);
    // U: two vertical arms joined at the bottom through column 1
    const u = fromRaw(raw(3, 3, [[0, 0], [0, 1], [1, 1], [2, 0], [2, 1]]));
    expect(iconCellIndex(u)).toBe(2);
  });
});

describe('pattern links (AddBidirectionalConnections)', () => {
  it('a one-sided bit joins both cells; bits to cells outside become stubs', async () => {
    const { patternLinks } = await import('../src/core/pattern');
    // (0,0) has S(8) towards (0,1); (0,1) has no reciprocal N bit; (0,1) has SE(4) pointing outside
    const p = fromRaw({ w: 1, h: 2, cells: [[0, 0, 8], [0, 1, 4]] });
    const l = patternLinks(p);
    expect(l.pairs).toEqual([[0, 1]]);
    expect(l.stubs).toEqual([{ cell: 1, dir: 2 }]);
  });
});
