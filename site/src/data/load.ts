import type { Gear, GameData, StatOverride, Upgrade } from '../core/types';
import { validateGameData, type DataIssue } from './validate';

/**
 * Manual data layer on top of the generated game.json (public/data/patches.json).
 * - upgrades / gears: merged by id (shallow merge of fields; a new id adds an entry)
 * - gears[id].addUpgrades / removeUpgrades: edit the upgrade list without rewriting it
 * - remove: ids to delete
 */
export interface DataPatches {
  upgrades?: Record<string, Partial<Upgrade>>;
  gears?: Record<string, Partial<Gear> & { addUpgrades?: string[]; removeUpgrades?: string[] }>;
  remove?: { upgrades?: string[]; gears?: string[] };
}

export interface StatOverrides {
  fields: Record<string, StatOverride>;
}

export interface UpgradeComment {
  key?: string;
  text: string;
}

export interface CommentsFile {
  upgrades: Record<string, UpgradeComment>;
}

export interface LoadedData {
  game: GameData;
  overrides: StatOverrides;
  /** shared comments from public/data/comments.json */
  comments: CommentsFile;
  issues: DataIssue[];
}

/** Ids are strings everywhere (older game.json files stored upgrade ids as numbers). */
export function normalizeIds(d: GameData): GameData {
  for (const [key, u] of Object.entries(d.upgrades)) u.id = String(u.id ?? key);
  for (const g of d.gears) {
    g.id = String(g.id);
    g.upgrades = g.upgrades.map(String);
    if (g.ability != null) g.ability = String(g.ability);
  }
  return d;
}

export function applyPatches(base: GameData, patches: DataPatches | null): GameData {
  if (!patches) return base;
  const game: GameData = { ...base, upgrades: { ...base.upgrades }, gears: base.gears.map((g) => ({ ...g })) };
  for (const [id, patch] of Object.entries(patches.upgrades ?? {})) {
    const prev = game.upgrades[id];
    game.upgrades[id] = { ...(prev ?? ({ gears: [], props: [], flags: [], role: 'normal' } as unknown as Upgrade)), ...patch, id } as Upgrade;
  }
  for (const [id, patch] of Object.entries(patches.gears ?? {})) {
    const { addUpgrades, removeUpgrades, ...fields } = patch;
    let g = game.gears.find((x) => x.id === id);
    if (!g) {
      g = { upgrades: [], category: 'primary', grid: 'DefaultGridProfile', icon: null, ...fields, id } as Gear;
      game.gears.push(g);
    } else Object.assign(g, fields);
    if (addUpgrades) g.upgrades = [...g.upgrades, ...addUpgrades.filter((u) => !g!.upgrades.includes(u))];
    if (removeUpgrades) g.upgrades = g.upgrades.filter((u) => !removeUpgrades.includes(u));
  }
  for (const id of patches.remove?.upgrades ?? []) delete game.upgrades[id];
  if (patches.remove?.gears) game.gears = game.gears.filter((g) => !patches.remove!.gears!.includes(g.id));
  return game;
}

async function fetchJson<T>(url: string, optional: boolean): Promise<T | null> {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`${url}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export const DATA_BASE = `${import.meta.env.BASE_URL}data/`;

export async function loadData(): Promise<LoadedData> {
  const [game, patches, overrides, comments] = await Promise.all([
    fetchJson<GameData>(`${DATA_BASE}game.json`, false),
    fetchJson<DataPatches>(`${DATA_BASE}patches.json`, true),
    fetchJson<StatOverrides>(`${DATA_BASE}stats.overrides.json`, true),
    fetchJson<CommentsFile>(`${DATA_BASE}comments.json`, true),
  ]);
  const merged = normalizeIds(applyPatches(normalizeIds(game!), patches));
  const issues = validateGameData(merged);
  for (const i of issues) (i.level === 'error' ? console.error : console.warn)(`[data] ${i.where}: ${i.message}`);
  return { game: merged, overrides: overrides ?? { fields: {} }, comments: { upgrades: comments?.upgrades ?? {} }, issues };
}

export const iconUrl = (icon: string | null | undefined) => (icon ? `${DATA_BASE}icons/${icon}` : undefined);
