/**
 * Reading builds from the game's save (PlayerData.saxon, .NET BinaryFormatter).
 *
 * Save structure (PlayerData): collectedGear: Dictionary<int gearId, GearData{ level, equippedUpgrades,
 * loadouts[] }>, data: Dictionary<int gearId, List<UpgradeInfo{ idV2.ID, Instances: List<UpgradeInstance> }>>.
 * UpgradeEquipData{ upgradeID = instance id, x, y, rotation } uses the game's own anchor convention,
 * converted here with a literal port of HexMap.GetModifiedMap + GearData.CanEquipUpgrade.
 */
import type { RawPattern, Upgrade } from '../types';
import { type Axial, offsetToAxial } from '../hex';
import { canInfuse, placementPattern, type Placement } from '../placement';
import { axialKey } from '../hex';
import { parseNrbf, type NrbfObject, type NrbfValue } from './nrbf';

/* ---------------- game math (ported from Assembly-CSharp IL) ---------------- */

/** C#-style integer division (truncation towards zero). */
const idiv = (a: number, b: number) => Math.trunc(a / b);
/** C#-style remainder (sign of the dividend). */
const rem = (a: number, b: number) => a % b;

function hexToCube(x: number, y: number) {
  const z = y - idiv(x - (x & 1), 2);
  return { x, y: -x - z, z };
}
function rotateCube(c: { x: number; y: number; z: number }, n: number) {
  let v = c;
  for (let i = 0; i < n; i++) v = { x: -v.y, y: -v.z, z: -v.x };
  return v;
}
function cubeToHex(c: { x: number; z: number }) {
  return { x: c.x, y: c.z + idiv(c.x - (c.x & 1), 2) };
}
/** HexMap.AdjustRow */
function adjustRow(x: number, y: number, offX: number) {
  return Math.abs(offX) % 2 === 1 && rem(x + offX, 2) === 1 ? y - 1 : y;
}

/** HexMap.GetModifiedMap(rotation): rotated pattern as offset cells inside its own w×h box. */
export function gameRotatedMap(raw: RawPattern, rotation: number): { w: number; h: number; cells: { x: number; y: number }[] } {
  const src = raw.cells.map(([x, y]) => ({ x, y }));
  const rot = src.map((c) => cubeToHex(rotateCube(hexToCube(c.x, c.y), rotation)));
  // CalculateRotatedSize
  const minX = Math.min(...rot.map((c) => c.x));
  const maxX = Math.max(...rot.map((c) => c.x));
  const offX = -minX;
  const adjY = rot.map((c) => adjustRow(c.x, c.y, offX));
  const minY = Math.min(...adjY);
  const maxY = Math.max(...adjY);
  const offY = -minY;
  return {
    w: maxX - minX + 1,
    h: maxY - minY + 1,
    cells: rot.map((c, i) => ({ x: c.x + offX, y: adjY[i] + offY })),
  };
}

/** Board cells (offset) occupied by an UpgradeEquipData, exactly as GearData.CanEquipUpgrade computes them. */
export function gameFootprint(raw: RawPattern, ex: { x: number; y: number; rotation: number }): { x: number; y: number }[] {
  const map = gameRotatedMap(raw, ex.rotation);
  const half = idiv(map.w, 2);
  const loc2 = ex.x + half;
  return map.cells.map((c) => {
    const ax = c.x + ex.x;
    let ay = c.y + ex.y;
    if (rem(c.x, 2) === 1 && rem(ax, 2) === 0) ay++;
    if (rem(loc2, 2) === 1) ay++;
    if (rem(loc2, 2) === 1 && rem(half, 2) === 0) ay--;
    return { x: ax, y: ay };
  });
}

/** The game's Random struct (state = seed; Next = hash step; NextBool = odd result). */
export function gameRandomNextBool(seed: number): boolean {
  return (~new GameRandom(seed).next() & 1) === 0;
}

/* ---- game hashing (MathUtil / Random / Upgrade, ported from IL) ---- */

const C1 = -1547330877; // 0xA3C59AC3
const C2 = -1640531527; // 0x9E3779B9

/** MathUtil.Hash(int) — also the step of Random.Next(). */
export function gameHash(x: number): number {
  let v = (x ^ C1) | 0;
  v = Math.imul(v, C2);
  v ^= v >>> 16;
  v = Math.imul(v, C2);
  v ^= v >>> 16;
  return Math.imul(v, C2);
}

/** MathUtil.Squirrel3Hash(int position, int seed). */
export function squirrel3(a: number, b: number): number {
  let v = (Math.imul(a, -1255572915) + b) | 0;
  v ^= v >>> 8;
  v = (v + 1759714724) | 0;
  v ^= v << 8;
  v = Math.imul(v, 458671337);
  v ^= v >>> 8;
  return Math.imul(v, C2);
}

/** Upgrade.ModifyPropertySeed(seed, index): seed of the property with 1-based index in Upgrade.properties. */
export const modifyPropertySeed = (seed: number, index: number) => squirrel3(seed, Math.imul(gameHash(Math.imul(index + 384, 71)), 43874));

/** The game's Random struct. */
export class GameRandom {
  constructor(public state: number) {}
  next(): number {
    this.state = gameHash(this.state);
    return this.state;
  }
  /** Random.Next(min, max): ((uint)Next() * (uint)(max - min)) >> 32, + min (max exclusive). */
  nextRange(min: number, max: number): number {
    const r = BigInt(this.next() >>> 0) * BigInt((max - min) >>> 0);
    return Number(r >> 32n) + min;
  }
}

const EFFECT_KEYS: Record<number, string> = { 0: 'normal', 1: 'fire', 2: 'shock', 3: 'acid', 8: 'bees', 10: 'cryo' };

/** UpgradeProperty.GetRandomEffect* variants (EffectType values), ported from IL. */
export function rollEffect(rand: GameRandom, func: string, count: number | null): number {
  switch (func) {
    case 'GetRandomEffect':
      return rand.nextRange(1, 4);
    case 'GetRandomEffectIncludingNormal':
      return rand.nextRange(0, 4);
    case 'GetRandomEffectIncludingNormalAndCryo': {
      const v = rand.nextRange(0, 5);
      return v === 4 ? 10 : v;
    }
    case 'GetRandomEffectIncludingCryo': {
      const n = count ?? 3; // () overload: Next(1, 5), 4 => Cryo; (count) overload: Next(1, count + 2), count + 1 => Cryo
      const v = rand.nextRange(1, n + 2);
      return v === n + 1 ? 10 : v;
    }
    case 'GetRandomEffectIncludingCryoAndBees': {
      const v = rand.nextRange(1, 6);
      return v === 5 ? 10 : v === 4 ? 8 : v;
    }
    default:
      return rand.nextRange(1, 4);
  }
}

/**
 * Element of an upgrade instance, reproduced like the game: the property's Random is seeded with
 * Upgrade.ModifyPropertySeed(seed, index + 1); `draws` stat rolls happen first (OverrideData.ApplyTo /
 * Range.GetValue on the same Random), then GetRandomEffect* picks the element (Upgrade.elementRoll).
 */
export function seededElement(u: Upgrade, seed: number): string | undefined {
  const r = u.elementRoll;
  if (!r) return undefined;
  const rand = new GameRandom(modifyPropertySeed(seed, r.prop + 1));
  for (let i = 0; i < r.draws; i++) rand.next();
  return EFFECT_KEYS[rollEffect(rand, r.func, r.count)];
}

/** UpgradeProperty_GrowGrid.AffectsColumn: +1 column if true, else +1 row. */
export const growGridDirection = (seed: number): 'column' | 'row' => (gameRandomNextBool(seed) ? 'column' : 'row');

/* ---------------- save structure ---------------- */

export interface SaveInstance {
  instanceId: number;
  upgradeId: string;
  seed: number;
  gearId: string;
  /** Pattern Infuser: upgrade id whose pattern this instance uses (UpgradeInstance.overriddenPatternID) */
  patternFrom?: string;
}

export interface SaveEquip {
  instanceId: number;
  x: number;
  y: number;
  rotation: number;
}

export interface SaveGear {
  gearId: string;
  level: number;
  equipped: SaveEquip[];
  loadouts: SaveEquip[][];
}

export interface SaveData {
  /** PlayerData.upgradeRarityRotations bit mask (bit i = rarity i rotation unlocked) */
  rotationMask: number;
  canRotateUpgrades: boolean;
  gears: SaveGear[];
  instances: Map<number, SaveInstance>;
}

const obj = (v: NrbfValue | undefined): NrbfObject | null => (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array) ? (v as NrbfObject) : null);
const num = (v: NrbfValue | undefined): number => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0);

/** System.Collections.Generic.List<T> -> items */
function list(v: NrbfValue | undefined): NrbfValue[] {
  const o = obj(v);
  if (!o) return Array.isArray(v) ? v : [];
  const items = o._items;
  return Array.isArray(items) ? items.slice(0, num(o._size)) : [];
}

/** System.Collections.Generic.Dictionary<K,V> -> [key, value][] */
function dict(v: NrbfValue | undefined): [NrbfValue, NrbfValue][] {
  const o = obj(v);
  const kv = o?.KeyValuePairs;
  if (!Array.isArray(kv)) return [];
  return kv.map((p) => obj(p)).filter((p): p is NrbfObject => !!p).map((p) => [p.key, p.value]);
}

function readEquips(v: NrbfValue | undefined): SaveEquip[] {
  return list(v)
    .map(obj)
    .filter((e): e is NrbfObject => !!e)
    .map((e) => ({ instanceId: num(e.upgradeID), x: num(e.x), y: num(e.y), rotation: num(e.rotation) }));
}

export function readSave(bytes: Uint8Array): SaveData {
  const root = parseNrbf(bytes);
  if (root.$class !== 'PlayerData') throw new Error(`not a Mycopunk PlayerData save (${root.$class})`);

  const instances = new Map<number, SaveInstance>();
  for (const [gearKey, infos] of dict(root.data)) {
    for (const infoV of list(infos)) {
      const info = obj(infoV);
      if (!info) continue;
      const upgradeId = String(num(obj(info.idV2)?.ID) || num(info.upgradeID));
      for (const insV of list(info.Instances)) {
        const ins = obj(insV);
        if (!ins) continue;
        const instanceId = num(ins.id);
        const own = String(num(obj(ins.upgradeIDv2)?.ID) || upgradeId);
        const over = num(ins.overriddenPatternID);
        instances.set(instanceId, {
          instanceId,
          upgradeId: own,
          ...(over && String(over) !== own ? { patternFrom: String(over) } : {}),
          seed: num(ins['<Seed>k__BackingField']),
          gearId: String(num(ins.gearID) || num(gearKey)),
        });
      }
    }
  }

  const gears: SaveGear[] = [];
  for (const [key, gv] of dict(root.collectedGear)) {
    const g = obj(gv);
    if (!g) continue;
    const loadouts = (Array.isArray(g.loadouts) ? g.loadouts : []).map((l) => readEquips(obj(l)?.upgrades));
    gears.push({ gearId: String(num(key)), level: num(g.level), equipped: readEquips(g.equippedUpgrades), loadouts });
  }

  return {
    rotationMask: num(root.upgradeRarityRotations),
    canRotateUpgrades: root.canRotateUpgrades === true,
    gears,
    instances,
  };
}

/** Lowest account level consistent with the rotation unlock mask (3 / 8 / 16 / 30). */
export function accountLevelFromMask(mask: number, canRotateAll: boolean): number {
  if (canRotateAll || mask & 8) return 30;
  if (mask & 4) return 16;
  if (mask & 2) return 8;
  if (mask & 1) return 3;
  return 1;
}

/* ---------------- conversion to site placements ---------------- */

export interface ConvertIssue {
  instanceId: number;
  reason: 'unknownInstance' | 'unknownUpgrade' | 'shapeMismatch';
  upgradeId?: string;
}

/**
 * Converts the game's equip entries into site placements. The occupied cells are computed with the game's
 * own formula; the site's anchor is then derived and the footprint is cross-checked (shapeMismatch would
 * mean the site's rotation model disagrees with the game).
 */
export function convertEquips(
  equips: SaveEquip[],
  save: SaveData,
  getUpgrade: (id: string) => Upgrade | undefined,
  newUid: () => string,
): { placements: Placement[]; issues: ConvertIssue[] } {
  const placements: Placement[] = [];
  const issues: ConvertIssue[] = [];
  for (const e of equips) {
    const inst = save.instances.get(e.instanceId);
    if (!inst) {
      issues.push({ instanceId: e.instanceId, reason: 'unknownInstance' });
      continue;
    }
    const u = getUpgrade(inst.upgradeId);
    if (!u) {
      issues.push({ instanceId: e.instanceId, reason: 'unknownUpgrade', upgradeId: inst.upgradeId });
      continue;
    }
    const rotation = ((e.rotation % 6) + 6) % 6;
    const donor = inst.patternFrom ? getUpgrade(inst.patternFrom) : undefined;
    const patternFrom = donor && canInfuse(u, donor) ? donor.id : undefined;
    const cells: Axial[] = gameFootprint((patternFrom ? donor! : u).pattern, { ...e, rotation }).map((c) => offsetToAxial(c.x, c.y));
    const anchor = { q: Math.min(...cells.map((c) => c.q)), r: Math.min(...cells.map((c) => c.r)) };
    const ours = placementPattern(getUpgrade, u, rotation, patternFrom).cells.map((c) => axialKey({ q: c.q + anchor.q, r: c.r + anchor.r })).sort();
    const theirs = cells.map(axialKey).sort();
    if (ours.join(';') !== theirs.join(';')) {
      issues.push({ instanceId: e.instanceId, reason: 'shapeMismatch', upgradeId: u.id });
      continue;
    }
    placements.push({
      uid: newUid(),
      upgradeId: u.id,
      rotation,
      anchor,
      ...(u.role === 'gridExpander' ? { expand: growGridDirection(inst.seed) } : {}),
      ...(u.elementChoice && seededElement(u, inst.seed) ? { element: seededElement(u, inst.seed) } : {}),
      ...(patternFrom ? { patternFrom } : {}),
      instanceId: e.instanceId,
    });
  }
  return { placements, issues };
}
