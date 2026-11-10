import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/core/types';
import { accountLevelFromMask, convertEquips, gameFootprint, gameRandomNextBool, readSave } from '../src/core/save/savegame';
import { offsetToAxial, axialKey } from '../src/core/hex';
import { upgradePattern, evaluate } from '../src/core/placement';
import { boardContext } from '../src/store/build';

const data: GameData = JSON.parse(readFileSync(resolve(__dirname, '../public/data/game.json'), 'utf-8'));
const loaded = { game: data, overrides: { fields: {} }, comments: { upgrades: {} }, issues: [] };

describe('game anchor convention (GearData.CanEquipUpgrade port)', () => {
  it('for every pattern, rotation and position the game footprint equals the site shape', () => {
    let checked = 0;
    for (const u of Object.values(data.upgrades)) {
      if (!u.pattern.cells.length) continue;
      for (let rot = 0; rot < 6; rot++)
        for (const x of [-1, 0, 1, 2, 3])
          for (const y of [-1, 0, 2]) {
            const cells = gameFootprint(u.pattern, { x, y, rotation: rot }).map((c) => offsetToAxial(c.x, c.y));
            const mq = Math.min(...cells.map((c) => c.q));
            const mr = Math.min(...cells.map((c) => c.r));
            const theirs = cells.map((c) => axialKey({ q: c.q - mq, r: c.r - mr })).sort().join(';');
            const ours = upgradePattern(u, rot).cells.map(axialKey).sort().join(';');
            expect(theirs, `${u.key} rot ${rot} at ${x},${y}`).toBe(ours);
            checked++;
          }
    }
    expect(checked).toBeGreaterThan(60000);
  });

  it('account level from the rotation unlock mask', () => {
    expect(accountLevelFromMask(15, false)).toBe(30);
    expect(accountLevelFromMask(7, false)).toBe(16);
    expect(accountLevelFromMask(1, false)).toBe(3);
    expect(accountLevelFromMask(0, false)).toBe(1);
  });

  it('game Random.NextBool is deterministic per seed and roughly balanced', () => {
    let t = 0;
    for (let s = -5000; s < 5000; s++) if (gameRandomNextBool(s)) t++;
    expect(gameRandomNextBool(12345)).toBe(gameRandomNextBool(12345));
    expect(t).toBeGreaterThan(4000);
    expect(t).toBeLessThan(6000);
  });
});

/* Real save: set MYCO_SAVE=<path to PlayerData.saxon>. The save itself is never committed. */
const SAVE = process.env.MYCO_SAVE;
describe.skipIf(!SAVE || !existsSync(SAVE))('real save file', () => {
  // Equipped builds must be valid. Saved loadouts may be stale (game patches, other layouts): the game's
  // GearData.EquipLoadout skips upgrades that CanEquipUpgrade/EquipUpgrade reject ("cantequip"), so
  // loadout issues are only reported. Shape conversion must never fail.
  it('every equipped build and loadout converts; equipped builds are valid under the site rules', () => {
    const save = readSave(new Uint8Array(readFileSync(SAVE!)));
    const account = accountLevelFromMask(save.rotationMask, save.canRotateUpgrades);
    let n = 0;
    const report: string[] = [];
    const fatal: string[] = [];
    let builds = 0;
    let infused = 0;
    for (const g of save.gears) {
      const gear = data.gears.find((x) => x.id === g.gearId);
      if (!gear) continue;
      const ctx = boardContext(loaded, gear, account, g.level);
      const sets = [{ name: 'equipped', list: g.equipped }, ...g.loadouts.map((l, i) => ({ name: `loadout${i + 1}`, list: l }))];
      for (const s of sets) {
        if (!s.list.length) continue;
        builds++;
        const { placements, issues } = convertEquips(s.list, save, (id) => data.upgrades[id], () => `s${n++}`);
        // excluded (Ouroboros-only) upgrades are not in the site data -> reported; a shape mismatch is always fatal
        for (const i of issues)
          (i.reason === 'shapeMismatch' || (s.name === 'equipped' && i.reason !== 'unknownUpgrade') ? fatal : report).push(`${gear.key}/${s.name}: ${i.reason} ${i.upgradeId ?? i.instanceId}`);
        infused += placements.filter((p) => p.patternFrom).length;
        const st = evaluate(ctx, placements);
        for (const [uid, list] of st.issues) {
          const p = placements.find((x) => x.uid === uid)!;
          const line = `${gear.key}/${s.name} (lvl ${g.level}, grid ${st.size.w}×${st.size.h}): ${data.upgrades[p.upgradeId].key} -> ${list.map((i) => i.code).join(',')}`;
          (s.name === 'equipped' ? fatal : report).push(line);
        }
      }
    }
    console.log(`account level ${account}, builds checked: ${builds}, infused: ${infused}\n` + (report.join('\n') || 'no issues'));
    expect(builds).toBeGreaterThan(0);
    expect(fatal).toEqual([]);
  });
});

describe('seeded element (PhotonDisc_Attunement: first draw of the property Random)', () => {
  it('is one of fire/shock/acid and deterministic', async () => {
    const { seededElement } = await import('../src/core/save/savegame');
    const u = Object.values(data.upgrades).find((x) => x.props.some((p) => p.type === 'PhotonDisc_Attunement'))!;
    const seen = new Set<string>();
    for (let s = -300; s < 300; s++) {
      const e = seededElement(u, s)!;
      expect(['fire', 'shock', 'acid']).toContain(e);
      expect(seededElement(u, s)).toBe(e);
      seen.add(e);
    }
    expect(seen.size).toBe(3);
  });
});

describe('element roll rules from the game IL', () => {
  const byName = (ru: string) => Object.values(data.upgrades).find((u) => u.name.ru === ru)!;
  it('MycoGear_GrabDamage rolls an element only when effect == All (127) is applied', () => {
    expect(byName('Экзотическая флора').elementRoll).toMatchObject({ func: 'GetRandomEffect', draws: 0 });
    expect(byName('Шипы').elementChoice).toBeUndefined(); // effect not applied (method None)
    expect(byName('Случайные ростки').elementChoice).toBeUndefined();
  });
  it('Killcode: two stat rolls before a 5-way element (incl. bees and cryo)', () => {
    expect(byName('Код самоуничтожения').elementRoll).toMatchObject({ func: 'GetRandomEffectIncludingCryoAndBees', draws: 2 });
    expect(byName('Код самоуничтожения').elementChoice).toEqual(['fire', 'shock', 'acid', 'bees', 'cryo']);
  });
  it('every upgrade with an element choice can be derived from the seed', () => {
    const missing = Object.values(data.upgrades).filter((u) => u.elementChoice && !u.elementRoll).map((u) => u.key);
    expect(missing).toEqual([]);
  });
});
