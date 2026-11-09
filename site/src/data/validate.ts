import type { GameData } from '../core/types';
import { validateRaw } from '../core/pattern';

export interface DataIssue {
  level: 'error' | 'warning';
  where: string;
  message: string;
}

/** Consistency checks of the game database (after patches are applied). */
export function validateGameData(d: GameData): DataIssue[] {
  const out: DataIssue[] = [];
  const err = (where: string, message: string) => out.push({ level: 'error', where, message });

  if (!Array.isArray(d.gears) || typeof d.upgrades !== 'object') {
    err('root', 'gears[] / upgrades{} missing');
    return out;
  }
  const gearIds = new Set<string>();
  for (const g of d.gears) {
    if (gearIds.has(g.id)) err(`gear ${g.key}`, `duplicate id ${g.id}`);
    gearIds.add(g.id);
    if (!d.gridProfiles[g.grid]?.length) err(`gear ${g.key}`, `unknown grid profile ${g.grid}`);
    for (const id of g.upgrades) if (!d.upgrades[id]) err(`gear ${g.key}`, `unknown upgrade ${id}`);
    if (g.ability && !d.upgrades[g.ability]) err(`gear ${g.key}`, `unknown ability ${g.ability}`);
  }
  for (const [id, u] of Object.entries(d.upgrades)) {
    if (String(u.id) !== id) err(`upgrade ${u.key}`, `id mismatch ${u.id} != ${id}`);
    if (u.role === 'ability') continue;
    for (const issue of validateRaw(u.pattern))
      out.push({ level: issue.level, where: `upgrade ${u.key}`, message: issue.message });
    if (!d.rarities.some((r) => r.id === u.rarity)) err(`upgrade ${u.key}`, `unknown rarity ${u.rarity}`);
  }
  return out;
}
