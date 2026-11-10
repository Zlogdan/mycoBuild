import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { AutofillEntry, InfuserOptions } from '../core/solver/prepare';
import type { SolveProgress, SolveResult } from '../core/solver/solve';
import type { Placement } from '../core/placement';

export const DEFAULT_WEIGHT = 5;

export interface AutofillOptions {
  keepPlaced: boolean;
  timeLimitMs: number;
  topK: number;
  infuser: InfuserOptions;
}

interface AutofillState {
  /** selection with weights, per gear id */
  selections: Record<string, AutofillEntry[]>;
  options: AutofillOptions;

  status: 'idle' | 'running' | 'done' | 'error';
  error: string | null;
  progress: SolveProgress | null;
  result: SolveResult | null;
  /** placements of each variant, ready for preview / apply */
  variants: Placement[][];
  /** fingerprint of the inputs the result was computed for (to detect stale results) */
  resultKey: string | null;
  /** variant shown on the board instead of the build, or null */
  preview: number | null;
  cancel: (() => void) | null;

  toggle: (gearId: string, upgradeId: string) => void;
  setEntry: (gearId: string, upgradeId: string, patch: Partial<AutofillEntry>) => void;
  clearSelection: (gearId: string) => void;
  setOptions: (o: Partial<AutofillOptions>) => void;
  setPreview: (i: number | null) => void;
}

export const useAutofill = create<AutofillState>()(
  persist(
    (set, get) => ({
      selections: {},
      options: { keepPlaced: false, timeLimitMs: 3000, topK: 5, infuser: { enabled: false, neutralOnly: true, forceShrink: false } },
      status: 'idle',
      error: null,
      progress: null,
      result: null,
      variants: [],
      resultKey: null,
      preview: null,
      cancel: null,

      toggle: (gearId, upgradeId) => {
        const list = get().selections[gearId] ?? [];
        const next = list.some((e) => e.upgradeId === upgradeId)
          ? list.filter((e) => e.upgradeId !== upgradeId)
          : [...list, { upgradeId, weight: DEFAULT_WEIGHT, count: 1 }];
        set({ selections: { ...get().selections, [gearId]: next } });
      },
      setEntry: (gearId, upgradeId, patch) => {
        const list = get().selections[gearId] ?? [];
        set({
          selections: { ...get().selections, [gearId]: list.map((e) => (e.upgradeId === upgradeId ? { ...e, ...patch } : e)) },
        });
      },
      clearSelection: (gearId) => set({ selections: { ...get().selections, [gearId]: [] } }),
      setOptions: (o) => set({ options: { ...get().options, ...o } }),
      setPreview: (preview) => set({ preview }),
    }),
    {
      name: 'mycobuild-autofill-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({ selections: s.selections, options: s.options }),
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<AutofillState>;
        const selections = Object.fromEntries(
          Object.entries(p.selections ?? {}).map(([g, list]) => [g, list.map((e) => ({ ...e, upgradeId: String(e.upgradeId) }))]),
        );
        const options = { ...current.options, ...(p.options ?? {}) };
        options.infuser = { ...current.options.infuser, ...(p.options?.infuser ?? {}) };
        return { ...current, ...p, selections, options };
      },
    },
  ),
);
