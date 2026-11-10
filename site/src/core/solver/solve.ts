/**
 * Auto-placement solver: weighted packing of hex polyominoes into the upgrade grid.
 *
 * Maximises the total weight of placed upgrades. Exact branch & bound with an anytime top-K:
 *  - every orientation × anchor of every upgrade is precomputed as a bitmask over the grid cells;
 *  - units (upgrade copies) are explored by descending weight; each unit is either placed in one of
 *    its non-overlapping positions or skipped;
 *  - upper bound = current weight + fractional knapsack of the remaining units over the free cells;
 *  - copies of the same upgrade are placed in increasing position order (no permutation duplicates);
 *  - grid expanders: outer loop over (unused | +column | +row) for each selected expander. A used
 *    expander is a mandatory unit restricted to the grid that exists without it.
 *  - Pattern Infuser: an orientation may use a donor's pattern (`patternFrom`) and carry a small
 *    `penalty`; the objective is weight − penalties (penalties < 1 in total, weights are integers),
 *    so shapes are only changed when that places more weight, or - with "force" penalties
 *    proportional to the area - to make the layout as compact as possible.
 * Variants: the K best solutions that differ either in the set of upgrades or, for the same set,
 * in at least half of the positions (so "everything fits" still yields genuinely different layouts).
 * Pure TypeScript, no DOM: runs in a Web Worker and in unit tests.
 */
import { type Axial, axialToOffset, offsetToAxial } from '../hex';

export type ExpandDirection = 'column' | 'row';

export interface SolveOrientation {
  rotation: number;
  /** normalised axial cells of this rotation */
  cells: Axial[];
  /** Pattern Infuser: donor upgrade whose pattern these cells are */
  patternFrom?: string;
  /** secondary objective: subtracted from the score (sum over a solution must stay < 1) */
  penalty?: number;
}

export interface SolveItem {
  upgradeId: string;
  weight: number;
  /** how many copies are wanted (1 unless the upgrade is stackable) */
  count: number;
  /** allowed orientations (rotation-locked upgrades: rotation 0 only); duplicate footprints removed */
  orientations: SolveOrientation[];
  expander?: boolean;
}

export interface SolveInput {
  baseSize: { w: number; h: number };
  items: SolveItem[];
  /** absolute axial cells already occupied by kept placements */
  obstacles?: Axial[];
  /** expansion already provided by kept expanders */
  fixedExpansion?: ExpandDirection[];
  topK?: number;
  timeLimitMs?: number;
  /** known layouts (e.g. the current build) recorded as starting solutions: the result is never worse */
  seeds?: SeedPlacement[][];
  /** progress callback (throttled to ~10/s) */
  onProgress?: (p: SolveProgress) => void;
  /** cooperative cancellation */
  shouldStop?: () => boolean;
}

export interface SeedPlacement {
  upgradeId: string;
  /** absolute axial cells */
  cells: Axial[];
  expand?: ExpandDirection;
}

export interface SolvedPlacement {
  upgradeId: string;
  rotation: number;
  anchor: Axial;
  expand?: ExpandDirection;
  patternFrom?: string;
}

export interface Solution {
  /** sum of weights of the placed upgrades */
  score: number;
  /** score − penalties (what the solver maximises) */
  objective: number;
  placements: SolvedPlacement[];
  /** upgradeId -> copies that could not be placed */
  unplaced: Record<string, number>;
  size: { w: number; h: number };
}

export interface SolveProgress {
  nodes: number;
  elapsedMs: number;
  best: number;
  solutions: Solution[];
}

export interface SolveResult {
  solutions: Solution[];
  /** search space exhausted */
  complete: boolean;
  /** the first solution is proven optimal (search exhausted, or every requested upgrade was placed) */
  optimal: boolean;
  nodes: number;
  elapsedMs: number;
  /** sum of weights of everything requested */
  maxScore: number;
}

/* ---------- fixed-width bitsets (up to 128 cells) ---------- */

/** extra search time for layout variants once an optimal (everything placed) solution exists */
const VARIANT_GRACE_MS = 800;

const WORDS = 4;
type Mask = Uint32Array;
const newMask = () => new Uint32Array(WORDS);
const setBit = (m: Mask, i: number) => {
  m[i >>> 5] |= 1 << (i & 31);
};
const intersects = (a: Mask, b: Mask) => ((a[0] & b[0]) | (a[1] & b[1]) | (a[2] & b[2]) | (a[3] & b[3])) !== 0;
const toggle = (a: Mask, b: Mask) => {
  a[0] ^= b[0];
  a[1] ^= b[1];
  a[2] ^= b[2];
  a[3] ^= b[3];
};

/* ---------- precomputation ---------- */

interface Option {
  mask: Mask;
  rotation: number;
  anchor: Axial;
  key: string; // rotation@anchor, for diversity comparison
  size: number;
  penalty: number;
  patternFrom?: string;
}


/** All in-bounds positions of an item (row-major from the top-left corner). */
export function enumerateOptions(
  orientations: SolveOrientation[],
  size: { w: number; h: number },
  allowed: (x: number, y: number) => boolean = () => true,
): Option[] {
  const out: Option[] = [];
  const seen = new Set<string>();
  for (let y0 = -size.h - size.w; y0 < 2 * size.h + size.w; y0++) {
    for (let x0 = -size.w; x0 < 2 * size.w; x0++) {
      const anchor = offsetToAxial(x0, y0);
      for (const o of orientations) {
        const mask = newMask();
        let ok = true;
        for (const c of o.cells) {
          const off = axialToOffset(c.q + anchor.q, c.r + anchor.r);
          if (off.x < 0 || off.y < 0 || off.x >= size.w || off.y >= size.h || !allowed(off.x, off.y)) {
            ok = false;
            break;
          }
          setBit(mask, off.y * size.w + off.x);
        }
        if (!ok) continue;
        const mk = mask.join(',');
        if (seen.has(mk)) continue;
        seen.add(mk);
        out.push({
          mask,
          rotation: o.rotation,
          anchor,
          key: `${o.rotation}@${anchor.q},${anchor.r}`,
          size: o.cells.length,
          penalty: o.penalty ?? 0,
          ...(o.patternFrom ? { patternFrom: o.patternFrom } : {}),
        });
      }
    }
  }
  return out;
}

const signatureOf = (s: Solution) =>
  s.placements
    .map((p) => p.upgradeId + (p.expand ? `:${p.expand}` : '') + (p.patternFrom ? `<${p.patternFrom}` : ''))
    .sort()
    .join('|');

/** Same set of upgrades and fewer than half of the positions differ -> not a distinct variant. */
function tooSimilar(a: Solution, b: Solution): boolean {
  if (signatureOf(a) !== signatureOf(b)) return false;
  const keys = new Set(b.placements.map((p) => `${p.upgradeId}#${p.rotation}@${p.anchor.q},${p.anchor.r}`));
  const differing = a.placements.filter((p) => !keys.has(`${p.upgradeId}#${p.rotation}@${p.anchor.q},${p.anchor.r}`)).length;
  return differing * 2 < a.placements.length || a.placements.length === 0;
}

/* ---------- solver ---------- */

export function solve(input: SolveInput): SolveResult {
  const t0 = Date.now();
  const topK = Math.max(1, input.topK ?? 5);
  let deadline = t0 + (input.timeLimitMs ?? 3000);
  const items = input.items.filter((i) => i.count > 0 && i.weight > 0 && i.orientations.length > 0);
  const maxScore = items.reduce((s, i) => s + i.weight * i.count, 0);
  const expanderIdx = items.map((it, i) => (it.expander ? i : -1)).filter((i) => i >= 0);
  const regularIdx = items.map((it, i) => (it.expander ? -1 : i)).filter((i) => i >= 0);

  type Assign = (ExpandDirection | null)[];
  let assigns: Assign[] = [[]];
  for (let k = 0; k < expanderIdx.length; k++) {
    const next: Assign[] = [];
    for (const a of assigns) for (const d of [null, 'column', 'row'] as const) next.push([...a, d]);
    assigns = next;
  }
  assigns.sort((a, b) => b.filter(Boolean).length - a.filter(Boolean).length);

  const solutions: Solution[] = [];
  let nodes = 0;
  let complete = true;
  let lastProgress = t0;
  const worst = () => (solutions.length < topK ? -Infinity : solutions[solutions.length - 1].objective);
  const minPenalty = (it: SolveItem) => Math.min(...it.orientations.map((o) => o.penalty ?? 0));
  /** best objective achievable at all: everything placed with the smallest penalties */
  const maxObjective = items.reduce((s, i) => s + (i.weight - minPenalty(i)) * i.count, 0);
  const hasPenalties = items.some((i) => i.orientations.some((o) => o.penalty));
  /** While variants are still being collected, equal-score branches are explored (other layouts);
   *  once K variants exist, branches that cannot beat the weakest one are cut. */
  const pruned = (b: number) => solutions.length >= topK && b <= worst() + 1e-9;

  const record = (sol: Solution) => {
    // a better solution replaces similar weaker ones; a similar-or-worse one is ignored
    for (let i = 0; i < solutions.length; i++) {
      if (tooSimilar(sol, solutions[i]) || tooSimilar(solutions[i], sol)) {
        if (sol.objective > solutions[i].objective) {
          solutions.splice(i, 1);
          i--;
        } else return;
      }
    }
    solutions.push(sol);
    solutions.sort((a, b) => b.objective - a.objective);
    // everything placed = optimal; spend at most a short extra time collecting layout variants
    // (with penalties: only once nothing better is possible at all - otherwise keep looking for fewer infusions)
    if (sol.score >= maxScore && (!hasPenalties || sol.objective >= maxObjective - 1e-9))
      deadline = Math.min(deadline, Date.now() + VARIANT_GRACE_MS);
    if (solutions.length > topK) solutions.length = topK;
  };

  const hasDonors = items.some((i) => i.orientations.some((o) => o.patternFrom));
  /**
   * One search pass over all expander assignments. `ownOnly`: own shapes only (no donors) - a quick first
   * stage, so the result with the infuser is never worse than without it (solutions carry over).
   */
  const runStage = (ownOnly: boolean, stageEnd: number) => {
    const orients = (it: SolveItem) => (ownOnly ? it.orientations.filter((o) => !o.patternFrom) : it.orientations);
    for (const assign of assigns) {
      const fixed = input.fixedExpansion ?? [];
      const baseW = input.baseSize.w + fixed.filter((d) => d === 'column').length;
      const baseH = input.baseSize.h + fixed.filter((d) => d === 'row').length;
      const size = { w: baseW, h: baseH };
      for (const d of assign) if (d === 'column') size.w++;
      else if (d === 'row') size.h++;
      if (size.w * size.h > WORDS * 32) continue;
      const totalCells = size.w * size.h;

      const occ = newMask();
      let used = 0;
      for (const c of input.obstacles ?? []) {
        const o = axialToOffset(c.q, c.r);
        if (o.x >= 0 && o.y >= 0 && o.x < size.w && o.y < size.h) {
          const bit = o.y * size.w + o.x;
          if (!(occ[bit >>> 5] & (1 << (bit & 31)))) used++;
          setBit(occ, bit);
        }
      }

      // ---- slots: one per selected upgrade with a remaining copy count ----
      interface Slot {
        item: number;
        weight: number;
        /** weight minus the smallest penalty: upper bound of what one copy adds to the objective */
        value: number;
        /** smallest footprint among the orientations (for the bound) */
        size: number;
        rem: number;
        mandatory: boolean;
        expand?: ExpandDirection;
        /** options indexed by their lowest cell (row-major) - used by first-free-cell branching */
        byMin: Option[][];
        /** options with a penalty > 0 somewhere: all options, smallest penalty first (for polishing) */
        cheapest?: Option[];
        /** size of the own shape when it costs nothing (Infinity: no free option, e.g. "force" mode) */
        ownSize: number;
        /** cells saved by the smallest shape, and the smallest penalty of a shape with a penalty */
        saving: number;
        infPen: number;
      }
      const indexByMin = (opts: Option[]) => {
        const by: Option[][] = Array.from({ length: totalCells }, () => []);
        for (const o of opts) {
          let min = -1;
          for (let w = 0; w < WORDS && min < 0; w++) if (o.mask[w]) min = w * 32 + (31 - Math.clz32(o.mask[w] & -o.mask[w]));
          if (min >= 0) by[min].push(o);
        }
        return by;
      };
      const slots: Slot[] = [];
      assign.forEach((d, k) => {
        if (!d) return;
        const it = items[expanderIdx[k]];
        slots.push({
          item: expanderIdx[k],
          weight: it.weight,
          value: it.weight - minPenalty(it),
          size: Math.min(...orients(it).map((o) => o.cells.length)),
          rem: 1,
          mandatory: true,
          ownSize: Infinity,
          saving: 0,
          infPen: 0,
          expand: d,
          // an expander must stand inside the grid that exists without its own expansion
          byMin: indexByMin(enumerateOptions(orients(it), size, (x, y) => x < baseW && y < baseH)),
        });
      });
      for (const idx of regularIdx) {
        const it = items[idx];
        slots.push({
          item: idx,
          weight: it.weight,
          value: it.weight - minPenalty(it),
          size: Math.min(...orients(it).map((o) => o.cells.length)),
          rem: it.count,
          mandatory: false,
          ownSize: Infinity,
          saving: 0,
          infPen: 0,
          byMin: indexByMin(enumerateOptions(orients(it), size)),
        });
      }
      for (const sl of slots) {
        const opts = sl.byMin.flat();
        if (opts.some((o) => o.penalty)) sl.cheapest = opts.sort((a, b) => a.penalty - b.penalty);
        const it = items[sl.item];
        const free = orients(it).filter((o) => !o.penalty).map((o) => o.cells.length);
        sl.ownSize = free.length ? Math.min(...free) : Infinity;
        sl.saving = sl.ownSize - sl.size;
        const pens = orients(it).filter((o) => o.penalty).map((o) => o.penalty!);
        sl.infPen = pens.length ? Math.min(...pens) : 0;
      }
      // Pattern Infuser bound: when everything left must fit, the cells missing for the own shapes need
      // at least k shrunk units (largest savings first), each costing at least its penalty.
      const infuseBound = hasPenalties && slots.every((sl) => sl.ownSize < Infinity);
      const bySaving = slots.filter((sl) => sl.saving > 0).sort((a, b) => b.saving - a.saving);
      const baseOcc = occ.slice();
      // heaviest first when branching (good solutions early), densest first for the bound
      const byWeight = slots.slice().sort((a, b) => b.weight - a.weight || b.size - a.size);
      const byDensity = slots.slice().sort((a, b) => b.value / b.size - a.value / a.size);
      let remaining = slots.reduce((n, sl) => n + sl.rem, 0);
      let mandatoryLeft = slots.filter((sl) => sl.mandatory).length;
      let decided = used; // occupied + deliberately empty cells

      /** current score + fractional knapsack of the remaining copies over the undecided cells */
      const bound = (score: number) => {
        const avail = totalCells - decided;
        let free = avail;
        let b = score;
        let allFit = true;
        for (const sl of byDensity) {
          if (!sl.rem) continue;
          if (free <= 0) {
            allFit = false;
            break;
          }
          const fit = Math.min(sl.rem, Math.floor(free / sl.size));
          b += fit * sl.value;
          free -= fit * sl.size;
          if (fit < sl.rem) {
            allFit = false;
            if (free > 0) b += (sl.value * free) / sl.size;
            free = 0;
          }
        }
        if (infuseBound && allFit) {
          let need = -avail;
          for (const sl of slots) need += sl.ownSize * sl.rem;
          for (const sl of bySaving) {
            if (need <= 0) break;
            for (let k = 0; k < sl.rem && need > 0; k++) {
              need -= sl.saving;
              b -= sl.infPen;
            }
          }
        }
        return b;
      };

      const chosen: { slot: Slot; opt: Option }[] = [];

      /**
       * Local improvement of a found layout: every placement with a penalty (donor shape, or area in
       * "force" mode) is moved to the cheapest option that fits in the free cells, while others stay.
       */
      const polish = (list: { slot: Slot; opt: Option }[]): number => {
        let gain = 0;
        if (!slots.some((sl) => sl.cheapest)) return gain;
        const used = baseOcc.slice();
        for (const c of list) toggle(used, c.opt.mask);
        let changed = true;
        while (changed) {
          changed = false;
          for (const c of list) {
            if (!c.opt.penalty || !c.slot.cheapest) continue;
            toggle(used, c.opt.mask);
            const better = c.slot.cheapest.find((o) => o.penalty < c.opt.penalty - 1e-12 && !intersects(o.mask, used));
            if (better) {
              gain += c.opt.penalty - better.penalty;
              c.opt = better;
              changed = true;
            }
            toggle(used, c.opt.mask);
          }
        }
        return gain;
      };

      const recordCurrent = (found: number) => {
        if (mandatoryLeft > 0) return;
        const list = chosen.map((c) => ({ ...c }));
        const objective = found + polish(list);
        if (solutions.length >= topK && objective < worst()) return;
        let score = 0;
        for (const c of list) score += c.slot.weight;
        const placed = new Map<number, number>();
        for (const c of list) placed.set(c.slot.item, (placed.get(c.slot.item) ?? 0) + 1);
        const unplaced: Record<string, number> = {};
        items.forEach((it, idx) => {
          const missing = it.count - (placed.get(idx) ?? 0);
          if (missing > 0) unplaced[it.upgradeId] = missing;
        });
        record({
          score,
          objective,
          size: { ...size },
          unplaced,
          placements: list.map((c) => ({
            upgradeId: items[c.slot.item].upgradeId,
            rotation: c.opt.rotation,
            anchor: c.opt.anchor,
            ...(c.slot.expand ? { expand: c.slot.expand } : {}),
            ...(c.opt.patternFrom ? { patternFrom: c.opt.patternFrom } : {}),
          })),
        });
      };

      /** records every seed that is a complete, valid layout for this expansion */
    const recordSeeds = () => {
      for (const seed of input.seeds ?? []) {
        const picked: { slot: Slot; opt: Option }[] = [];
        const taken = new Map<Slot, number>();
        const used = baseOcc.slice();
        let ok = true;
        for (const sp of seed) {
          const slot = slots.find(
            (sl) => items[sl.item].upgradeId === sp.upgradeId && (sl.expand ?? null) === (sp.expand && sl.mandatory ? sp.expand : null) && (taken.get(sl) ?? 0) < sl.rem,
          );
          const mask = newMask();
          for (const c of sp.cells) {
            const o = axialToOffset(c.q, c.r);
            if (o.x < 0 || o.y < 0 || o.x >= size.w || o.y >= size.h) ok = false;
            else setBit(mask, o.y * size.w + o.x);
          }
          const opt = ok && slot ? slot.byMin.flat().find((o) => o.mask.every((v, i) => v === mask[i])) : undefined;
          if (!slot || !opt || intersects(opt.mask, used)) {
            ok = false;
            break;
          }
          toggle(used, opt.mask);
          taken.set(slot, (taken.get(slot) ?? 0) + 1);
          picked.push({ slot, opt });
        }
        if (!ok || slots.some((sl) => sl.mandatory && !taken.get(sl))) continue;
        chosen.push(...picked);
        const saved = mandatoryLeft;
        mandatoryLeft = 0;
        recordCurrent(picked.reduce((a, c) => a + c.slot.weight - c.opt.penalty, 0));
        mandatoryLeft = saved;
        chosen.length = 0;
      }
    };

    const isSet = (bit: number) => (occ[bit >>> 5] & (1 << (bit & 31))) !== 0;

      /**
       * First-free-cell branching: the first undecided cell is either covered by an option whose lowest
       * cell it is, or left empty for good. Every layout is reached exactly once and empty cells
       * immediately tighten the bound. Returns true when the search must stop (time limit / cancel).
       */
      const search = (from: number, score: number): boolean => {
        nodes++;
        if ((nodes & 1023) === 0) {
          const now = Date.now();
          if (now > deadline || now > stageEnd || input.shouldStop?.()) {
            complete = false;
            return true;
          }
          if (input.onProgress && now - lastProgress > 100) {
            lastProgress = now;
            input.onProgress({ nodes, elapsedMs: now - t0, best: solutions[0]?.score ?? 0, solutions: solutions.slice() });
          }
        }
        // all K variants already place everything requested: nothing better can exist
        if (solutions.length >= topK && worst() >= maxObjective - 1e-9) return true;
        let cell = from;
        while (cell < totalCells && isSet(cell)) cell++;
        if (remaining === 0 || cell >= totalCells) {
          recordCurrent(score);
          return false;
        }
        if (pruned(bound(score))) return false;

        for (const sl of byWeight) {
          if (!sl.rem) continue;
          for (const opt of sl.byMin[cell]) {
            if (intersects(opt.mask, occ)) continue;
            toggle(occ, opt.mask);
            decided += opt.size;
            sl.rem--;
            remaining--;
            if (sl.mandatory) mandatoryLeft--;
            chosen.push({ slot: sl, opt });
            const stop = search(cell + 1, score + sl.weight - opt.penalty);
            chosen.pop();
            if (sl.mandatory) mandatoryLeft++;
            remaining++;
            sl.rem++;
            decided -= opt.size;
            toggle(occ, opt.mask);
            if (stop) return true;
            if (pruned(bound(score))) return false;
          }
        }
        // leave this cell empty
        occ[cell >>> 5] |= 1 << (cell & 31);
        decided++;
        const stop = search(cell + 1, score);
        decided--;
        occ[cell >>> 5] &= ~(1 << (cell & 31));
        return stop;
      };

      recordSeeds(); // in each stage: a seed with donor shapes only matches the full stage
      if (search(0, 0)) break;
    }
  };

  if (hasDonors) {
    runStage(true, t0 + (deadline - t0) * 0.4);
    if (Date.now() < deadline && !input.shouldStop?.() && !(solutions.length >= topK && worst() >= maxObjective - 1e-9)) {
      complete = true;
      runStage(false, Infinity);
    }
  } else runStage(false, Infinity);

  const optimal = complete || (solutions.length > 0 && solutions[0].score >= maxScore);
  return { solutions, complete, optimal, nodes, elapsedMs: Date.now() - t0, maxScore };
}
