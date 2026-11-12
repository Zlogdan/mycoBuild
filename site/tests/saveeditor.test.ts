/** Save editor: lossless writer, edits, roll model. Uses real saves when present (MYCO_SAVE). */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/core/types';
import { readRecords, writeRecords } from '../src/core/save/nrbfw';
import { SaveDoc, expandDirection, findSeed, rollUpgrade, seedQuality, type RollSteps } from '../src/core/save/editor';
import { readSave, seededElement } from '../src/core/save/savegame';

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
});
