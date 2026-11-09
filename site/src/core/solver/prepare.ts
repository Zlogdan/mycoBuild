import type { Upgrade } from '../types';
import { fromRaw, uniqueOrientations } from '../pattern';
import { allowedRotations, isGridExpander, isStackable } from '../rules';
import { evaluate, type BoardContext, type Placement } from '../placement';
import type { ExpandDirection, Solution, SolveInput, SolveItem } from './solve';

/** One upgrade chosen by the user for auto-placement. */
export interface AutofillEntry {
  upgradeId: string;
  /** priority: the solver maximises the sum of weights of placed upgrades */
  weight: number;
  /** wanted copies (only meaningful for CanStack upgrades) */
  count: number;
}

export interface PrepareOptions {
  /** keep the current placements fixed and fill around them */
  keepPlaced: boolean;
  topK?: number;
  timeLimitMs?: number;
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
    const orientations = uniqueOrientations(fromRaw(u.pattern), allowedRotations(u.rarity, ctx.accountLevel)).map((o) => ({
      rotation: o.rotation,
      cells: o.pattern.cells.map(({ q, r }) => ({ q, r })),
    }));
    items.push({ upgradeId: u.id, weight: e.weight, count, orientations, expander: isGridExpander(u) });
  }

  const obstacles = kept ? [...kept.cells.values()].flat() : [];
  const fixedExpansion: ExpandDirection[] = kept
    ? placements.filter((p) => kept.activeExpanders.includes(p.uid)).map((p) => p.expand ?? 'column')
    : [];

  return { baseSize: ctx.baseSize, items, obstacles, fixedExpansion, topK: opts.topK ?? 5, timeLimitMs: opts.timeLimitMs ?? 3000 };
}

/** Converts a solver solution into build placements (kept placements first when requested). */
export function solutionToPlacements(
  solution: Solution,
  kept: readonly Placement[],
  keepPlaced: boolean,
  newUid: () => string,
): Placement[] {
  return [
    ...(keepPlaced ? kept : []),
    ...solution.placements.map((p) => ({
      uid: newUid(),
      upgradeId: p.upgradeId,
      rotation: p.rotation,
      anchor: { ...p.anchor },
      ...(p.expand ? { expand: p.expand } : {}),
    })),
  ];
}
