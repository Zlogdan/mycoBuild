/**
 * Equipment slots of a save <-> site placements.
 * Save -> site: the game's own footprint formula (convertEquips). Site -> save: the game position whose footprint
 * equals the placement's cells; every placement is matched to an instance (same upgrade, element, pattern donor,
 * grid-expander direction), missing instances can be granted with the best rolls.
 */
import type { Upgrade } from '../types';
import { axialToOffset } from '../hex';
import { evaluate, type BoardContext, type Placement } from '../placement';
import { isGridExpander } from '../rules';
import { convertEquips, gameFootprint, seededElement, type SaveData } from './savegame';
import { expandDirection, findSeed, type RollSteps, type SaveDoc, type SaveEquipEntry } from './editor';

/** Gear whose upgrade list stores an upgrade used on `gear` (characters keep shared mods and expanders in the player gear). */
export function storeGear(gearCategory: string, gearId: string, u: Upgrade, playerId: string, playerUpgrades: readonly string[]): string {
  return gearCategory === 'character' && (playerUpgrades.includes(u.id) || isGridExpander(u)) ? playerId : gearId;
}

export function slotToPlacements(doc: SaveDoc, gearId: string, slot: number, getUpgrade: (id: string) => Upgrade | undefined, newUid: () => string) {
  const instances = new Map(doc.instances().map((i) => [i.id, { instanceId: i.id, upgradeId: i.upgradeId, seed: i.seed, gearId: i.gearId, patternFrom: i.patternFrom }]));
  return convertEquips(doc.equips(gearId, slot), { instances } as unknown as SaveData, getUpgrade, newUid);
}

export interface WriteSlotOptions {
  gearCategory: string;
  playerId: string;
  playerUpgrades: readonly string[];
  steps: RollSteps;
  /** grant instances that are missing in the save (best rolls) */
  grantMissing: boolean;
}

export function placementsToSlot(
  doc: SaveDoc,
  ctx: BoardContext,
  gearId: string,
  slot: number,
  placements: readonly Placement[],
  opts: WriteSlotOptions,
): { written: number; granted: number; missing: string[] } {
  const state = evaluate(ctx, placements);
  const all = doc.instances();
  const used = new Set<number>();
  const entries: SaveEquipEntry[] = [];
  const missing: string[] = [];
  let granted = 0;
  for (const p of placements) {
    const u = ctx.getUpgrade(p.upgradeId);
    const cells = state.cells.get(p.uid);
    if (!u || !cells) continue;
    const store = storeGear(opts.gearCategory, gearId, u, opts.playerId, opts.playerUpgrades);
    const element = u.elementRoll && p.element ? p.element : undefined;
    const expand = isGridExpander(u) ? p.expand ?? 'column' : undefined;
    const fits = (i: (typeof all)[number]) =>
      i.upgradeId === u.id &&
      i.gearId === store &&
      (i.patternFrom ?? null) === (p.patternFrom ?? null) &&
      (!element || seededElement(u, i.seed) === element) &&
      (!expand || expandDirection(i.seed) === expand);
    const hinted = p.instanceId !== undefined ? all.find((i) => i.id === p.instanceId && !used.has(i.id) && fits(i)) : undefined;
    let inst = hinted ?? all.find(
      (i) =>
        !used.has(i.id) &&
        i.upgradeId === u.id &&
        i.gearId === store &&
        (i.patternFrom ?? null) === (p.patternFrom ?? null) &&
        (!element || seededElement(u, i.seed) === element) &&
        (!expand || expandDirection(i.seed) === expand),
    );
    if (!inst) {
      if (!opts.grantMissing) {
        missing.push(u.key);
        continue;
      }
      const seed = findSeed(u, opts.steps, { element, expand }).seed;
      const donor = p.patternFrom ? ctx.getUpgrade(p.patternFrom) : undefined;
      const id = doc.addInstance(store, u.id, seed, (donor ?? u).pattern.cells.length, donor?.id);
      granted++;
      inst = doc.instances().find((i) => i.id === id)!;
      all.push(inst);
    }
    used.add(inst.id);
    // game position: (x, y) whose footprint equals the placement cells
    const raw = (p.patternFrom ? ctx.getUpgrade(p.patternFrom) ?? u : u).pattern;
    const want = cells.map((c) => axialToOffset(c.q, c.r)).map((o) => `${o.x},${o.y}`).sort().join(';');
    let pos: { x: number; y: number } | null = null;
    for (let x = -12; x <= 20 && !pos; x++)
      for (let y = -12; y <= 20 && !pos; y++)
        if (gameFootprint(raw, { x, y, rotation: p.rotation }).map((o) => `${o.x},${o.y}`).sort().join(';') === want) pos = { x, y };
    if (!pos) {
      missing.push(u.key);
      continue;
    }
    entries.push({ instanceId: inst.id, x: pos.x, y: pos.y, rotation: p.rotation });
  }
  doc.setEquips(gearId, slot, entries);
  return { written: entries.length, granted, missing };
}
