import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData, Upgrade } from '../src/core/types';
import { solve, enumerateOptions, type SolveItem } from '../src/core/solver/solve';
import { prepareSolve, solutionToPlacements } from '../src/core/solver/prepare';
import { evaluate, type BoardContext } from '../src/core/placement';
import { fromRaw, uniqueOrientations } from '../src/core/pattern';
import { gridSizeForLevel } from '../src/core/rules';

const shape = (cells: [number, number][], allRot = true) =>
  uniqueOrientations(fromRaw({ w: 9, h: 9, cells: cells.map(([x, y]) => [x, y, 0]) }), allRot ? undefined : [0]).map((o) => ({
    rotation: o.rotation,
    cells: o.pattern.cells.map(({ q, r }) => ({ q, r })),
  }));

const item = (id: string, weight: number, cells: [number, number][], extra: Partial<SolveItem> = {}): SolveItem => ({
  upgradeId: id,
  weight,
  count: 1,
  orientations: shape(cells),
  ...extra,
});

/** exhaustive reference: best total weight without any pruning */
function bruteForce(items: SolveItem[], size: { w: number; h: number }): number {
  const units = items.flatMap((it) => Array.from({ length: it.count }, () => it));
  const opts = units.map((u) => enumerateOptions(u.orientations, size));
  let best = 0;
  const occ = new Uint32Array(4);
  const rec = (i: number, score: number) => {
    if (score > best) best = score;
    if (i === units.length) return;
    for (const o of opts[i]) {
      if ((o.mask[0] & occ[0]) | (o.mask[1] & occ[1]) | (o.mask[2] & occ[2]) | (o.mask[3] & occ[3])) continue;
      for (let k = 0; k < 4; k++) occ[k] ^= o.mask[k];
      rec(i + 1, score + units[i].weight);
      for (let k = 0; k < 4; k++) occ[k] ^= o.mask[k];
    }
    rec(i + 1, score);
  };
  rec(0, 0);
  return best;
}

const SHAPES: [number, number][][] = [
  [[0, 0]],
  [[0, 0], [0, 1]],
  [[0, 0], [0, 1], [0, 2]],
  [[0, 0], [1, 0], [0, 1]],
  [[0, 0], [0, 1], [1, 1], [1, 2]],
  [[0, 0], [1, 0], [2, 0], [1, 1]],
];

describe('solver', () => {
  it('matches exhaustive search on random small instances', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let t = 0; t < 25; t++) {
      const size = { w: 3 + Math.floor(rnd() * 2), h: 2 + Math.floor(rnd() * 2) };
      const n = 3 + Math.floor(rnd() * 3);
      const items = Array.from({ length: n }, (_, i) => item(`u${i}`, 1 + Math.floor(rnd() * 10), SHAPES[Math.floor(rnd() * SHAPES.length)]));
      const res = solve({ baseSize: size, items, timeLimitMs: 5000 });
      expect(res.complete).toBe(true);
      expect(res.solutions[0].score).toBe(bruteForce(items, size));
    }
  });

  it('prefers two lighter upgrades over one heavy when their sum is higher', () => {
    // 3×2 board (6 cells): one 5-cell piece (w=10) vs two 2-cell pieces (w=6 each); big + any other cannot fit
    const big = item('big', 10, [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]]);
    const a = item('a', 6, [[0, 0], [0, 1]]);
    const b = item('b', 6, [[0, 0], [0, 1]]);
    const res = solve({ baseSize: { w: 3, h: 2 }, items: [big, a, b] });
    expect(bruteForce([big, a, b], { w: 3, h: 2 })).toBe(12);
    expect(res.solutions[0].score).toBe(12);
    expect(res.solutions[0].unplaced).toEqual({ big: 1 });
  });

  it('everything fits -> max score, proven, and several different layouts', () => {
    const items = [item('a', 10, [[0, 0], [0, 1]]), item('b', 9, [[0, 0], [1, 0], [0, 1]]), item('c', 7, [[0, 0]])];
    const res = solve({ baseSize: { w: 5, h: 5 }, items, topK: 4 });
    expect(res.solutions[0].score).toBe(26);
    expect(res.solutions[0].unplaced).toEqual({});
    expect(res.complete).toBe(true);
    expect(res.solutions.length).toBe(4);
    expect(res.solutions.every((s) => s.score === 26)).toBe(true);
  });

  it('respects rotation locks (only orientation 0 given)', () => {
    const locked: SolveItem = { ...item('l', 5, [[0, 0], [0, 1], [0, 2]]), orientations: shape([[0, 0], [0, 1], [0, 2]], false) };
    const res = solve({ baseSize: { w: 3, h: 2 }, items: [locked] });
    // a vertical bar of 3 cannot fit into 2 rows without rotation
    expect(res.solutions[0]?.score ?? 0).toBe(0);
    const free = solve({ baseSize: { w: 3, h: 2 }, items: [item('l', 5, [[0, 0], [0, 1], [0, 2]])] });
    expect(free.solutions[0].score).toBe(5);
  });

  it('places several copies of a stackable upgrade', () => {
    const res = solve({ baseSize: { w: 3, h: 3 }, items: [item('s', 2, [[0, 0], [0, 1]], { count: 4 })] });
    expect(res.solutions[0].placements.length).toBe(4);
    expect(res.solutions[0].score).toBe(8);
  });

  it('uses a grid expander when the extra column allows a higher score', () => {
    // 2×2 board + 1-cell expander: a vertical bar of 2 + a 3-cell triangle need 5 cells + expander
    const exp = item('grow', 1, [[0, 0]], { expander: true });
    const items = [item('bar', 10, [[0, 0], [0, 1]]), item('tri', 10, [[0, 0], [1, 0], [0, 1]]), exp];
    const res = solve({ baseSize: { w: 2, h: 2 }, items });
    const best = res.solutions[0];
    expect(best.score).toBe(21);
    const e = best.placements.find((p) => p.upgradeId === 'grow')!;
    expect(e.expand).toBeDefined();
  });

  it('keeps obstacles free', () => {
    const res = solve({ baseSize: { w: 2, h: 1 }, items: [item('a', 1, [[0, 0]], { count: 2 })], obstacles: [{ q: 0, r: 0 }] });
    expect(res.solutions[0].placements).toEqual([{ upgradeId: 'a', rotation: 0, anchor: { q: 1, r: -1 + 1 } }]);
  });
});

/* ---------- real game data ---------- */

const data: GameData = JSON.parse(readFileSync(resolve(__dirname, '../public/data/game.json'), 'utf-8'));

describe('solver on real data', () => {
  const gear = data.gears.find((g) => g.key === 'accelerator')!;
  const ups = gear.upgrades.map((id) => data.upgrades[id]).filter((u): u is Upgrade => u.role === 'normal');
  const ctx = (accountLevel: number): BoardContext => ({
    getUpgrade: (id) => data.upgrades[id],
    pool: new Set(ups.map((u) => u.id)),
    accountLevel,
    baseSize: gridSizeForLevel(data.gridProfiles[gear.grid], 10),
  });
  const selection = ups.slice(0, 14).map((u, i) => ({ upgradeId: u.id, weight: 14 - i, count: 1 }));

  for (const level of [30, 1]) {
    it(`every variant is a valid build (account level ${level})`, () => {
      const c = ctx(level);
      const input = prepareSolve(c, [], selection, { keepPlaced: false, timeLimitMs: 2500 });
      const res = solve(input);
      expect(res.solutions.length).toBeGreaterThan(0);
      let n = 0;
      for (const s of res.solutions) {
        const placements = solutionToPlacements(s, [], false, () => `s${n++}`);
        const state = evaluate(c, placements);
        expect([...state.issues.values()].flat()).toEqual([]);
        const placedWeight = placements.reduce((sum, p) => sum + selection.find((e) => e.upgradeId === p.upgradeId)!.weight, 0);
        expect(placedWeight).toBe(s.score);
      }
    });
  }

  it('fills around kept placements without touching them', () => {
    const c = ctx(30);
    const first = solve(prepareSolve(c, [], selection.slice(0, 2), { keepPlaced: false }));
    const kept = solutionToPlacements(first.solutions[0], [], false, () => 'k' + Math.random());
    const res = solve(prepareSolve(c, kept, selection, { keepPlaced: true, timeLimitMs: 2000 }));
    const all = solutionToPlacements(res.solutions[0], kept, true, () => 'n' + Math.random());
    expect(all.slice(0, kept.length)).toEqual(kept);
    expect(evaluate(c, all).valid).toBe(true);
    // the two kept upgrades are not placed again
    expect(res.solutions[0].placements.some((p) => kept.some((k) => k.upgradeId === p.upgradeId))).toBe(false);
  });
});
