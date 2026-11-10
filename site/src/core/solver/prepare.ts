import type { Upgrade } from '../types';
import { fromRaw, uniqueOrientations } from '../pattern';
import { allowedRotations, isGridExpander, isStackable } from '../rules';
import { evaluate, infuseDonors, type BoardContext, type Placement } from '../placement';
import type { ExpandDirection, SeedPlacement, Solution, SolveInput, SolveItem, SolveOrientation } from './solve';

/** One upgrade chosen by the user for auto-placement. */
export interface AutofillEntry {
  upgradeId: string;
  /** priority: the solver maximises the sum of weights of placed upgrades */
  weight: number;
  /** wanted copies (only meaningful for CanStack upgrades) */
  count: number;
}

export interface InfuserOptions {
  /** let the solver use other upgrades' patterns (Pattern Infuser); only same-size or smaller ones */
  enabled: boolean;
  /** only shapes that keep the stats: same cell count, or any size for upgrades whose stats do not depend on it */
  neutralOnly: boolean;
  /** minimise the occupied area even when everything already fits */
  forceShrink: boolean;
}

/** penalty of using a donor's pattern (prefer the own shape); twice as much when the stats change */
const INFUSE_PENALTY = 1e-5;
/** per occupied cell in "force" mode (≤ 128 cells -> total < 1, below one unit of weight) */
const CELL_PENALTY = 1e-3;

export interface PrepareOptions {
  /** keep the current placements fixed and fill around them */
  keepPlaced: boolean;
  topK?: number;
  timeLimitMs?: number;
  infuser?: InfuserOptions;
  /** all upgrades (donor candidates); required for the infuser */
  allUpgrades?: Iterable<Upgrade>;
}

/**
 * Orientations of an upgrade for the solver: its own pattern and, with the infuser, the patterns of
 * possible donors (never bigger than its own). Identical footprints are kept once, own shape first.
 */
export function solverOrientations(u: Upgrade, rotations: readonly number[], opts: PrepareOptions): SolveOrientation[] {
  const inf = opts.infuser;
  const own = u.pattern.cells.length;
  const sources: { donor?: Upgrade; pattern: Upgrade['pattern'] }[] = [{ pattern: u.pattern }];
  if (inf?.enabled && opts.allUpgrades && !isGridExpander(u)) {
    for (const d of infuseDonors(u, opts.allUpgrades)) {
      const n = d.pattern.cells.length;
      if (n > own) continue;
      if (inf.neutralOnly && u.patternScaled && n !== own) continue;
      sources.push({ donor: d, pattern: d.pattern });
    }
  }
  const out: SolveOrientation[] = [];
  const seen = new Set<string>();
  for (const src of sources) {
    for (const o of uniqueOrientations(fromRaw(src.pattern), rotations)) {
      const cells = o.pattern.cells.map(({ q, r }) => ({ q, r }));
      const k = cells.map((c) => `${c.q},${c.r}`).sort().join(';');
      if (seen.has(k)) continue;
      seen.add(k);
      const loss = !!src.donor && u.patternScaled && cells.length !== own;
      const penalty =
        (inf?.enabled && inf.forceShrink ? cells.length * CELL_PENALTY : 0) + (src.donor ? INFUSE_PENALTY * (loss ? 2 : 1) : 0);
      out.push({ rotation: o.rotation, cells, ...(src.donor ? { patternFrom: src.donor.id } : {}), ...(penalty ? { penalty } : {}) });
    }
  }
  return out;
}

/** Applies the game rules (rotation unlock, CanStack, expanders, kept placements) to build the solver input. */
export function prepareSolve(
  ctx: BoardContext,
  placements: readonly Placement[],
  selection: readonly AutofillEntry[],
  opts: PrepareOptions,
): Omit<SolveInput, 'onProgress' | 'shouldStop'> {
  const kept = opts.keepPlaced ? evaluate(ctx, placements) : null;
  const keptCount = new Map<string, number>();
  if (kept) for (const p of placements) keptCount.set(p.upgradeId, (keptCount.get(p.upgradeId) ?? 0) + 1);

  const items: SolveItem[] = [];
  for (const e of selection) {
    const u: Upgrade | undefined = ctx.getUpgrade(e.upgradeId);
    if (!u || u.role === 'ability') continue;
    if (ctx.pool && !ctx.pool.has(u.id)) continue;
    const wanted = isStackable(u) ? Math.max(0, Math.floor(e.count)) : 1;
    const count = Math.max(0, wanted - (keptCount.get(u.id) ?? 0));
    if (!count) continue;
    const orientations = solverOrientations(u, allowedRotations(u.rarity, ctx.accountLevel), opts);
    items.push({ upgradeId: u.id, weight: e.weight, count, orientations, expander: isGridExpander(u) });
  }

  const obstacles = kept ? [...kept.cells.values()].flat() : [];
  const fixedExpansion: ExpandDirection[] = kept
    ? placements.filter((p) => kept.activeExpanders.includes(p.uid)).map((p) => p.expand ?? 'column')
    : [];

  // the current build (when valid and not kept) is a starting solution: auto-fill never returns a worse layout
  const seeds: SeedPlacement[][] = [];
  if (!opts.keepPlaced && placements.length) {
    const st = evaluate(ctx, placements);
    if (st.valid) {
      const left = new Map(items.map((it) => [it.upgradeId, it.count]));
      const seed: SeedPlacement[] = [];
      for (const p of placements) {
        const n = left.get(p.upgradeId) ?? 0;
        if (!n) continue;
        left.set(p.upgradeId, n - 1);
        const u = ctx.getUpgrade(p.upgradeId);
        seed.push({ upgradeId: p.upgradeId, cells: st.cells.get(p.uid)!, ...(u && isGridExpander(u) ? { expand: p.expand ?? 'column' } : {}) });
      }
      if (seed.length) seeds.push(seed);
    }
  }

  return { baseSize: ctx.baseSize, items, obstacles, fixedExpansion, seeds, topK: opts.topK ?? 5, timeLimitMs: opts.timeLimitMs ?? 3000 };
}

/** Converts a solver solution into build placements (kept placements first when requested). */
export function solutionToPlacements(
  solution: Solution,
  kept: readonly Placement[],
  keepPlaced: boolean,
  newUid: () => string,
): Placement[] {
  // per-instance choices (element) of the current build are carried over to the same upgrades
  const elements = new Map<string, string[]>();
  if (!keepPlaced)
    for (const p of kept) if (p.element) elements.set(p.upgradeId, [...(elements.get(p.upgradeId) ?? []), p.element]);
  return [
    ...(keepPlaced ? kept : []),
    ...solution.placements.map((p) => {
      const element = elements.get(p.upgradeId)?.shift();
      return {
        uid: newUid(),
        upgradeId: p.upgradeId,
        rotation: p.rotation,
        anchor: { ...p.anchor },
        ...(p.expand ? { expand: p.expand } : {}),
        ...(p.patternFrom ? { patternFrom: p.patternFrom } : {}),
        ...(element ? { element } : {}),
      };
    }),
  ];
}
