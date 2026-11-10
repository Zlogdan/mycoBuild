/**
 * Build file format (JSON), versioned from schemaVersion 1.
 *
 * Positions are stored like the game stores grids: offset (odd-q) coordinates `x`, `y` of the anchor
 * (local origin of the rotated, normalised pattern) + `rotation` 0..5 (60° steps, game direction).
 * Every upgrade reference carries both `upgradeId` and `key`: ids are the game's numeric ids; if a game
 * update changes an id, the upgrade is still found by its key.
 */
import type { GameData, Gear, Upgrade } from './types';
import { axialToOffset, offsetToAxial } from './hex';
import { canInfuse, evaluate, type BoardContext, type ExpandDirection, type Placement } from './placement';
import type { AutofillEntry, InfuserOptions } from './solver/prepare';

export const SCHEMA_VERSION = 1;
export const APP_ID = 'mycobuild';

export interface BuildFileV1 {
  schemaVersion: 1;
  app: typeof APP_ID;
  createdAt?: string;
  gameData?: { extractedAt?: string; appInfo?: string | null };
  gear: { id: string; key: string };
  levels: { account: number; gear: number };
  /** informational: grid size the build was made for (recomputed on import) */
  grid?: { base: { w: number; h: number }; size: { w: number; h: number }; expanders: { upgradeId: string; direction: ExpandDirection }[] };
  placed: {
    upgradeId: string;
    key: string;
    x: number;
    y: number;
    rotation: number;
    expand?: ExpandDirection;
    /** element of an upgrade with a per-instance element (Upgrade.elementChoice) */
    element?: string;
    /** Pattern Infuser: upgrade whose pattern this instance uses */
    patternFrom?: string;
  }[];
  autofill?: {
    selection: { upgradeId: string; key: string; weight: number; count: number }[];
    options?: { keepPlaced?: boolean; timeLimitMs?: number; topK?: number; infuser?: InfuserOptions };
  };
}

export interface BuildSnapshot {
  gear: Gear;
  accountLevel: number;
  gearLevel: number;
  placements: Placement[];
  autofill: AutofillEntry[];
  autofillOptions?: { keepPlaced: boolean; timeLimitMs: number; topK: number; infuser?: InfuserOptions };
}

/* ---------------- export ---------------- */

export function exportBuild(data: GameData, ctx: BoardContext, snap: BuildSnapshot): BuildFileV1 {
  const U = data.upgrades;
  const state = evaluate(ctx, snap.placements);
  return {
    schemaVersion: SCHEMA_VERSION,
    app: APP_ID,
    createdAt: new Date().toISOString(),
    gameData: { extractedAt: data.meta.extractedAt, appInfo: data.meta.appInfo },
    gear: { id: snap.gear.id, key: snap.gear.key },
    levels: { account: snap.accountLevel, gear: snap.gearLevel },
    grid: {
      base: { ...ctx.baseSize },
      size: { ...state.size },
      expanders: snap.placements
        .filter((p) => state.activeExpanders.includes(p.uid))
        .map((p) => ({ upgradeId: p.upgradeId, direction: p.expand ?? 'column' })),
    },
    placed: snap.placements.map((p) => {
      const o = axialToOffset(p.anchor.q, p.anchor.r);
      return {
        upgradeId: p.upgradeId,
        key: U[p.upgradeId]?.key ?? '',
        x: o.x,
        y: o.y,
        rotation: p.rotation,
        ...(p.expand ? { expand: p.expand } : {}),
        ...(p.element ? { element: p.element } : {}),
        ...(p.patternFrom ? { patternFrom: p.patternFrom } : {}),
      };
    }),
    autofill: {
      selection: snap.autofill.map((e) => ({ upgradeId: e.upgradeId, key: U[e.upgradeId]?.key ?? '', weight: e.weight, count: e.count })),
      ...(snap.autofillOptions ? { options: snap.autofillOptions } : {}),
    },
  };
}

/* ---------------- import ---------------- */

export type ImportMessageCode =
  | 'invalidJson'
  | 'notObject'
  | 'wrongApp'
  | 'noVersion'
  | 'newerVersion'
  | 'badField'
  | 'unknownGear'
  | 'unknownUpgrade'
  | 'upgradeByKey'
  | 'notInPool'
  | 'placementIssue'
  | 'otherGameData'
  | 'badElement'
  | 'badInfusion';

export interface ImportMessage {
  level: 'error' | 'warning';
  code: ImportMessageCode;
  /** values for the message template */
  params?: Record<string, string | number>;
}

export interface ImportResult {
  ok: boolean;
  build?: Omit<BuildSnapshot, 'autofillOptions'> & { autofillOptions?: Partial<NonNullable<BuildSnapshot['autofillOptions']>> };
  messages: ImportMessage[];
}

/** Upgrades from older schema versions are migrated here (v1 is the first version). */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

export interface ImportContext {
  data: GameData;
  /** builds the board context of a gear for the imported levels (pool, base size, account level) */
  boardContext: (gear: Gear, accountLevel: number, gearLevel: number) => BoardContext;
  newUid: () => string;
}

export function importBuild(input: string | unknown, ictx: ImportContext): ImportResult {
  const messages: ImportMessage[] = [];
  const fail = (code: ImportMessageCode, params?: ImportMessage['params']): ImportResult => ({
    ok: false,
    messages: [...messages, { level: 'error', code, params }],
  });

  let doc: unknown = input;
  if (typeof input === 'string') {
    try {
      doc = JSON.parse(input);
    } catch (e) {
      return fail('invalidJson', { detail: (e as Error).message });
    }
  }
  if (!isObj(doc)) return fail('notObject');
  if (doc.app !== undefined && doc.app !== APP_ID) return fail('wrongApp', { app: String(doc.app) });
  if (!isInt(doc.schemaVersion)) return fail('noVersion');
  if (doc.schemaVersion > SCHEMA_VERSION) return fail('newerVersion', { version: doc.schemaVersion, supported: SCHEMA_VERSION });
  let v = doc.schemaVersion;
  while (v < SCHEMA_VERSION) {
    const m = MIGRATIONS[v];
    if (!m) return fail('noVersion');
    doc = m(doc as Record<string, unknown>);
    v++;
  }
  const d = doc as Record<string, unknown>;

  // ---- structure ----
  if (!isObj(d.gear) || typeof d.gear.id !== 'string' || typeof d.gear.key !== 'string') return fail('badField', { field: 'gear' });
  if (!isObj(d.levels) || !isInt(d.levels.account) || !isInt(d.levels.gear) || d.levels.account < 1 || d.levels.gear < 0)
    return fail('badField', { field: 'levels' });
  if (!Array.isArray(d.placed)) return fail('badField', { field: 'placed' });
  for (const [i, p] of d.placed.entries()) {
    if (
      !isObj(p) ||
      typeof p.upgradeId !== 'string' ||
      !isInt(p.x) ||
      !isInt(p.y) ||
      !isInt(p.rotation) ||
      p.rotation < 0 ||
      p.rotation > 5 ||
      (p.expand !== undefined && p.expand !== 'column' && p.expand !== 'row') ||
      (p.element !== undefined && typeof p.element !== 'string') ||
      (p.patternFrom !== undefined && typeof p.patternFrom !== 'string')
    )
      return fail('badField', { field: `placed[${i}]` });
  }
  const { data } = ictx;
  const meta = isObj(d.gameData) ? d.gameData : null;
  if (meta?.extractedAt && meta.extractedAt !== data.meta.extractedAt)
    messages.push({ level: 'warning', code: 'otherGameData', params: { date: String(meta.extractedAt).slice(0, 10) } });

  // ---- gear ----
  const gearRef = d.gear as { id: string; key: string };
  const gear = data.gears.find((g) => g.id === gearRef.id) ?? data.gears.find((g) => g.key === gearRef.key);
  if (!gear) return fail('unknownGear', { gear: gearRef.key || gearRef.id });
  const levels = d.levels as { account: number; gear: number };
  const ctx = ictx.boardContext(gear, levels.account, levels.gear);

  const resolve = (ref: { upgradeId: string; key?: unknown }, where: string): Upgrade | undefined => {
    const byId = data.upgrades[ref.upgradeId];
    if (byId && (typeof ref.key !== 'string' || !ref.key || byId.key === ref.key)) return byId;
    const key = typeof ref.key === 'string' ? ref.key : '';
    const candidates = key ? Object.values(data.upgrades).filter((u) => u.key === key) : [];
    const byKey = candidates.find((u) => ctx.pool?.has(u.id)) ?? candidates[0];
    if (byKey) {
      messages.push({ level: 'warning', code: 'upgradeByKey', params: { key: byKey.key, id: ref.upgradeId, newId: byKey.id } });
      return byKey;
    }
    messages.push({ level: 'warning', code: 'unknownUpgrade', params: { ref: key || ref.upgradeId, where } });
    return undefined;
  };

  // ---- placements ----
  const placements: Placement[] = [];
  for (const raw of d.placed as BuildFileV1['placed']) {
    const u = resolve(raw, 'placed');
    if (!u) continue;
    if (raw.element && !u.elementChoice?.includes(raw.element))
      messages.push({ level: 'warning', code: 'badElement', params: { key: u.key, id: u.id, element: raw.element } });
    if (ctx.pool && !ctx.pool.has(u.id)) messages.push({ level: 'warning', code: 'notInPool', params: { key: u.key, id: u.id } });
    const donor = raw.patternFrom ? data.upgrades[raw.patternFrom] : undefined;
    const infused = donor && canInfuse(u, donor) ? donor.id : undefined;
    if (raw.patternFrom && !infused)
      messages.push({ level: 'warning', code: 'badInfusion', params: { key: u.key, id: u.id, donor: donor?.key ?? raw.patternFrom } });
    placements.push({
      uid: ictx.newUid(),
      upgradeId: u.id,
      rotation: raw.rotation,
      anchor: offsetToAxial(raw.x, raw.y),
      ...(raw.expand ? { expand: raw.expand } : {}),
      ...(raw.element && u.elementChoice?.includes(raw.element) ? { element: raw.element } : {}),
      ...(infused ? { patternFrom: infused } : {}),
    });
  }
  // the build is restored exactly; rule violations are reported (and shown on the board), not "fixed"
  const state = evaluate(ctx, placements);
  for (const [uid, issues] of state.issues) {
    const p = placements.find((x) => x.uid === uid)!;
    for (const i of issues)
      messages.push({
        level: 'warning',
        code: 'placementIssue',
        params: { key: data.upgrades[p.upgradeId]?.key ?? p.upgradeId, id: p.upgradeId, issue: i.code, ...(i.level ? { level: i.level } : {}) },
      });
  }

  // ---- auto-fill selection ----
  const autofill: AutofillEntry[] = [];
  let autofillOptions: NonNullable<ImportResult['build']>['autofillOptions'];
  if (isObj(d.autofill)) {
    if (Array.isArray(d.autofill.selection))
      for (const e of d.autofill.selection) {
        if (!isObj(e) || typeof e.upgradeId !== 'string' || typeof e.weight !== 'number' || typeof e.count !== 'number') continue;
        const u = resolve(e as { upgradeId: string; key?: unknown }, 'autofill');
        if (u && !autofill.some((a) => a.upgradeId === u.id))
          autofill.push({ upgradeId: u.id, weight: Math.max(1, Math.round(e.weight)), count: Math.max(1, Math.round(e.count)) });
      }
    if (isObj(d.autofill.options)) {
      const o = d.autofill.options;
      autofillOptions = {
        ...(typeof o.keepPlaced === 'boolean' ? { keepPlaced: o.keepPlaced } : {}),
        ...(isInt(o.timeLimitMs) && o.timeLimitMs > 0 ? { timeLimitMs: o.timeLimitMs } : {}),
        ...(isInt(o.topK) && o.topK > 0 ? { topK: o.topK } : {}),
        ...(isObj(o.infuser)
          ? {
              infuser: {
                enabled: o.infuser.enabled === true,
                neutralOnly: o.infuser.neutralOnly !== false,
                forceShrink: o.infuser.forceShrink === true,
              },
            }
          : {}),
      };
    }
  }

  return {
    ok: true,
    messages,
    build: { gear, accountLevel: levels.account, gearLevel: levels.gear, placements, autofill, autofillOptions },
  };
}

/* ---------------- share links ---------------- */

const LINK_PREFIX = 'b1.'; // deflate-raw + base64url
const LINK_PREFIX_RAW = 'j1.'; // plain base64url JSON (no CompressionStream available)

function toBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromBase64Url(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
  return out;
}
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const res = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

/** Encodes a build file into a compact URL-safe token (for `#b=<token>`). */
export async function encodeBuildLink(file: BuildFileV1): Promise<string> {
  // drop informational/redundant fields to keep links short
  const compact = { ...file, createdAt: undefined, grid: undefined, gameData: { extractedAt: file.gameData?.extractedAt } };
  const json = new TextEncoder().encode(JSON.stringify(compact));
  if (typeof CompressionStream === 'undefined') return LINK_PREFIX_RAW + toBase64Url(json);
  return LINK_PREFIX + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

/** Decodes a token produced by encodeBuildLink back to the JSON text (validated later by importBuild). */
export async function decodeBuildLink(token: string): Promise<string> {
  if (token.startsWith(LINK_PREFIX_RAW)) return new TextDecoder().decode(fromBase64Url(token.slice(LINK_PREFIX_RAW.length)));
  if (!token.startsWith(LINK_PREFIX)) throw new Error('unknown link format');
  const bytes = await pipe(fromBase64Url(token.slice(LINK_PREFIX.length)), new DecompressionStream('deflate-raw'));
  return new TextDecoder().decode(bytes);
}
