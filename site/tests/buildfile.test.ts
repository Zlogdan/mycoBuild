import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GameData } from '../src/core/types';
import { decodeBuildLink, encodeBuildLink, exportBuild, importBuild, type BuildSnapshot, type ImportContext } from '../src/core/buildfile';
import { solve } from '../src/core/solver/solve';
import { prepareSolve, solutionToPlacements } from '../src/core/solver/prepare';
import { boardContext } from '../src/store/build';

const data: GameData = JSON.parse(readFileSync(resolve(__dirname, '../public/data/game.json'), 'utf-8'));
const loaded = { game: data, overrides: { fields: {} }, comments: { upgrades: {} }, issues: [] };
let n = 0;
const ictx: ImportContext = {
  data,
  boardContext: (g, a, l) => boardContext(loaded, g, a, l),
  newUid: () => `i${n++}`,
};

/** a realistic snapshot: auto-filled Bruiser build with an expander and a rotated upgrade */
function makeSnapshot(): BuildSnapshot {
  const gear = data.gears.find((g) => g.key === 'Bruiser')!;
  const ctx = boardContext(loaded, gear, 30, 10);
  const pool = [...ctx.pool!].map((id) => data.upgrades[id]).filter((u) => u.role === 'normal');
  const expander = Object.values(data.upgrades).find((u) => u.role === 'gridExpander')!;
  const selection = [...pool.slice(0, 8).map((u, i) => ({ upgradeId: u.id, weight: 10 - i, count: 1 })), { upgradeId: expander.id, weight: 1, count: 1 }];
  const res = solve(prepareSolve(ctx, [], selection, { keepPlaced: false, timeLimitMs: 1500 }));
  const placements = solutionToPlacements(res.solutions[0], [], false, () => `p${n++}`);
  return { gear, accountLevel: 30, gearLevel: 10, placements, autofill: selection, autofillOptions: { keepPlaced: false, timeLimitMs: 3000, topK: 5 } };
}

const strip = (s: BuildSnapshot | undefined) =>
  s && {
    gear: s.gear.id,
    levels: [s.accountLevel, s.gearLevel],
    placements: s.placements.map(({ uid: _uid, ...rest }) => rest),
    autofill: s.autofill,
  };

describe('build file v1', () => {
  it('export -> JSON text -> import restores the exact configuration', () => {
    const snap = makeSnapshot();
    expect(snap.placements.some((p) => p.rotation !== 0)).toBe(true);
    const ctx = boardContext(loaded, snap.gear, 30, 10);
    const file = exportBuild(data, ctx, snap);
    expect(file.schemaVersion).toBe(1);
    const res = importBuild(JSON.stringify(file, null, 2), ictx);
    expect(res.ok).toBe(true);
    expect(res.messages.filter((m) => m.level === 'error')).toEqual([]);
    expect(strip(res.build as BuildSnapshot)).toEqual(strip(snap));
    expect(res.build!.autofillOptions).toEqual({ keepPlaced: false, timeLimitMs: 3000, topK: 5 });
  });

  it('share link round-trip (deflate + base64url)', async () => {
    const snap = makeSnapshot();
    const file = exportBuild(data, boardContext(loaded, snap.gear, 30, 10), snap);
    const token = await encodeBuildLink(file);
    expect(token).toMatch(/^b1\.[A-Za-z0-9_-]+$/);
    expect(token.length).toBeLessThan(JSON.stringify(file).length);
    const res = importBuild(await decodeBuildLink(token), ictx);
    expect(strip(res.build as BuildSnapshot)).toEqual(strip(snap));
  });

  it('rejects broken JSON, wrong app, missing or newer version with clear codes', () => {
    expect(importBuild('{not json', ictx).messages[0].code).toBe('invalidJson');
    expect(importBuild('[1,2]', ictx).messages[0].code).toBe('notObject');
    expect(importBuild({ app: 'other', schemaVersion: 1 }, ictx).messages[0].code).toBe('wrongApp');
    expect(importBuild({ app: 'mycobuild' }, ictx).messages[0].code).toBe('noVersion');
    const newer = importBuild({ app: 'mycobuild', schemaVersion: 2 }, ictx);
    expect(newer.ok).toBe(false);
    expect(newer.messages[0]).toMatchObject({ code: 'newerVersion', params: { version: 2, supported: 1 } });
  });

  it('validates fields', () => {
    const base = exportBuild(data, boardContext(loaded, makeSnapshot().gear, 30, 10), makeSnapshot());
    expect(importBuild({ ...base, levels: { account: 'x', gear: 1 } }, ictx).messages[0]).toMatchObject({ code: 'badField', params: { field: 'levels' } });
    const badRot = { ...base, placed: [{ ...base.placed[0], rotation: 7 }] };
    expect(importBuild(badRot, ictx).messages[0]).toMatchObject({ code: 'badField', params: { field: 'placed[0]' } });
    expect(importBuild({ ...base, gear: { id: 'nope', key: 'nope' } }, ictx).messages[0].code).toBe('unknownGear');
  });

  it('missing / renamed upgrades: found by key, otherwise skipped with a warning', () => {
    const snap = makeSnapshot();
    const file = exportBuild(data, boardContext(loaded, snap.gear, 30, 10), snap);
    file.placed[0] = { ...file.placed[0], upgradeId: '999999999' }; // id changed, key still valid
    file.placed[1] = { ...file.placed[1], upgradeId: '888888888', key: 'NoSuchUpgrade' }; // gone
    const res = importBuild(file, ictx);
    expect(res.ok).toBe(true);
    expect(res.messages.map((m) => m.code)).toEqual(expect.arrayContaining(['upgradeByKey', 'unknownUpgrade']));
    expect(res.build!.placements).toHaveLength(snap.placements.length - 1);
  });

  it('restores invalid placements as they are and reports them', () => {
    const snap = makeSnapshot();
    const file = exportBuild(data, boardContext(loaded, snap.gear, 30, 10), snap);
    // lower the account level: rotated upgrades become rotation-locked
    const res = importBuild({ ...file, levels: { account: 1, gear: 10 } }, ictx);
    expect(res.ok).toBe(true);
    expect(res.build!.placements).toHaveLength(snap.placements.length);
    expect(res.messages.some((m) => m.code === 'placementIssue' && m.params?.issue === 'rotationLocked')).toBe(true);
  });

  it('warns when the file was made with other game data', () => {
    const snap = makeSnapshot();
    const file = exportBuild(data, boardContext(loaded, snap.gear, 30, 10), snap);
    const res = importBuild({ ...file, gameData: { extractedAt: '2020-01-01T00:00:00Z' } }, ictx);
    expect(res.messages[0]).toMatchObject({ level: 'warning', code: 'otherGameData' });
  });
});

describe('per-instance element', () => {
  it('is exported and restored; an invalid element is dropped with a warning', () => {
    const gear = data.gears.find((g) => g.key === 'photondisc')!;
    const ctx = boardContext(loaded, gear, 30, 10);
    const u = [...ctx.pool!].map((id) => data.upgrades[id]).find((x) => x.elementChoice?.includes('acid'))!;
    const snap = { gear, accountLevel: 30, gearLevel: 10, autofill: [], placements: [{ uid: 'e1', upgradeId: u.id, rotation: 0, anchor: { q: 0, r: 0 }, element: 'acid' }] };
    const file = exportBuild(data, ctx, snap);
    expect(file.placed[0].element).toBe('acid');
    const res = importBuild(JSON.stringify(file), ictx);
    expect(res.build!.placements[0].element).toBe('acid');
    const bad = importBuild({ ...file, placed: [{ ...file.placed[0], element: 'water' }] }, ictx);
    expect(bad.build!.placements[0].element).toBeUndefined();
    expect(bad.messages.some((m) => m.code === 'badElement')).toBe(true);
  });
});
