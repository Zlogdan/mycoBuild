import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { CommentsFile, UpgradeComment } from '../data/load';

/**
 * Local comment edits (browser only). The shared comments live in public/data/comments.json;
 * "Download comments.json" merges both so the file can be committed to the repository.
 */
interface CommentsState {
  local: Record<string, UpgradeComment | null>; // null = deleted locally
  setLocal: (id: string, c: UpgradeComment | null) => void;
  clearLocal: () => void;
}

export const useComments = create<CommentsState>()(
  persist(
    (set, get) => ({
      local: {},
      setLocal: (id, c) => set({ local: { ...get().local, [id]: c } }),
      clearLocal: () => set({ local: {} }),
    }),
    { name: 'mycobuild-comments-v1', storage: createJSONStorage(() => localStorage) },
  ),
);

export function effectiveComment(shared: CommentsFile, local: Record<string, UpgradeComment | null>, id: string): { comment: UpgradeComment | null; edited: boolean } {
  if (id in local) return { comment: local[id], edited: true };
  return { comment: shared.upgrades[id] ?? null, edited: false };
}

export function mergedComments(shared: CommentsFile, local: Record<string, UpgradeComment | null>): CommentsFile {
  const upgrades: Record<string, UpgradeComment> = { ...shared.upgrades };
  for (const [id, c] of Object.entries(local)) {
    if (c && c.text.trim()) upgrades[id] = { ...c, text: c.text.trim() };
    else delete upgrades[id];
  }
  const sorted = Object.fromEntries(Object.entries(upgrades).sort(([a], [b]) => a.localeCompare(b)));
  return { upgrades: sorted };
}
