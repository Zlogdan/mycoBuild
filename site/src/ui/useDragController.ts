import { useEffect } from 'react';
import { useDrag } from '../store/drag';
import { useBuild, usePlacements } from '../store/build';
import { canRotate, rotationUnlockLevel } from '../core/rules';
import { useBoardContext, useT } from './hooks';
import { removeSelected, rotateSelected } from './actions';

/**
 * Global pointer / keyboard handling for drag & drop and for the selected placement.
 * Pointer Events (not HTML5 DnD) so the shape can be rotated while dragging and touch can be added later.
 */
export function useDragController() {
  const ctx = useBoardContext();
  const placements = usePlacements();
  const { t } = useT();

  useEffect(() => {
    const drag = useDrag.getState;
    const build = useBuild.getState;

    const tryRotateDrag = (dir: 1 | -1) => {
      const d = drag();
      if (!d.active || !d.upgradeId || !ctx) return;
      const u = ctx.getUpgrade(d.upgradeId);
      if (!u) return;
      if (!canRotate(u.rarity, ctx.accountLevel)) {
        build().notify(t('rotationLocked', { level: rotationUnlockLevel(u.rarity) }));
        return;
      }
      d.setRotation(d.rotation + dir);
    };

    const onMove = (e: PointerEvent) => {
      const d = drag();
      if (d.pending || d.active) d.move(e.clientX, e.clientY);
    };

    const onUp = () => {
      const d = drag();
      if (d.pending) {
        d.end();
        return;
      }
      if (!d.active || !d.upgradeId || !d.uid) return;
      const target = d.target;
      if (target?.ok) {
        build().upsertPlacement({
          uid: d.uid,
          upgradeId: d.upgradeId,
          rotation: d.rotation,
          anchor: target.anchor,
          expand: d.expand,
        });
        build().select(d.uid);
        build().inspect(d.upgradeId);
      } else if (!target && !d.isNew) {
        // dropped outside the board -> remove
        build().removePlacement(d.uid);
      }
      d.end();
    };

    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      const d = drag();
      if (e.key === 'Escape') {
        if (d.active || d.pending) d.end();
        else build().select(null);
      } else if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') {
        if (d.active) tryRotateDrag(e.shiftKey ? -1 : 1);
        else if (ctx) rotateSelected(ctx, placements, e.shiftKey ? -1 : 1);
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && !d.active) {
        removeSelected();
      }
    };

    const onWheel = (e: WheelEvent) => {
      if (!drag().active) return;
      e.preventDefault();
      tryRotateDrag(e.deltaY > 0 ? 1 : -1);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
    };
  }, [ctx, placements, t]);
}
