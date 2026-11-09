import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/core/types';
import { statRows } from '../src/core/stats';

const data: GameData = JSON.parse(readFileSync(resolve(__dirname, '../public/data/game.json'), 'utf-8'));
const byKey = (key: string) => Object.values(data.upgrades).find((u) => u.key === key)!;
const rows = (key: string) =>
  Object.fromEntries(statRows(byKey(key), data.statLabels, {}, 'ru').map((r) => [r.label, r.value]));

describe('stat rows (real data)', () => {
  it('GlobPuddle «Каплешарики»: ranges, OverrideType.Multiply, inverse fire rate, hidden None', () => {
    expect(rows('GlobPuddle')).toEqual({
      // Globbler_Puddle: StatData.Create(..., overrideType: Add) -> "+value", not a percentage
      'Длительность': '+0.8 … +1.2',
      'Величина': '+0.9 … +1.2',
      'Урон': '-30% … -25%', // damage ×0.7…0.75
      'Зона поражения взрывом': '-40% … -20%', // hitForce ×0.6…0.8
      'Скорость стрельбы': '-24.2% … -21.9%', // fireInterval ×1.28…1.32 shown inverted (CreateInverse)
      // Damage.effectAmount has OverrideType.None -> not applied, not shown
    });
  });

  it('AKillRate «Чувствительный курок»', () => {
    expect(rows('AKillRate')).toEqual({
      'Скорость стрельбы': '+5% … +6%',
      'Скорость перезарядки': '+6% … +9.3%',
      'Длительность': '+2.9 … +3.1',
      'Максимум зарядов': '4',
    });
  });

  it('GrabHeight «Всплеск роста»: additive value, shown like the game (+9.77 in game is within 8…10)', () => {
    expect(rows('GrabHeight')).toEqual({ 'Высота': '+8 … +10' });
  });

  it('no game label is attached to helper fields', () => {
    const helper = Object.entries(data.statLabels).filter(
      ([k, v]) => v.label && /\.(modify\w*|turbocharged|\w*[sS]tackModifier|em[A-Z]\w*)$/.test(k),
    );
    expect(helper.map(([k]) => k)).toEqual([]);
  });
});
