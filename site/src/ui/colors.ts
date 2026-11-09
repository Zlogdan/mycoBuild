import { useBuild } from '../store/build';

const FALLBACK = ['#3CF673', '#58CBFF', '#F164FF', '#FFAD3B', '#FF3134', '#734CFF'];

/** Rarity colour from game.json (rarities[].color), fallback = Global.Rarities values of game build 2026-11. */
export function rarityColor(rarity: number): string {
  const r = useBuild.getState().data?.game.rarities.find((x) => x.id === rarity);
  return r?.color ?? FALLBACK[rarity] ?? '#aaa';
}
