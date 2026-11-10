import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Gear, Lang, Upgrade } from '../core/types';
import type { LoadedData } from '../data/load';
import type { BoardContext, Placement } from '../core/placement';
import { gridSizeForLevel } from '../core/rules';

export const DEFAULT_ACCOUNT_LEVEL = 30;

/** Build slots of every gear, like in game: 0 = current (equipped), 1..3 = loadouts. */
export const SLOTS = [0, 1, 2, 3] as const;
export type Slot = (typeof SLOTS)[number];
/** Storage key of a slot. Slot 0 keeps the plain gear id (compatible with builds saved before slots existed). */
export const buildKey = (gearId: string, slot: number) => (slot ? `${gearId}#L${slot}` : gearId);
export const DEFAULT_GEAR_LEVEL = 10;

interface BuildState {
  data: LoadedData | null;
  loadError: string | null;

  lang: Lang;
  gearId: string | null;
  accountLevel: number;
  gearLevels: Record<string, number>;
  /** placements per slot key (buildKey), so switching gear / slot keeps each build */
  builds: Record<string, Placement[]>;
  /** active slot per gear id */
  slots: Record<string, number>;
  selectedUid: string | null;
  inspectedId: string | null;
  toast: { text: string; at: number } | null;

  setData: (d: LoadedData) => void;
  setLoadError: (e: string) => void;
  setLang: (l: Lang) => void;
  setGear: (id: string) => void;
  setAccountLevel: (n: number) => void;
  setGearLevel: (n: number) => void;
  upsertPlacement: (p: Placement) => void;
  removePlacement: (uid: string) => void;
  clearBuild: () => void;
  setPlacements: (list: Placement[]) => void;
  setSlot: (slot: number) => void;
  /** copy the active slot of the current gear into another slot */
  copySlotTo: (slot: number) => void;
  select: (uid: string | null) => void;
  inspect: (upgradeId: string | null) => void;
  notify: (text: string) => void;
}

const clampLevel = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.min(999, Math.round(n))) : 0);

export const useBuild = create<BuildState>()(
  persist(
    (set, get) => ({
      data: null,
      loadError: null,
      lang: 'ru',
      gearId: null,
      accountLevel: DEFAULT_ACCOUNT_LEVEL,
      gearLevels: {},
      builds: {},
      slots: {},
      selectedUid: null,
      inspectedId: null,
      toast: null,

      setData: (data) => {
        const ids = new Set(data.game.gears.map((g) => g.id));
        const cur = get().gearId;
        const first = data.game.gears.find((g) => g.category !== 'global');
        // builds saved by older versions may hold numeric upgrade ids
        const builds = Object.fromEntries(
          Object.entries(get().builds).map(([g, list]) => [g, list.map((p) => ({ ...p, upgradeId: String(p.upgradeId) }))]),
        );
        set({ data, builds, gearId: cur && ids.has(cur) ? cur : first?.id ?? null });
      },
      setLoadError: (loadError) => set({ loadError }),
      setLang: (lang) => set({ lang }),
      setGear: (gearId) => set({ gearId, selectedUid: null, inspectedId: null }),
      setAccountLevel: (n) => set({ accountLevel: Math.max(1, clampLevel(n)) }),
      setGearLevel: (n) => {
        const id = get().gearId;
        if (id) set({ gearLevels: { ...get().gearLevels, [id]: clampLevel(n) } });
      },
      upsertPlacement: (p) => {
        const id = activeKey(get());
        if (!id) return;
        const list = get().builds[id] ?? [];
        const i = list.findIndex((x) => x.uid === p.uid);
        const next = i >= 0 ? list.map((x) => (x.uid === p.uid ? p : x)) : [...list, p];
        set({ builds: { ...get().builds, [id]: next } });
      },
      removePlacement: (uid) => {
        const id = activeKey(get());
        if (!id) return;
        set({
          builds: { ...get().builds, [id]: (get().builds[id] ?? []).filter((x) => x.uid !== uid) },
          selectedUid: get().selectedUid === uid ? null : get().selectedUid,
        });
      },
      clearBuild: () => {
        const id = activeKey(get());
        if (id) set({ builds: { ...get().builds, [id]: [] }, selectedUid: null });
      },
      setPlacements: (list) => {
        const id = activeKey(get());
        if (id) set({ builds: { ...get().builds, [id]: list }, selectedUid: null });
      },
      setSlot: (slot) => {
        const g = get().gearId;
        if (g) set({ slots: { ...get().slots, [g]: slot }, selectedUid: null });
      },
      copySlotTo: (slot) => {
        const g = get().gearId;
        const from = activeKey(get());
        if (!g || !from) return;
        const list = (get().builds[from] ?? []).map((p) => ({ ...p, anchor: { ...p.anchor }, uid: newUid() }));
        set({ builds: { ...get().builds, [buildKey(g, slot)]: list } });
      },
      select: (selectedUid) => set({ selectedUid }),
      inspect: (inspectedId) => set({ inspectedId }),
      notify: (text) => set({ toast: { text, at: Date.now() } }),
    }),
    {
      name: 'mycobuild-v1',
      storage: createJSONStorage(() => {
        try {
          return localStorage;
        } catch {
          return sessionStorage;
        }
      }),
      partialize: (s) => ({
        lang: s.lang,
        gearId: s.gearId,
        accountLevel: s.accountLevel,
        gearLevels: s.gearLevels,
        builds: s.builds,
        slots: s.slots,
      }),
    },
  ),
);

/** Storage key of the active slot of the current gear. */
export function activeKey(s: Pick<BuildState, 'gearId' | 'slots'>): string | null {
  return s.gearId ? buildKey(s.gearId, s.slots[s.gearId] ?? 0) : null;
}

let uidCounter = 0;
export const newUid = () => `u${Date.now().toString(36)}${(uidCounter++).toString(36)}`;

/* ---------- selectors ---------- */

export function useCurrentGear(): Gear | null {
  return useBuild((s) => s.data?.game.gears.find((g) => g.id === s.gearId) ?? null);
}

const EMPTY: Placement[] = [];
export function usePlacements(): Placement[] {
  return useBuild((s) => {
    const k = activeKey(s);
    return k ? s.builds[k] ?? EMPTY : EMPTY;
  });
}

export function useSlot(): number {
  return useBuild((s) => (s.gearId ? s.slots[s.gearId] ?? 0 : 0));
}

export function useGearLevel(): number {
  return useBuild((s) => (s.gearId ? s.gearLevels[s.gearId] ?? DEFAULT_GEAR_LEVEL : DEFAULT_GEAR_LEVEL));
}

/**
 * Upgrades available for a gear: its own list; characters additionally get the shared "player" pool
 * (GearData.CanEquipUpgrade allows Global upgrades on characters). Grid expanders are not listed in any
 * GearInfo, so they are offered for every gear with a grid. Innate abilities are excluded.
 */
export function upgradePool(data: LoadedData, gear: Gear): { own: Upgrade[]; common: Upgrade[]; expanders: Upgrade[] } {
  const U = data.game.upgrades;
  const pick = (ids: string[]) => ids.map((id) => U[id]).filter((u): u is Upgrade => !!u && u.role === 'normal');
  const own = pick(gear.upgrades);
  const global = gear.category === 'character' ? data.game.gears.find((g) => g.category === 'global') : undefined;
  const ownIds = new Set(own.map((u) => u.id));
  const common = global ? pick(global.upgrades).filter((u) => !ownIds.has(u.id)) : [];
  const expanders = Object.values(U).filter((u) => u.role === 'gridExpander');
  return { own, common, expanders };
}

export function boardContext(data: LoadedData, gear: Gear, accountLevel: number, gearLevel: number): BoardContext {
  const pool = upgradePool(data, gear);
  const ids = new Set([...pool.own, ...pool.common, ...pool.expanders].map((u) => u.id));
  return {
    getUpgrade: (id) => data.game.upgrades[id],
    pool: ids,
    accountLevel,
    baseSize: gridSizeForLevel(data.game.gridProfiles[gear.grid] ?? [], gearLevel),
  };
}
