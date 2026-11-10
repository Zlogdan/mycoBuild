import { useBuild } from '../store/build';

const FALLBACK = ['#3CF673', '#58CBFF', '#F164FF', '#FFAD3B', '#FF3134', '#734CFF'];

const ELEMENT_FALLBACK: Record<string, string> = {
  normal: '#C8D0CC',
  fire: '#FF642A',
  shock: '#6BD7FF',
  acid: '#91E915',
  cryo: '#6B89FF',
  bees: '#FFD23F',
  decay: '#D78FFF',
  rot: '#A4B020',
  water: '#8CAFFF',
};

/** Element colour from the game's keyword table (TextBlocks "keyword:1,color:…"), with fallbacks. */
export function elementColor(key: string): string {
  const kw = useBuild.getState().data?.game.keywords.find((k) => k.key === key);
  return kw?.color ?? ELEMENT_FALLBACK[key] ?? '#aaa';
}

/** Rarity colour from game.json (rarities[].color), fallback = Global.Rarities values of game build 2026-11. */
export function rarityColor(rarity: number): string {
  const r = useBuild.getState().data?.game.rarities.find((x) => x.id === rarity);
  return r?.color ?? FALLBACK[rarity] ?? '#aaa';
}
