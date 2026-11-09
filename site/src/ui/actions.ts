import { checkPlacement, upgradePattern, type BoardContext, type Placement } from '../core/placement';
import { canRotate, rotationUnlockLevel } from '../core/rules';
import { translate } from '../i18n';
import { useBuild } from '../store/build';

/**
 * Rotates the selected placement by one 60° step (game direction), keeping its first cell in place.
 * If that position is blocked, the next rotation steps are tried.
 */
export function rotateSelected(ctx: BoardContext, placements: readonly Placement[], dir: 1 | -1 = 1) {
  const b = useBuild.getState();
  const t = (k: Parameters<typeof translate>[1], p?: Record<string, string | number>) => translate(b.lang, k, p);
  const p = placements.find((x) => x.uid === b.selectedUid);
  if (!p) return;
  const u = ctx.getUpgrade(p.upgradeId);
  if (!u) return;
  if (!canRotate(u.rarity, ctx.accountLevel)) {
    b.notify(t('rotationLocked', { level: rotationUnlockLevel(u.rarity) }));
    return;
  }
  const cur = upgradePattern(u, p.rotation).cells[0];
  const abs = { q: p.anchor.q + cur.q, r: p.anchor.r + cur.r };
  for (let step = 1; step < 6; step++) {
    const rotation = (((p.rotation + dir * step) % 6) + 6) % 6;
    const nc = upgradePattern(u, rotation).cells[0];
    const cand = { ...p, rotation, anchor: { q: abs.q - nc.q, r: abs.r - nc.r } };
    if (checkPlacement(ctx, placements, cand).ok) {
      b.upsertPlacement(cand);
      return;
    }
  }
  b.notify(t('cantRotate', { reason: t('issue_overlap') }));
}

export function removeSelected() {
  const b = useBuild.getState();
  if (b.selectedUid) b.removePlacement(b.selectedUid);
}
