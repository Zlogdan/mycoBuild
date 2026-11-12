import type { Rarity, Upgrade } from './types';
import { type Axial, axialKey, axialToOffset } from './hex';
import { type Pattern, fromRaw, rotate } from './pattern';
import { canRotate, isGridExpander, isStackable, rotationUnlockLevel } from './rules';

export type ExpandDirection = 'column' | 'row';

/** One upgrade placed on the grid. `anchor` is the axial position of the pattern's local origin (0,0). */
export interface Placement {
  uid: string;
  upgradeId: string;
  rotation: number; // 0..5
  anchor: Axial;
  /** grid expanders only: which way this instance grows the grid (in game: decided by the instance seed) */
  expand?: ExpandDirection;
  /** upgrades with a per-instance element (Upgrade.elementChoice): the chosen element key */
  element?: string;
  /** Pattern Infuser: id of the upgrade whose pattern this instance uses (UpgradeInstance.overriddenPatternID) */
  patternFrom?: string;
  /** save editor: the save's upgrade instance this placement came from (kept when written back) */
  instanceId?: number;
}

export type IssueCode =
  | 'unknownUpgrade'
  | 'notInPool'
  | 'outOfBounds'
  | 'overlap'
  | 'rotationLocked'
  | 'duplicate'
  | 'expanderInactive'
  | 'badInfusion';

export interface Issue {
  code: IssueCode;
  /** extra data for messages, e.g. required level */
  level?: number;
  otherUid?: string;
}

export interface BoardContext {
  getUpgrade: (id: string) => Upgrade | undefined;
  /** ids of upgrades allowed for the selected gear (undefined = no restriction) */
  pool?: ReadonlySet<string>;
  accountLevel: number;
  baseSize: { w: number; h: number };
}

export interface BoardState {
  size: { w: number; h: number };
  /** axial key -> uid of the placement occupying that cell (first one wins) */
  occupancy: Map<string, string>;
  /** uid -> absolute axial cells */
  cells: Map<string, Axial[]>;
  issues: Map<string, Issue[]>;
  activeExpanders: string[];
  valid: boolean;
}

/* ---------- pattern cache ---------- */

const patternCache = new Map<string, Pattern[]>();

/** Normalised axial pattern of an upgrade for a rotation (cached per upgrade id). */
export function upgradePattern(u: Upgrade, rotation: number): Pattern {
  let rots = patternCache.get(u.id);
  if (!rots || rots.length === 0) {
    const base = fromRaw(u.pattern);
    rots = [0, 1, 2, 3, 4, 5].map((r) => rotate(base, r));
    patternCache.set(u.id, rots);
  }
  return rots[((rotation % 6) + 6) % 6];
}

/**
 * Pattern Infuser rule (PatternInfuserWindow): the donor must be another upgrade of the same gear and the same rarity.
 * (In game the donor instance is consumed; any such upgrade is accepted here.)
 */
export function canInfuse(target: Upgrade, donor: Upgrade | undefined): boolean {
  return (
    !!donor &&
    donor.id !== target.id &&
    donor.role === 'normal' &&
    donor.rarity === target.rarity &&
    donor.rarity !== 5 &&
    donor.pattern.cells.length > 0 &&
    donor.gears.some((g) => target.gears.includes(g))
  );
}

/** Possible donors of an upgrade, smallest patterns first. */
export function infuseDonors(target: Upgrade, all: Iterable<Upgrade>): Upgrade[] {
  return [...all]
    .filter((d) => canInfuse(target, d))
    .sort((a, b) => a.pattern.cells.length - b.pattern.cells.length || a.key.localeCompare(b.key));
}

/** Shape of a placement: its own pattern, or the donor's pattern when infused. */
export function placementPattern(getUpgrade: (id: string) => Upgrade | undefined, u: Upgrade, rotation: number, patternFrom?: string): Pattern {
  const donor = patternFrom ? getUpgrade(patternFrom) : undefined;
  return upgradePattern(donor && canInfuse(u, donor) ? donor : u, rotation);
}

/**
 * UpgradeProperty.GetPatternSizeRatio(currentCells, defaultCells, invert): multiplier applied by the game to
 * pattern-size dependent stats. Smaller: (1 + r) / 2; bigger: 0.85 r + 0.15, capped at 1 + diff / 7.5 and 2; min 0.2.
 * `invert` is used by stats where less is better (the ratio is computed with the sizes swapped).
 */
export function patternSizeRatio(currentCells: number, defaultCells: number, invert = false): number {
  let a = currentCells;
  let b = defaultCells;
  if (a === b || b <= 0) return 1;
  if (invert) [a, b] = [b, a];
  let r = a / b;
  if (r >= 1) r = Math.min(r, 1 + Math.min((a - b) / 7.5, 1));
  r = Math.min(r, 2);
  let smaller = r < 1;
  if (invert) smaller = !smaller;
  r = r + (1 - r) * (smaller ? 0.5 : 0.15);
  return Math.max(r, 0.2);
}

export function clearPatternCache() {
  patternCache.clear();
}

export function footprint(pattern: Pattern, anchor: Axial): Axial[] {
  return pattern.cells.map((c) => ({ q: c.q + anchor.q, r: c.r + anchor.r }));
}

export function inBounds(a: Axial, size: { w: number; h: number }): boolean {
  const o = axialToOffset(a.q, a.r);
  return o.x >= 0 && o.y >= 0 && o.x < size.w && o.y < size.h;
}

/** Board size after applying the given expanders (+1 column on the right or +1 row at the bottom each). */
export function expandedSize(base: { w: number; h: number }, dirs: ExpandDirection[]): { w: number; h: number } {
  let { w, h } = base;
  for (const d of dirs) {
    if (d === 'column') w++;
    else h++;
  }
  return { w, h };
}

/**
 * Evaluates a whole build: resulting grid size, occupancy and per-placement issues.
 *
 * Grid expanders are resolved as a fixpoint: starting from the base size, an expander becomes active
 * only if all its cells lie inside the grid formed by already active expanders. This forbids an
 * expander from standing on a cell that exists only because of itself (or of a mutual dependency).
 */
export function evaluate(ctx: BoardContext, placements: readonly Placement[]): BoardState {
  const issues = new Map<string, Issue[]>();
  const addIssue = (uid: string, issue: Issue) => {
    const list = issues.get(uid) ?? [];
    list.push(issue);
    issues.set(uid, list);
  };

  const cells = new Map<string, Axial[]>();
  const known: { p: Placement; u: Upgrade }[] = [];
  for (const p of placements) {
    const u = ctx.getUpgrade(p.upgradeId);
    if (!u) {
      addIssue(p.uid, { code: 'unknownUpgrade' });
      continue;
    }
    known.push({ p, u });
    if (p.patternFrom && !canInfuse(u, ctx.getUpgrade(p.patternFrom))) addIssue(p.uid, { code: 'badInfusion' });
    cells.set(p.uid, footprint(placementPattern(ctx.getUpgrade, u, p.rotation, p.patternFrom), p.anchor));
    if (ctx.pool && !ctx.pool.has(u.id)) addIssue(p.uid, { code: 'notInPool' });
    if (p.rotation % 6 !== 0 && !canRotate(u.rarity as Rarity, ctx.accountLevel))
      addIssue(p.uid, { code: 'rotationLocked', level: rotationUnlockLevel(u.rarity) });
  }

  // duplicates: non-stackable upgrades may appear once
  const firstById = new Map<string, string>();
  for (const { p, u } of known) {
    if (isStackable(u)) continue;
    const first = firstById.get(u.id);
    if (first) addIssue(p.uid, { code: 'duplicate', otherUid: first });
    else firstById.set(u.id, p.uid);
  }

  // grid expanders (fixpoint)
  const expanders = known.filter(({ p, u }) => isGridExpander(u) && !(issues.get(p.uid)?.length));
  const active: { uid: string; dir: ExpandDirection }[] = [];
  let size = { ...ctx.baseSize };
  let changed = true;
  while (changed) {
    changed = false;
    for (const { p } of expanders) {
      if (active.some((a) => a.uid === p.uid)) continue;
      if (cells.get(p.uid)!.every((c) => inBounds(c, size))) {
        active.push({ uid: p.uid, dir: p.expand ?? 'column' });
        size = expandedSize(ctx.baseSize, active.map((a) => a.dir));
        changed = true;
      }
    }
  }
  for (const { p } of expanders) {
    if (!active.some((a) => a.uid === p.uid)) addIssue(p.uid, { code: 'expanderInactive' });
  }

  // bounds + overlap
  const occupancy = new Map<string, string>();
  for (const { p } of known) {
    const cs = cells.get(p.uid)!;
    if (!cs.every((c) => inBounds(c, size))) addIssue(p.uid, { code: 'outOfBounds' });
    for (const c of cs) {
      const k = axialKey(c);
      const other = occupancy.get(k);
      if (other && other !== p.uid) {
        if (!issues.get(p.uid)?.some((i) => i.code === 'overlap' && i.otherUid === other))
          addIssue(p.uid, { code: 'overlap', otherUid: other });
      } else occupancy.set(k, p.uid);
    }
  }

  return {
    size,
    occupancy,
    cells,
    issues,
    activeExpanders: active.map((a) => a.uid),
    valid: issues.size === 0,
  };
}

/** Checks whether `candidate` can be added (or moved, if its uid already exists) to the build. */
export function checkPlacement(
  ctx: BoardContext,
  placements: readonly Placement[],
  candidate: Placement,
): { ok: boolean; issues: Issue[]; state: BoardState } {
  // The candidate is evaluated last, so overlaps and duplicates are attributed to it.
  const rest = placements.filter((p) => p.uid !== candidate.uid);
  const state = evaluate(ctx, [...rest, candidate]);
  const issues = [...(state.issues.get(candidate.uid) ?? [])];
  // Moving/adding may also break others (e.g. moving an expander shrinks the grid under other mods).
  const before = evaluate(ctx, rest);
  for (const [uid, list] of state.issues) {
    if (uid !== candidate.uid && list.length > (before.issues.get(uid)?.length ?? 0)) {
      issues.push(...list.slice(before.issues.get(uid)?.length ?? 0));
    }
  }
  return { ok: issues.length === 0, issues, state };
}

/**
 * All anchors at which `candidate` (with its rotation) is valid, keyed by the absolute position of
 * pattern cell `grabIndex` - used to highlight available positions while dragging.
 */
export function validGrabPositions(
  ctx: BoardContext,
  placements: readonly Placement[],
  candidate: Omit<Placement, 'anchor'>,
  grabIndex: number,
  maxSize: { w: number; h: number },
): Axial[] {
  const u = ctx.getUpgrade(candidate.upgradeId);
  if (!u) return [];
  const pat = placementPattern(ctx.getUpgrade, u, candidate.rotation, candidate.patternFrom);
  const grab = pat.cells[Math.min(grabIndex, pat.cells.length - 1)] ?? { q: 0, r: 0 };
  const out: Axial[] = [];
  for (let x = 0; x < maxSize.w; x++) {
    for (let y = 0; y < maxSize.h; y++) {
      const ax = { q: x, r: y - (x - (x & 1)) / 2 };
      const anchor = { q: ax.q - grab.q, r: ax.r - grab.r };
      if (checkPlacement(ctx, placements, { ...candidate, anchor }).ok) out.push(ax);
    }
  }
  return out;
}

/** First free position (scan columns, then rows) where the upgrade fits, trying allowed rotations. */
export function findFreeSpot(
  ctx: BoardContext,
  placements: readonly Placement[],
  candidate: Omit<Placement, 'anchor' | 'rotation'>,
  rotations: readonly number[],
): Placement | null {
  const size = evaluate(ctx, placements).size;
  for (const rotation of rotations) {
    for (let y = -1; y <= size.h; y++) {
      for (let x = -1; x <= size.w; x++) {
        const anchor = { q: x, r: y - (x - (x & 1)) / 2 };
        const p = { ...candidate, rotation, anchor };
        if (checkPlacement(ctx, placements, p).ok) return p;
      }
    }
  }
  return null;
}
