/** Pattern Infuser: rules, size ratio, solver donors, build file round-trip. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData, Upgrade } from '../src/core/types';
import { canInfuse, evaluate, infuseDonors, patternSizeRatio, placementPattern } from '../src/core/placement';
import { fromRaw, uniqueOrientations } from '../src/core/pattern';
import { solve, type SolveItem } from '../src/core/solver/solve';
import { prepareSolve, solverOrientations } from '../src/core/solver/prepare';
import { exportBuild, importBuild, type ImportContext } from '../src/core/buildfile';
import { boardContext } from '../src/store/build';

const data: GameData = JSON.parse(readFileSync(resolve(__dirname, '../public/data/game.json'), 'utf-8'));
const loaded = { game: data, overrides: { fields: {} }, comments: { upgrades: {} }, issues: [] };
const all = Object.values(data.upgrades);
const get = (id: string) => data.upgrades[id];

const shape = (cells: [number, number][], extra: { patternFrom?: string; penalty?: number } = {}) =>
  uniqueOrientations(fromRaw({ w: 9, h: 9, cells: cells.map(([x, y]) => [x, y, 0]) })).map((o) => ({
    rotation: o.rotation,
    cells: o.pattern.cells.map(({ q, r }) => ({ q, r })),
    ...extra,
  }));

describe('pattern size ratio (UpgradeProperty.GetPatternSizeRatio)', () => {
  it('matches the game formula', () => {
    expect(patternSizeRatio(5, 5)).toBe(1);
    expect(patternSizeRatio(3, 6)).toBeCloseTo(0.75); // half the size -> halfway to 1
    expect(patternSizeRatio(9, 6)).toBeCloseTo(1.34); // capped at 1 + 3/7.5, then 15 % back to 1
    expect(patternSizeRatio(1, 10)).toBeCloseTo(0.55);
    expect(patternSizeRatio(3, 6, true)).toBeCloseTo(1.2);
  });
});

describe('infuse rules', () => {
  const normal = all.filter((u) => u.role === 'normal' && u.rarity !== 5);
  const target = normal.find((u) => infuseDonors(u, all).length > 3)!;

  it('donor: same gear, same rarity, not itself', () => {
    const donors = infuseDonors(target, all);
    for (const d of donors) {
      expect(d.rarity).toBe(target.rarity);
      expect(d.gears.some((g) => target.gears.includes(g))).toBe(true);
      expect(d.id).not.toBe(target.id);
    }
    expect(canInfuse(target, target)).toBe(false);
    const otherRarity = normal.find((u) => u.rarity !== target.rarity && u.gears.some((g) => target.gears.includes(g)));
    expect(canInfuse(target, otherRarity)).toBe(false);
  });

  it('an infused placement occupies the donor shape; an invalid donor is reported', () => {
    const donor = infuseDonors(target, all).find((d) => d.pattern.cells.length !== target.pattern.cells.length)!;
    expect(placementPattern(get, target, 0, donor.id).cells.length).toBe(donor.pattern.cells.length);
    const gear = data.gears.find((g) => target.gears.includes(g.id))!;
    const ctx = boardContext(loaded, gear, 30, 10);
    const st = evaluate(ctx, [{ uid: 'a', upgradeId: target.id, rotation: 0, anchor: { q: 0, r: 0 }, patternFrom: target.id }]);
    expect(st.issues.get('a')?.some((i) => i.code === 'badInfusion')).toBe(true);
  });

  it('extractor: most upgrades scale with the pattern size, some are neutral', () => {
    const scaled = normal.filter((u) => u.patternScaled).length;
    expect(scaled).toBeGreaterThan(normal.length / 2);
    expect(scaled).toBeLessThan(normal.length);
  });
});

describe('solver with donor patterns', () => {
  const line4: [number, number][] = [[0, 0], [0, 1], [0, 2], [0, 3]];
  const pair: [number, number][] = [[0, 0], [0, 1]];
  const size = { w: 1, h: 6 }; // one column: a line of 4 + a pair, never two lines

  it('a smaller donor shape is used only when it places more weight', () => {
    const items: SolveItem[] = [
      { upgradeId: 'A', weight: 10, count: 1, orientations: shape(line4) },
      { upgradeId: 'B', weight: 5, count: 1, orientations: [...shape(line4), ...shape(pair, { patternFrom: 'D', penalty: 1e-5 })] },
    ];
    const without = solve({ baseSize: size, items: [items[0], { ...items[1], orientations: shape(line4) }], topK: 1 });
    expect(without.solutions[0].score).toBe(10);
    const res = solve({ baseSize: size, items, topK: 1 });
    expect(res.solutions[0].score).toBe(15);
    expect(res.solutions[0].placements.find((p) => p.upgradeId === 'B')?.patternFrom).toBe('D');
    expect(res.solutions[0].placements.find((p) => p.upgradeId === 'A')?.patternFrom).toBeUndefined();
  });

  it('keeps the own shape when everything fits, shrinks with "force"', () => {
    const big = { w: 5, h: 5 };
    const normalItems: SolveItem[] = [{ upgradeId: 'A', weight: 5, count: 1, orientations: [...shape(line4), ...shape(pair, { patternFrom: 'D', penalty: 1e-5 })] }];
    expect(solve({ baseSize: big, items: normalItems, topK: 1 }).solutions[0].placements[0].patternFrom).toBeUndefined();
    const forced: SolveItem[] = [
      { upgradeId: 'A', weight: 5, count: 1, orientations: [...shape(line4, { penalty: 4e-3 }), ...shape(pair, { patternFrom: 'D', penalty: 2e-3 + 1e-5 })] },
    ];
    const res = solve({ baseSize: big, items: forced, topK: 1 });
    expect(res.solutions[0].score).toBe(5);
    expect(res.solutions[0].placements[0].patternFrom).toBe('D');
  });

  it('prepareSolve: donors never bigger; "no loss" keeps the size of pattern-dependent upgrades', () => {
    const gear = data.gears.find((g) => g.key === 'Bruiser')!;
    const ctx = boardContext(loaded, gear, 30, 10);
    const pool = [...ctx.pool!].map(get).filter((u): u is Upgrade => !!u && u.role === 'normal');
    const scaled = pool.find((u) => u.patternScaled && infuseDonors(u, all).some((d) => d.pattern.cells.length < u.pattern.cells.length))!;
    const neutral = pool.find((u) => !u.patternScaled && infuseDonors(u, all).some((d) => d.pattern.cells.length < u.pattern.cells.length));
    const rot = [0, 1, 2, 3, 4, 5];
    const base = { keepPlaced: false, allUpgrades: all };
    const loose = solverOrientations(scaled, rot, { ...base, infuser: { enabled: true, neutralOnly: false, forceShrink: false } });
    expect(loose.every((o) => o.cells.length <= scaled.pattern.cells.length)).toBe(true);
    expect(loose.some((o) => o.cells.length < scaled.pattern.cells.length)).toBe(true);
    const strict = solverOrientations(scaled, rot, { ...base, infuser: { enabled: true, neutralOnly: true, forceShrink: false } });
    expect(strict.every((o) => o.cells.length === scaled.pattern.cells.length)).toBe(true);
    if (neutral) {
      const n = solverOrientations(neutral, rot, { ...base, infuser: { enabled: true, neutralOnly: true, forceShrink: false } });
      expect(n.some((o) => o.cells.length < neutral.pattern.cells.length)).toBe(true);
    }
    const off = prepareSolve(ctx, [], [{ upgradeId: scaled.id, weight: 5, count: 1 }], { keepPlaced: false });
    expect(off.items[0].orientations.every((o) => !o.patternFrom)).toBe(true);
  });
});

describe('auto-fill is never worse with the infuser', () => {
  const gear = data.gears.find((g) => g.key === 'Mycologist')!;
  const ctx = boardContext(loaded, gear, 30, 10);
  const pool = [...ctx.pool!].map(get).filter((u): u is Upgrade => !!u && u.role === 'normal');
  const sel = pool.slice(0, 14).map((u) => ({ upgradeId: u.id, weight: 5, count: 1 }));
  const run = (infuser?: { enabled: boolean; neutralOnly: boolean; forceShrink: boolean }, placements = [] as Parameters<typeof prepareSolve>[1], ms = 600) =>
    solve(prepareSolve(ctx, placements, sel, { keepPlaced: false, timeLimitMs: ms, topK: 5, infuser, allUpgrades: all })).solutions[0];

  it('own shapes are searched first: every infuser mode reaches the score found without it', () => {
    const plain = run();
    for (const inf of [
      { enabled: true, neutralOnly: true, forceShrink: true },
      { enabled: true, neutralOnly: false, forceShrink: true },
      { enabled: true, neutralOnly: false, forceShrink: false },
    ])
      expect(run(inf).score, JSON.stringify(inf)).toBeGreaterThanOrEqual(plain.score);
  });

  it('the current valid build is a starting solution (even with almost no search time)', () => {
    const best = run(undefined, [], 1500);
    let n = 0;
    const current = best.placements.map((p) => ({ uid: `c${n++}`, upgradeId: p.upgradeId, rotation: p.rotation, anchor: p.anchor, ...(p.expand ? { expand: p.expand } : {}) }));
    expect(evaluate(ctx, current).valid).toBe(true);
    const quick = run({ enabled: true, neutralOnly: true, forceShrink: true }, current, 1);
    expect(quick.score).toBeGreaterThanOrEqual(best.score);
  });
});

describe('build file', () => {
  it('patternFrom round-trips; an invalid donor is dropped with a warning', () => {
    const target = all.find((u) => u.role === 'normal' && u.rarity !== 5 && infuseDonors(u, all).length > 0)!;
    const donor = infuseDonors(target, all)[0];
    const gear = data.gears.find((g) => target.gears.includes(g.id))!;
    const ctx = boardContext(loaded, gear, 30, 10);
    let n = 0;
    const ictx: ImportContext = { data, boardContext: (g, a, l) => boardContext(loaded, g, a, l), newUid: () => `i${n++}` };
    const snap = {
      gear,
      accountLevel: 30,
      gearLevel: 10,
      placements: [{ uid: 'p', upgradeId: target.id, rotation: 0, anchor: { q: 1, r: 1 }, patternFrom: donor.id }],
      autofill: [],
      autofillOptions: { keepPlaced: false, timeLimitMs: 3000, topK: 5, infuser: { enabled: true, neutralOnly: false, forceShrink: true } },
    };
    const file = exportBuild(data, ctx, snap);
    expect(file.placed[0].patternFrom).toBe(donor.id);
    const res = importBuild(JSON.stringify(file), ictx);
    expect(res.build!.placements[0].patternFrom).toBe(donor.id);
    expect(res.build!.autofillOptions?.infuser).toEqual({ enabled: true, neutralOnly: false, forceShrink: true });

    file.placed[0].patternFrom = target.id;
    const bad = importBuild(JSON.stringify(file), ictx);
    expect(bad.build!.placements[0].patternFrom).toBeUndefined();
    expect(bad.messages.some((m) => m.code === 'badInfusion')).toBe(true);
  });
});
