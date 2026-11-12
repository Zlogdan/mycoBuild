/**
 * Lays out every build of saveedit/builds.json with the site's solver and writes saveedit/out/layouts.json:
 * placements in site coordinates + the game's equip coordinates (x, y, rotation) + a share link per build.
 *
 *   cd site && npx vite-node ../saveedit/plan_builds.ts [-- --only gearKey]
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardContext } from '../site/src/store/build';
import { canInfuse, evaluate, type Placement } from '../site/src/core/placement';
import { fromRaw, uniqueOrientations } from '../site/src/core/pattern';
import { allowedRotations, isGridExpander, isStackable } from '../site/src/core/rules';
import { prepareSolve, solutionToPlacements } from '../site/src/core/solver/prepare';
import { solve } from '../site/src/core/solver/solve';
import { axialToOffset } from '../site/src/core/hex';
import { gameFootprint } from '../site/src/core/save/savegame';
import { encodeBuildLink, exportBuild } from '../site/src/core/buildfile';
import type { GameData, Upgrade } from '../site/src/core/types';

const here = dirname(fileURLToPath(import.meta.url));
const data: GameData = JSON.parse(readFileSync(resolve(here, '../site/public/data/game.json'), 'utf-8'));
const loaded = { game: data, overrides: { fields: {} }, comments: { upgrades: {} }, issues: [] } as never;
const spec = JSON.parse(readFileSync(resolve(here, 'builds.json'), 'utf-8')) as { builds: BuildSpec[] };
const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;

interface BuildSpec { gear: string; slot: number; name: string; el: string; must: string[]; extra: string[] }
const ACCOUNT = 96;
const LEVELS: Record<string, number> = { character: 20, primary: 32, throwable: 32 };

const U = Object.values(data.upgrades);
function parse(s: string) {
  const m = s.match(/^([^*<]+)(?:\*(\d+))?(?:<(.+))?$/)!;
  return { key: m[1].trim(), count: m[2] ? Number(m[2]) : 1, donor: m[3]?.trim() };
}

const out: unknown[] = [];
const problems: string[] = [];
for (const b of spec.builds) {
  if (only && `${b.gear}/${b.slot}` !== only && b.gear !== only) continue;
  const gear = data.gears.find((g) => g.key === b.gear)!;
  const ctx = boardContext(loaded, gear, ACCOUNT, LEVELS[gear.category] ?? 20);
  const find = (key: string): Upgrade | undefined =>
    U.find((u) => u.key === key && ctx.pool!.has(u.id)) ?? U.find((u) => u.key === key && ctx.pool!.has(u.id));

  type Entry = { u: Upgrade; count: number; weight: number; donor?: Upgrade; must: boolean };
  const entries: Entry[] = [];
  const add = (s: string, weight: number, must: boolean) => {
    const p = parse(s);
    const u = find(p.key);
    if (!u) return problems.push(`${b.gear}/${b.slot}: unknown upgrade ${p.key}`);
    let donor: Upgrade | undefined;
    if (p.donor) {
      donor = find(p.donor);
      if (!donor || !canInfuse(u, donor)) {
        problems.push(`${b.gear}/${b.slot}: ${p.key} cannot use the pattern of ${p.donor} (${donor ? 'rarity/gear mismatch' : 'unknown'}) - own pattern kept`);
        donor = undefined;
      }
    }
    const same = entries.find((e) => e.u.id === u.id && e.donor?.id === donor?.id);
    if (!isStackable(u) && (same || entries.some((e) => e.u.id === u.id))) {
      if (p.count > 1 || same) problems.push(`${b.gear}/${b.slot}: ${p.key} is not stackable - one copy`);
      return;
    }
    const count = isStackable(u) ? p.count : 1;
    if (same) same.count += count;
    else entries.push({ u, count, weight, donor, must });
  };
  b.must.forEach((s) => add(s, 1000, true));
  b.extra.forEach((s, i) => add(s, Math.max(2, 60 - i * 6), false));
  const expander = U.find((u) => isGridExpander(u) && ctx.pool!.has(u.id));
  if (expander && !entries.some((e) => e.u.id === expander.id)) entries.push({ u: expander, count: 1, weight: 500, must: true });

  // one solver item per (upgrade, donor); the site solver keys items by upgrade id, so infused copies get an alias id
  const selection = entries.map((e, i) => ({ upgradeId: e.u.id, weight: e.weight, count: e.count, i }));
  const input = prepareSolve(ctx, [], selection.map(({ upgradeId, weight, count }) => ({ upgradeId, weight, count })), { keepPlaced: false, timeLimitMs: 5000, topK: 1 });
  // prepareSolve drops duplicate ids? rebuild items from entries to keep donor variants apart
  input.items = entries.map((e, i) => {
    const base = input.items.find((it) => it.upgradeId === e.u.id);
    const rot = allowedRotations(e.u.rarity, ACCOUNT);
    const pat = e.donor ? e.donor.pattern : e.u.pattern;
    const orientations = uniqueOrientations(fromRaw(pat), rot).map((o) => ({
      rotation: o.rotation,
      cells: o.pattern.cells.map(({ q, r }) => ({ q, r })),
      ...(e.donor ? { patternFrom: e.donor.id } : {}),
    }));
    return { upgradeId: `${e.u.id}#${i}`, weight: e.weight, count: e.count, orientations, expander: base?.expander ?? isGridExpander(e.u) };
  });
  // a row gives 7x7 = 49 cells, a column 8x6 = 48: the community layouts fill the 7x7 grid
  input.expanderDirections = ['row'];
  let res = solve(input);
  const mustLeft = (r: typeof res) => Object.keys(r.solutions[0]?.unplaced ?? {}).some((id) => entries[Number(id.split('#')[1])].must);
  if (!res.solutions[0] || mustLeft(res)) {
    const again = solve({ ...input, timeLimitMs: Number(process.env.RETRY_MS ?? 90000) });
    if (again.solutions[0] && (!res.solutions[0] || again.solutions[0].score > res.solutions[0].score)) res = again;
  }
  const sol = res.solutions[0];
  if (!sol) {
    problems.push(`${b.gear}/${b.slot}: no solution`);
    continue;
  }
  let n = 0;
  const placements: Placement[] = solutionToPlacements(
    { ...sol, placements: sol.placements.map((p) => ({ ...p, upgradeId: p.upgradeId.split('#')[0] })) },
    [], false, () => `p${n++}`,
  ).map((p) => {
    const u = data.upgrades[p.upgradeId];
    const el = u.elementChoice?.includes(b.el) ? b.el : u.elementChoice?.[0];
    return el ? { ...p, element: el } : p;
  });
  const st = evaluate(ctx, placements);
  const missing = Object.entries(sol.unplaced).map(([id, k]) => {
    const e = entries[Number(id.split('#')[1])];
    return { key: e.u.key, n: k, must: e.must };
  });
  for (const m of missing.filter((x) => x.must)) problems.push(`${b.gear}/${b.slot}: required ${m.key} x${m.n} did not fit`);
  if (!st.valid) problems.push(`${b.gear}/${b.slot}: layout invalid ${JSON.stringify([...st.issues])}`);

  // game equip coordinates: find (x, y) whose game footprint equals the site cells
  const equips = placements.map((p) => {
    const u = data.upgrades[p.upgradeId];
    const raw = p.patternFrom ? data.upgrades[p.patternFrom].pattern : u.pattern;
    const want = st.cells.get(p.uid)!.map((c) => axialToOffset(c.q, c.r)).map((o) => `${o.x},${o.y}`).sort().join(';');
    for (let x = -12; x <= 20; x++)
      for (let y = -12; y <= 20; y++) {
        const got = gameFootprint(raw, { x, y, rotation: p.rotation }).map((o) => `${o.x},${o.y}`).sort().join(';');
        if (got === want) return { ...p, key: u.key, x, y };
      }
    problems.push(`${b.gear}/${b.slot}: no game position for ${u.key}`);
    return { ...p, key: u.key, x: 0, y: 0 };
  });
  const file = exportBuild(data, ctx, { gear, accountLevel: ACCOUNT, gearLevel: LEVELS[gear.category] ?? 20, placements, autofill: [] });
  const link = 'https://zlogdan.github.io/mycoBuild/#b=' + (await encodeBuildLink(file));
  out.push({ gear: gear.key, gearId: gear.id, category: gear.category, slot: b.slot, name: b.name, size: st.size, score: sol.score, max: res.maxScore,
    missing, placements: equips, link });
  console.log(`${gear.key.padEnd(14)} ${b.slot} ${b.name.padEnd(36)} ${st.size.w}x${st.size.h} placed ${placements.length}` +
    (missing.length ? `  not placed: ${missing.map((m) => `${m.key}${m.n > 1 ? 'x' + m.n : ''}${m.must ? '!' : ''}`).join(', ')}` : ''));
}
mkdirSync(resolve(here, 'out'), { recursive: true });
writeFileSync(resolve(here, 'out', only ? `layouts-${only.replace('/', '-')}.json` : 'layouts.json'), JSON.stringify(out, null, 1));
console.log(problems.length ? '\nPROBLEMS:\n' + problems.join('\n') : '\nno problems');
