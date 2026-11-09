import { describe, expect, it } from 'vitest';
import type { Upgrade } from '../src/core/types';
import { type BoardContext, type Placement, checkPlacement, evaluate, validGrabPositions, findFreeSpot } from '../src/core/placement';
import { offsetToAxial } from '../src/core/hex';
import { canRotate, gridSizeForLevel, rotationUnlockLevel } from '../src/core/rules';

function up(id: string, cells: [number, number][], extra: Partial<Upgrade> = {}): Upgrade {
  const w = Math.max(...cells.map((c) => c[0])) + 1;
  const h = Math.max(...cells.map((c) => c[1])) + 1;
  return {
    id, key: id, class: 'GenericGunUpgrade', name: { en: id }, desc: null, rarity: 0, flags: [], effect: 'normal',
    source: 'WorldPool', icon: null, role: 'normal', props: [], gears: [],
    pattern: { w, h, cells: cells.map(([x, y]) => [x, y, 0]) },
    ...extra,
  };
}

const ups: Record<string, Upgrade> = {
  one: up('one', [[0, 0]]),
  bar: up('bar', [[0, 0], [0, 1], [0, 2]]), // vertical line of 3
  stack: up('stack', [[0, 0]], { flags: ['CanStack'] }),
  epic: up('epic', [[0, 0], [0, 1]], { rarity: 2 }),
  gold: up('gold', [[0, 0], [0, 1]], { rarity: 3 }),
  growA: up('growA', [[0, 0]], { role: 'gridExpander', rarity: 4 }),
  growB: up('growB', [[0, 0]], { role: 'gridExpander', rarity: 5 }),
};

const ctx = (over: Partial<BoardContext> = {}): BoardContext => ({
  getUpgrade: (id) => ups[id],
  accountLevel: 30,
  baseSize: { w: 5, h: 5 },
  ...over,
});

let n = 0;
const at = (upgradeId: string, x: number, y: number, rotation = 0, extra: Partial<Placement> = {}): Placement => ({
  uid: `p${n++}`,
  upgradeId,
  rotation,
  anchor: offsetToAxial(x, y),
  ...extra,
});
const codes = (s: ReturnType<typeof evaluate>, p: Placement) => (s.issues.get(p.uid) ?? []).map((i) => i.code);

describe('grid size (GridProfile)', () => {
  const def = [
    { level: 0, w: 5, h: 5 },
    { level: 3, w: 6, h: 5 },
    { level: 6, w: 6, h: 6 },
    { level: 10, w: 7, h: 6 },
  ];
  it('uses the last threshold <= gear level', () => {
    expect(gridSizeForLevel(def, 0)).toEqual({ w: 5, h: 5 });
    expect(gridSizeForLevel(def, 2)).toEqual({ w: 5, h: 5 });
    expect(gridSizeForLevel(def, 3)).toEqual({ w: 6, h: 5 });
    expect(gridSizeForLevel(def, 9)).toEqual({ w: 6, h: 6 });
    expect(gridSizeForLevel(def, 50)).toEqual({ w: 7, h: 6 });
  });
});

describe('rotation unlock (PlayerData.UpdateRarityRotations)', () => {
  it('per rarity thresholds 3/8/16/30', () => {
    expect([0, 1, 2, 3, 4, 5].map((r) => rotationUnlockLevel(r as 0))).toEqual([3, 8, 16, 30, 30, 30]);
    expect(canRotate(3, 29)).toBe(false);
    expect(canRotate(3, 30)).toBe(true);
    expect(canRotate(0, 3)).toBe(true);
  });
  it('rotated gold upgrade is invalid below level 30, unrotated is fine', () => {
    const p = at('gold', 0, 0, 1);
    expect(codes(evaluate(ctx({ accountLevel: 29 }), [p]), p)).toContain('rotationLocked');
    expect(evaluate(ctx({ accountLevel: 30 }), [p]).valid).toBe(true);
    const q = at('gold', 0, 0, 0);
    expect(evaluate(ctx({ accountLevel: 1 }), [q]).valid).toBe(true);
    const e = at('epic', 1, 1, 2);
    expect(codes(evaluate(ctx({ accountLevel: 15 }), [e]), e)).toContain('rotationLocked');
  });
});

describe('bounds', () => {
  it('fits in the corners incl. odd last column', () => {
    for (const [x, y] of [[0, 0], [4, 0], [0, 2], [4, 2], [3, 2]]) {
      const p = at('bar', x, y);
      expect(evaluate(ctx(), [p]).valid).toBe(true);
    }
  });
  it('rejects cells outside on every side', () => {
    for (const [x, y] of [[-1, 0], [5, 0], [0, -1], [0, 3], [3, 3]]) {
      const p = at('bar', x, y);
      expect(codes(evaluate(ctx(), [p]), p)).toContain('outOfBounds');
    }
  });
  it('a rotated bar near the bottom edge of an odd column', () => {
    // rotation 1: bar becomes diagonal; must stay within 5×5
    const ok = findFreeSpot(ctx(), [], { uid: 'x', upgradeId: 'bar' }, [1]);
    expect(ok).not.toBeNull();
    expect(evaluate(ctx(), [ok!]).valid).toBe(true);
  });
});

describe('overlap & duplicates', () => {
  it('detects overlap', () => {
    const a = at('bar', 1, 0);
    const b = at('one', 1, 2);
    const s = evaluate(ctx(), [a, b]);
    expect(codes(s, b)).toEqual(['overlap']);
    expect(checkPlacement(ctx(), [a], at('one', 2, 0)).ok).toBe(true);
    expect(checkPlacement(ctx(), [a], at('one', 1, 1)).ok).toBe(false);
  });
  it('non-stackable upgrade only once, CanStack many times', () => {
    const a = at('one', 0, 0);
    const b = at('one', 2, 2);
    expect(codes(evaluate(ctx(), [a, b]), b)).toEqual(['duplicate']);
    const s1 = at('stack', 0, 0);
    const s2 = at('stack', 2, 2);
    const s3 = at('stack', 4, 4);
    expect(evaluate(ctx(), [s1, s2, s3]).valid).toBe(true);
  });
  it('moving a placement does not collide with itself', () => {
    const a = at('bar', 0, 0);
    expect(checkPlacement(ctx(), [a], { ...a, anchor: offsetToAxial(0, 1) }).ok).toBe(true);
  });
});

describe('grid expanders', () => {
  it('+1 column on the right / +1 row at the bottom', () => {
    const c = at('growA', 0, 0, 0, { expand: 'column' });
    expect(evaluate(ctx(), [c]).size).toEqual({ w: 6, h: 5 });
    const r = at('growA', 0, 0, 0, { expand: 'row' });
    expect(evaluate(ctx(), [r]).size).toEqual({ w: 5, h: 6 });
    const both = evaluate(ctx(), [c, at('growB', 1, 0, 0, { expand: 'row' })]);
    expect(both.size).toEqual({ w: 6, h: 6 });
  });
  it('mods may use the added column', () => {
    const c = at('growA', 0, 0, 0, { expand: 'column' });
    const b = at('bar', 5, 0);
    expect(evaluate(ctx(), [c, b]).valid).toBe(true);
    expect(codes(evaluate(ctx(), [b]), b)).toContain('outOfBounds');
  });
  it('an expander cannot stand in the cell it adds itself', () => {
    const c = at('growA', 5, 0, 0, { expand: 'column' });
    const s = evaluate(ctx(), [c]);
    expect(codes(s, c)).toContain('expanderInactive');
    expect(s.size).toEqual({ w: 5, h: 5 });
  });
  it('mutually dependent expanders are both inactive', () => {
    const a = at('growA', 0, 5, 0, { expand: 'column' }); // needs the row
    const b = at('growB', 5, 0, 0, { expand: 'row' }); // needs the column
    const s = evaluate(ctx(), [a, b]);
    expect(codes(s, a)).toContain('expanderInactive');
    expect(codes(s, b)).toContain('expanderInactive');
  });
  it('a chain works: expander B stands in the column added by A', () => {
    const a = at('growA', 0, 0, 0, { expand: 'column' });
    const b = at('growB', 5, 0, 0, { expand: 'row' });
    expect(evaluate(ctx(), [a, b])).toMatchObject({ valid: true, size: { w: 6, h: 6 } });
  });
  it('the same expander cannot be used twice (not CanStack)', () => {
    const a = at('growA', 0, 0, 0, { expand: 'column' });
    const b = at('growA', 1, 0, 0, { expand: 'column' });
    expect(codes(evaluate(ctx(), [a, b]), b)).toContain('duplicate');
  });
  it('moving an expander away breaks mods that used its column', () => {
    const a = at('growA', 0, 0, 0, { expand: 'column' });
    const b = at('bar', 5, 0);
    const moved = { ...a, anchor: offsetToAxial(5, 4) };
    expect(checkPlacement(ctx(), [a, b], moved).ok).toBe(false);
  });
});

describe('available positions', () => {
  it('a single cell fits everywhere on an empty board', () => {
    expect(validGrabPositions(ctx(), [], { uid: 'x', upgradeId: 'one', rotation: 0 }, 0, { w: 5, h: 5 })).toHaveLength(25);
  });
  it('a vertical bar of 3 fits 5 columns × 3 rows', () => {
    expect(validGrabPositions(ctx(), [], { uid: 'x', upgradeId: 'bar', rotation: 0 }, 0, { w: 5, h: 5 })).toHaveLength(15);
  });
  it('pool restriction', () => {
    const p = at('one', 0, 0);
    expect(codes(evaluate(ctx({ pool: new Set(['bar']) }), [p]), p)).toContain('notInPool');
  });
});
