/** Save editor: lossless writer, edits, roll model. Uses real saves when present (MYCO_SAVE). */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/core/types';
import { readRecords, writeRecords } from '../src/core/save/nrbfw';
import { SaveDoc, expandDirection, findSeed, rollUpgrade, seedQuality, type RollSteps } from '../src/core/save/editor';
import { readSave, seededElement, accountLevelFromMask } from '../src/core/save/savegame';
import { placementsToSlot, slotToPlacements } from '../src/core/save/equip';
import { boardContext } from '../src/store/build';
import { evaluate } from '../src/core/placement';

const data: GameData = JSON.parse(readFileSync(resolve(__dirname, '../public/data/game.json'), 'utf-8'));
const extra = JSON.parse(readFileSync(resolve(__dirname, '../public/data/saveeditor.json'), 'utf-8'));
const steps: RollSteps = extra.rollSteps;
const U = Object.values(data.upgrades);
const byKey = (k: string) => U.find((u) => u.key === k)!;

describe('roll model (same results as saveedit/rolls.py)', () => {
  it('Give and Take: outgoing max-better, incoming min-better', () => {
    const r = rollUpgrade(byKey('Give and Take'), 1279458856, steps);
    expect(r.qualities.length).toBe(2);
    expect(r.qualities[0]).toBeCloseTo(0.993, 3);
    expect(r.qualities[1]).toBeCloseTo(0.998, 3); // t = 0.002 on a min-is-better stat
  });
  it('rolled values collapse the ranges', () => {
    const u = byKey('Immolator');
    const r = rollUpgrade(u, 306464473, steps);
    expect(r.worst).toBeGreaterThan(0.998);
    const before = JSON.stringify(u.props);
    expect(JSON.stringify(r.upgrade.props)).not.toBe(before);
    expect(JSON.stringify(u.props)).toBe(before); // original untouched
  });
  it('findSeed honours element and expander direction, best rolls by default', () => {
    const ie = byKey('InfectExpl');
    const s = findSeed(ie, steps, { element: 'fire', tries: 5000 });
    expect(seededElement(ie, s.seed)).toBe('fire');
    expect(s.worst).toBeGreaterThan(0.99);
    const gg = U.find((u) => u.role === 'gridExpander')!;
    expect(expandDirection(findSeed(gg, steps, { expand: 'row', tries: 50 }).seed)).toBe('row');
    const low = findSeed(byKey('Give and Take'), steps, { target: 0.5, tries: 3000 });
    expect(Math.abs(low.mean - 0.5)).toBeLessThan(0.05);
    expect(seedQuality(byKey('Give and Take'), low.seed, steps)[1]).toBeCloseTo(low.mean, 6);
  });
});

const SAVE = process.env.MYCO_SAVE;
describe.skipIf(!SAVE || !existsSync(SAVE))('editing a real save', () => {
  const bytes = () => new Uint8Array(readFileSync(SAVE!));

  it('reads and writes byte for byte; save() without edits changes nothing', () => {
    const b = bytes();
    expect(Buffer.from(writeRecords(readRecords(b))).equals(Buffer.from(b))).toBe(true);
    expect(Buffer.from(new SaveDoc(b).save()).equals(Buffer.from(b))).toBe(true);
  });

  it('levels, resources, items, mods and skins survive a round trip through the site parser', () => {
    const doc = new SaveDoc(bytes());
    const gear = doc.gears().find((g) => g.id === data.gears.find((x) => x.key === 'bounceshotgun')!.id)!;
    doc.setGear(gear.id, { level: 33, unlock: 2 });
    doc.rotationMask = 15;
    doc.setRootDictInt('resources', 'scrip', 1234);
    doc.setRootDictInt('resources', 'guntoken', 5); // new key
    doc.setRootDictInt('items', 'auth_bruiser', 1);
    const imm = byKey('Immolator');
    const seed = findSeed(imm, steps, { tries: 2000 }).seed;
    const id1 = doc.addInstance(gear.id, imm.id, seed, imm.pattern.cells.length);
    const sb = byKey('StackBullets');
    const id2 = doc.addInstance(gear.id, sb.id, 12345, 3);
    const skin = Object.values(extra.skins as Record<string, { id: string; gears: string[] }>).find((s) => s.gears.includes(gear.id))!;
    const id3 = doc.addInstance(gear.id, skin.id, 777, 0);
    const prism = byKey('Focus Prism');
    const player = data.gears.find((g) => g.key === 'player')!;
    const id4 = doc.addInstance(player.id, prism.id, 4242, prism.pattern.cells.length);
    const out = doc.save();

    const again = new SaveDoc(out);
    expect(again.gears().find((g) => g.id === gear.id)!.level).toBe(33);
    expect(again.rotationMask).toBe(15);
    expect(again.rootDictInt('resources').get('scrip')).toBe(1234);
    expect(again.rootDictInt('resources').get('guntoken')).toBe(5);
    expect(again.rootDictInt('items').get('auth_bruiser')).toBe(1);
    const parsed = readSave(out);
    for (const id of [id1, id2, id3, id4]) expect(parsed.instances.has(id), `instance ${id}`).toBe(true);
    expect(parsed.instances.get(id1)!.seed).toBe(seed);
    expect(parsed.instances.get(id4)!.gearId).toBe(player.id);
  });

  it('equipment slots: reads like the site import; writing a slot keeps the others', () => {
    const b = bytes();
    const ref = readSave(b);
    const doc = new SaveDoc(b);
    for (const g of ref.gears) {
      expect(doc.equips(g.gearId, 0)).toEqual(g.equipped);
      for (let i = 0; i < 3; i++) expect(doc.equips(g.gearId, i + 1)).toEqual(g.loadouts[i] ?? []);
    }
    const loaded = { game: data, overrides: { fields: {} }, comments: { upgrades: {} }, issues: [] } as never;
    const account = accountLevelFromMask(ref.rotationMask, ref.canRotateUpgrades);
    const player = data.gears.find((g) => g.key === 'player')!;
    let n = 0;
    const touched: string[] = [];
    for (const sg of ref.gears) {
      const gear = data.gears.find((g) => g.id === sg.gearId);
      if (!gear || !sg.equipped.length || touched.length >= 6) continue;
      const ctx = boardContext(loaded, gear, account, sg.level);
      const { placements } = slotToPlacements(doc, gear.id, 0, (id) => data.upgrades[id], () => `t${n++}`);
      const res = placementsToSlot(doc, ctx, gear.id, 3, placements, {
        gearCategory: gear.category, playerId: player.id, playerUpgrades: player.upgrades, steps, grantMissing: false,
      });
      expect(res.missing).toEqual([]);
      expect(res.written).toBe(placements.length);
      touched.push(gear.id);
    }
    expect(touched.length).toBeGreaterThan(0);

    // a copy more than the save has: refused without granting, granted (best rolls) with it
    const gid = touched[0];
    const gear0 = data.gears.find((g) => g.id === gid)!;
    const ctx0 = boardContext(loaded, gear0, account, ref.gears.find((x) => x.gearId === gid)!.level);
    const base = slotToPlacements(doc, gid, 0, (id) => data.upgrades[id], () => `x${n++}`).placements;
    const extraCopy = { ...base[0], uid: 'extra', instanceId: undefined };
    const opts = { gearCategory: gear0.category, playerId: player.id, playerUpgrades: player.upgrades, steps };
    const used = doc.instances().filter((i) => i.upgradeId === base[0].upgradeId).length;
    const refused = placementsToSlot(doc, ctx0, gid, 1, [...base, ...Array.from({ length: used }, (_, k) => ({ ...extraCopy, uid: `e${k}` }))], { ...opts, grantMissing: false });
    expect(refused.missing.length).toBeGreaterThan(0);
    const granted = placementsToSlot(doc, ctx0, gid, 1, [...base, ...Array.from({ length: used }, (_, k) => ({ ...extraCopy, uid: `e${k}` }))], { ...opts, grantMissing: true });
    expect(granted.granted).toBeGreaterThan(0);
    expect(granted.missing).toEqual([]);
    const out = readSave(new SaveDoc(doc.save()).save());
    for (const id of touched) {
      const g = out.gears.find((x) => x.gearId === id)!;
      const before = ref.gears.find((x) => x.gearId === id)!;
      const norm = (l: { instanceId: number; x: number; y: number; rotation: number }[]) => [...l].sort((a, c) => a.instanceId - c.instanceId);
      expect(norm(g.loadouts[2] ?? [])).toEqual(norm(before.equipped));
      expect(g.equipped).toEqual(before.equipped);
      if (id !== touched[0]) expect(g.loadouts[0] ?? []).toEqual(before.loadouts[0] ?? []);
      expect(g.loadouts[1] ?? []).toEqual(before.loadouts[1] ?? []);
      void evaluate;
    }
  });
});
