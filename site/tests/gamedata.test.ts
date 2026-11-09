/** Smoke tests against the real extracted database (public/data/game.json). */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/core/types';
import { fromRaw, rotate, validateRaw } from '../src/core/pattern';
import { validateGameData } from '../src/data/validate';

const data: GameData = JSON.parse(readFileSync(resolve(__dirname, '../public/data/game.json'), 'utf-8'));

describe('game.json', () => {
  it('has gear, upgrades and grid profiles', () => {
    expect(data.gears.length).toBeGreaterThan(20);
    expect(Object.keys(data.upgrades).length).toBeGreaterThan(700);
    expect(data.gridProfiles.DefaultGridProfile).toBeTruthy();
  });

  it('every placeable pattern is valid; only the 3 known ones are disconnected', () => {
    const disconnected: string[] = [];
    for (const u of Object.values(data.upgrades)) {
      if (u.role === 'ability') continue;
      const issues = validateRaw(u.pattern);
      expect(issues.filter((i) => i.level === 'error'), u.key).toEqual([]);
      if (issues.some((i) => i.code === 'disconnected')) disconnected.push(u.key);
    }
    expect(disconnected.sort()).toEqual(['Makeshift Barrel', 'Multiball', 'Switcheroo']);
  });

  it('6 rotations of every pattern return to the original', () => {
    for (const u of Object.values(data.upgrades)) {
      const p = fromRaw(u.pattern);
      expect(rotate(rotate(p, 3), 3)).toEqual(p);
    }
  });

  it('database validation has no errors', () => {
    const res = validateGameData(data);
    expect(res.filter((i) => i.level === 'error')).toEqual([]);
  });
});
