import type { GridSizeEntry, Rarity, Upgrade } from './types';

/**
 * Account (player) level at which rotating upgrades of each rarity unlocks.
 * Source: PlayerData.UpdateRarityRotations / PlayerData.CanRotateUpgrade (Assembly-CSharp):
 *   Standard >= 3, Rare >= 8, Epic >= 16, Exotic and above (index = min(rarity, 3)) >= 30.
 */
export const ROTATION_UNLOCK_LEVEL: Readonly<Record<number, number>> = { 0: 3, 1: 8, 2: 16, 3: 30 };

export function rotationUnlockLevel(rarity: Rarity): number {
  return ROTATION_UNLOCK_LEVEL[Math.min(rarity, 3)];
}

export function canRotate(rarity: Rarity, accountLevel: number): boolean {
  return accountLevel >= rotationUnlockLevel(rarity);
}

/** Allowed rotation indices (0..5). Mirroring does not exist in the game. */
export function allowedRotations(rarity: Rarity, accountLevel: number): number[] {
  return canRotate(rarity, accountLevel) ? [0, 1, 2, 3, 4, 5] : [0];
}

/** UpgradeFlags.CanStack: the upgrade may be placed on the same grid more than once ("Stackable"). */
export function isStackable(u: Upgrade): boolean {
  return u.flags.includes('CanStack');
}

/** UpgradeFlags.IsSpatial: the effect depends on neighbouring cells. */
export function isSpatial(u: Upgrade): boolean {
  return u.flags.includes('IsSpatial');
}

export function isGridExpander(u: Upgrade): boolean {
  return u.role === 'gridExpander';
}

/**
 * GridProfile.GetUpgradeGridSize: start with entry 0, then take the last entry whose level <= gear level.
 * The level is the level of the gear / character itself (GearData.Level), not the account level.
 */
export function gridSizeForLevel(profile: readonly GridSizeEntry[], gearLevel: number): { w: number; h: number } {
  if (!profile.length) return { w: 0, h: 0 };
  for (let i = profile.length - 1; i >= 1; i--) {
    if (profile[i].level <= gearLevel) return { w: profile[i].w, h: profile[i].h };
  }
  return { w: profile[0].w, h: profile[0].h };
}

/** Levels at which the grid grows (for UI hints). */
export function gridGrowthLevels(profile: readonly GridSizeEntry[]): number[] {
  return profile.map((p) => p.level);
}
