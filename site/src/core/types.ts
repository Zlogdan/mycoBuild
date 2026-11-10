/** Game data model (mirrors public/data/game.json produced by extractor/extract.py). */

export type Lang = 'en' | 'ru';
export type Loc = Partial<Record<Lang, string>>;

/** enum Rarity: Standard, Rare, Epic, Exotic, Oddity, Contraband */
export type Rarity = 0 | 1 | 2 | 3 | 4 | 5;

export type GearCategory = 'character' | 'primary' | 'heavy' | 'throwable' | 'special' | 'global';
export type UpgradeRole = 'normal' | 'gridExpander' | 'ability';

/** Raw pattern as stored by the game: offset (odd-q) cells inside a w×h box. [x, y, connectionBits] */
export interface RawPattern {
  w: number;
  h: number;
  cells: [number, number, number][];
}

export interface UpgradeProp {
  type: string;
  data: Record<string, unknown>;
}

export interface Upgrade {
  id: string;
  key: string;
  asset?: string;
  class: string;
  name: Loc;
  desc: Loc | null;
  rarity: Rarity;
  flags: string[];
  effect: string;
  source: string;
  icon: string | null;
  role: UpgradeRole;
  pattern: RawPattern;
  altPatterns?: RawPattern[];
  props: UpgradeProp[];
  gears: string[];
  /** element rolled per instance (UpgradeProperty.GetRandomEffect*): possible EffectType keys */
  elementChoice?: string[];
  /** how the game rolls the element from the instance seed: property index (0-based), GetRandomEffect* variant,
   *  its count argument, and the number of Random draws made before it in the same property */
  elementRoll?: { prop: number; func: string; count: number | null; draws: number };
  /** how the upgrade is obtained (composed like Upgrade.GetCollectionSource in game) */
  sourceInfo?: { kind: string; text: Loc | null; from?: Loc | null; after?: string };
}

export interface Gear {
  id: string;
  key: string;
  asset?: string;
  category: GearCategory;
  name: Loc;
  icon: string | null;
  grid: string;
  color?: string | null;
  ability?: string | null;
  upgrades: string[];
}

export interface GridSizeEntry {
  level: number;
  w: number;
  h: number;
}

export interface RarityInfo {
  id: Rarity;
  key: string;
  color: string;
  name: Loc;
}

export interface Keyword {
  key: string;
  color: string | null;
  words: Partial<Record<Lang, string[]>>;
}

export interface StatLabel {
  key: string | null;
  label: Loc | null;
  /** StatData.WithMultiplier was applied: only adds a stacking note in game, does NOT change the format */
  multiplier: boolean;
  /** StatData.CreateInverse: the value is shown inverted (e.g. fire interval -> fire rate) */
  inverse: boolean;
  patternScaled: boolean;
  /** OverrideType passed explicitly to StatData.Create (1 Add, 2 Multiply, 3 Override); null = from OverrideData.method */
  overrideType?: number | null;
  /** C# number format passed to StatData.Create (e.g. "0.0%") */
  format?: string | null;
}

export interface StatOverride {
  en?: string;
  ru?: string;
  format?: '' | 'percent' | 'multiplier' | 'seconds' | 'number' | 'hidden';
}

export interface GameData {
  meta: {
    game: string;
    appInfo: string | null;
    unity: string;
    extractedAt: string;
    langs: Lang[];
  };
  rarities: RarityInfo[];
  effects: Record<string, Loc>;
  keywords: Keyword[];
  gridProfiles: Record<string, GridSizeEntry[]>;
  gears: Gear[];
  upgrades: Record<string, Upgrade>;
  statLabels: Record<string, StatLabel>;
}
