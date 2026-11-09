import { useEffect, useMemo, useRef } from 'react';
import { axialKey, axialToOffset, axialToPixel, directionVector, hexPolygon, neighbors, offsetToAxial, pixelToAxial, SQRT3 } from '../core/hex';
import { checkPlacement, evaluate, inBounds, upgradePattern, validGrabPositions, type Placement } from '../core/placement';
import { isGridExpander, isSpatial } from '../core/rules';
import { iconCellIndex, patternLinks } from '../core/pattern';
import { iconUrl } from '../data/load';
import { useBuild, usePlacements } from '../store/build';
import { useDrag } from '../store/drag';
import { useAutofill } from '../store/autofill';
import { applyVariant } from './autofillActions';
import { rarityColor } from './colors';
import { useBoardContext, useT } from './hooks';

const S = 34; // hex radius
const PAD = 14;
const APO = (SQRT3 / 2) * S;
/** visible hex of an upgrade cell relative to the board cell (game look: smaller filled hex inside the frame) */
const MOD_HEX = 0.66;
/** icon size relative to S */
const ICON = 0.78;

export function HexBoard() {
  const ctx = useBoardContext();
  const buildPlacements = usePlacements();
  // auto-fill preview: show a variant instead of the build (read-only)
  const previewIdx = useAutofill((s) => s.preview);
  const previewPlacements = useAutofill((s) => (s.preview !== null ? s.variants[s.preview] : undefined));
  const readOnly = !!previewPlacements;
  const placements = previewPlacements ?? buildPlacements;
  const selectedUid = useBuild((s) => s.selectedUid);
  const select = useBuild((s) => s.select);
  const inspect = useBuild((s) => s.inspect);
  const drag = useDrag();
  const svgRef = useRef<SVGSVGElement>(null);
  const { t } = useT();

  const state = useMemo(() => (ctx ? evaluate(ctx, placements) : null), [ctx, placements]);
  const size = state?.size ?? { w: 0, h: 0 };
  // While dragging an expander the board may grow, so reserve one extra column/row of space.
  const view = { w: size.w + 1, h: size.h + 1 };
  const width = PAD * 2 + S * 2 + 1.5 * S * (view.w - 1);
  const height = PAD * 2 + SQRT3 * S * (view.h + 0.5);

  const dragUpgrade = drag.upgradeId && ctx ? ctx.getUpgrade(drag.upgradeId) : undefined;

  // pointer -> target anchor
  useEffect(() => {
    if (!drag.active || !ctx || !svgRef.current || !dragUpgrade || !drag.uid) return;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const margin = S;
    if (drag.x < rect.left - margin || drag.x > rect.right + margin || drag.y < rect.top - margin || drag.y > rect.bottom + margin) {
      if (useDrag.getState().target) useDrag.getState().setTarget(null);
      return;
    }
    const pt = svg.createSVGPoint();
    pt.x = drag.x;
    pt.y = drag.y;
    const m = svg.getScreenCTM();
    if (!m) return;
    const local = pt.matrixTransform(m.inverse());
    const cell = pixelToAxial(local.x - PAD, local.y - PAD, S);
    const pat = upgradePattern(dragUpgrade, drag.rotation);
    const grab = pat.cells[Math.min(drag.grabIndex, pat.cells.length - 1)];
    const anchor = { q: cell.q - grab.q, r: cell.r - grab.r };
    const res = checkPlacement(ctx, placements, {
      uid: drag.uid,
      upgradeId: dragUpgrade.id,
      rotation: drag.rotation,
      anchor,
      expand: drag.expand,
    });
    useDrag.getState().setTarget({ anchor, ok: res.ok, issues: res.issues });
  }, [drag.active, drag.x, drag.y, drag.rotation, drag.grabIndex, drag.uid, drag.expand, ctx, placements, dragUpgrade]);

  // available positions for the dragged shape (keyed by the grabbed cell)
  const available = useMemo(() => {
    if (!drag.active || !ctx || !dragUpgrade || !drag.uid) return [];
    return validGrabPositions(
      ctx,
      placements,
      { uid: drag.uid, upgradeId: dragUpgrade.id, rotation: drag.rotation, expand: drag.expand },
      drag.grabIndex,
      view,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag.active, drag.uid, drag.rotation, drag.grabIndex, drag.expand, ctx, placements, dragUpgrade, view.w, view.h]);

  if (!ctx || !state) return null;

  const px = (q: number, r: number) => {
    const p = axialToPixel(q, r, S);
    return { x: p.px + PAD, y: p.py + PAD };
  };

  const base = ctx.baseSize;
  const boardCells: { x: number; y: number; added: boolean }[] = [];
  for (let x = 0; x < size.w; x++)
    for (let y = 0; y < size.h; y++) boardCells.push({ x, y, added: x >= base.w || y >= base.h });

  const selected = placements.find((p) => p.uid === selectedUid);
  const selectedUp = selected ? ctx.getUpgrade(selected.upgradeId) : undefined;
  const spatialRing = new Set<string>();
  if (selected && selectedUp && isSpatial(selectedUp)) {
    const own = new Set((state.cells.get(selected.uid) ?? []).map(axialKey));
    for (const c of state.cells.get(selected.uid) ?? [])
      for (const n of neighbors(c)) if (!own.has(axialKey(n)) && inBounds(n, size)) spatialRing.add(axialKey(n));
  }

  const startMove = (e: React.PointerEvent, p: Placement, cellIndex: number) => {
    if (e.button !== 0) return;
    if (readOnly) {
      inspect(p.upgradeId);
      return;
    }
    e.preventDefault();
    select(p.uid);
    inspect(p.upgradeId);
    useDrag.getState().begin({
      upgradeId: p.upgradeId,
      uid: p.uid,
      isNew: false,
      rotation: p.rotation,
      grabIndex: cellIndex,
      expand: p.expand,
      x: e.clientX,
      y: e.clientY,
    });
  };

  const freeCount = boardCells.length - boardCells.filter((c) => state.occupancy.has(axialKey(offsetToAxial(c.x, c.y)))).length;
  const target = drag.active ? drag.target : null;
  const targetCells =
    target && dragUpgrade ? upgradePattern(dragUpgrade, drag.rotation).cells.map((c) => ({ q: c.q + target.anchor.q, r: c.r + target.anchor.r })) : [];
  const issueText = target && !target.ok && target.issues[0] ? t(`issue_${target.issues[0].code}`, { level: target.issues[0].level ?? '' }) : '';

  return (
    <div className={`board-wrap ${readOnly ? 'previewing' : ''}`}>
      {readOnly && previewIdx !== null && (
        <div className="preview-bar">
          <span>{t('afPreview', { n: previewIdx + 1 })}</span>
          <button className="primary" onClick={() => applyVariant(previewIdx)}>
            {t('afApply')}
          </button>
          <button onClick={() => useAutofill.getState().setPreview(null)}>{t('afClose')}</button>
        </div>
      )}
      <svg
        ref={svgRef}
        className={`board ${drag.active ? 'dragging' : ''}`}
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        onPointerDown={(e) => {
          if (e.target === svgRef.current) select(null);
        }}
      >
        <defs>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge>
              <feMergeNode in="b" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill="rgba(0,0,0,0.35)" />
            <line x1="0" y1="0" x2="0" y2="6" stroke="rgba(255,255,255,0.55)" strokeWidth="2" />
          </pattern>
        </defs>

        {/* board cells */}
        {boardCells.map(({ x, y, added }) => {
          const a = offsetToAxial(x, y);
          const { x: cx, y: cy } = px(a.q, a.r);
          const occupied = state.occupancy.has(axialKey(a));
          return (
            <polygon
              key={`c${x},${y}`}
              className={`cell ${occupied ? 'occupied' : 'free'} ${added ? 'added' : ''}`}
              points={hexPolygon(cx, cy, S * 0.96)}
            />
          );
        })}

        {/* available positions */}
        {available.map((a) => {
          const { x, y } = px(a.q, a.r);
          return <circle key={`a${a.q},${a.r}`} className="avail" cx={x} cy={y} r={4} />;
        })}

        {/* spatial neighbours of the selected upgrade */}
        {[...spatialRing].map((k) => {
          const [q, r] = k.split(',').map(Number);
          const { x, y } = px(q, r);
          return <polygon key={`s${k}`} className="spatial-ring" points={hexPolygon(x, y, S * 0.8)} />;
        })}

        {/* placed upgrades */}
        {placements.map((p) => {
          const u = ctx.getUpgrade(p.upgradeId);
          const cells = state.cells.get(p.uid);
          if (!u || !cells) return null;
          const pat = upgradePattern(u, p.rotation);
          const color = rarityColor(u.rarity);
          const bad = (state.issues.get(p.uid)?.length ?? 0) > 0;
          const moving = drag.active && drag.uid === p.uid;
          const centers = cells.map((c) => px(c.q, c.r));
          const { x: cx, y: cy } = centers[iconCellIndex(pat)];
          const icon = iconUrl(u.icon);
          const isSel = p.uid === selectedUid;
          return (
            <g
              key={p.uid}
              className={`placed ${bad ? 'bad' : ''} ${isSel ? 'selected' : ''} ${moving ? 'moving' : ''}`}
              style={{ ['--rc' as string]: color }}
            >
              <title>
                {bad
                  ? (state.issues.get(p.uid) ?? []).map((i) => t(`issue_${i.code}`, { level: i.level ?? '' })).join('\n')
                  : ''}
              </title>
              {/* game look: bridges between cells (connection bits), then smaller glowing filled hexes */}
              <g className="mod-cells">
                {(() => {
                  const links = patternLinks(pat);
                  return [
                    ...links.pairs.map(([i, j]) => (
                      <line
                        key={`l${i}-${j}`}
                        className="bridge"
                        x1={centers[i].x}
                        y1={centers[i].y}
                        x2={centers[j].x}
                        y2={centers[j].y}
                        stroke={color}
                        strokeWidth={S * 0.26}
                      />
                    )),
                    ...links.stubs.map(({ cell, dir }) => {
                      const v = directionVector(dir);
                      const c = centers[cell];
                      return (
                        <line
                          key={`s${cell}-${dir}`}
                          className="bridge"
                          x1={c.x}
                          y1={c.y}
                          x2={c.x + v.dx * APO}
                          y2={c.y + v.dy * APO}
                          stroke={color}
                          strokeWidth={S * 0.26}
                        />
                      );
                    }),
                  ];
                })()}
                {centers.map((c, i) => (
                  <polygon key={i} className="mod-hex" points={hexPolygon(c.x, c.y, S * MOD_HEX)} fill={color} />
                ))}
                {bad &&
                  centers.map((c, i) => (
                    <polygon key={`h${i}`} points={hexPolygon(c.x, c.y, S * MOD_HEX)} fill="url(#hatch)" pointerEvents="none" />
                  ))}
              </g>
              {/* full-cell hit areas: easier to grab than the smaller visible hexes */}
              {centers.map((c, i) => (
                <polygon
                  key={`hit${i}`}
                  className="hit"
                  points={hexPolygon(c.x, c.y, S * 0.95)}
                  onPointerDown={(e) => startMove(e, p, i)}
                />
              ))}
              {icon && (
                <image href={icon} x={cx - S * ICON / 2} y={cy - S * ICON / 2} width={S * ICON} height={S * ICON} className="placed-icon" />
              )}
              {bad &&
                centers.map((c, i) => (
                  <polygon key={`b${i}`} className="bad-outline" points={hexPolygon(c.x, c.y, S * 0.9)} />
                ))}
              {bad && (
                <g className="bad-badge" transform={`translate(${cx + S * 0.45}, ${cy - S * 0.55})`}>
                  <circle r={S * 0.28} />
                  <text y={S * 0.11}>!</text>
                </g>
              )}
              {isGridExpander(u) && (
                <text x={cx} y={cy + S * 0.75} className="expander-label">
                  {p.expand === 'row' ? '↓' : '→'}
                </text>
              )}
            </g>
          );
        })}

        {/* ghost of the dragged upgrade */}
        {targetCells.map((c, i) => {
          const { x, y } = px(c.q, c.r);
          return <polygon key={`g${i}`} className={`ghost ${target?.ok ? 'ok' : 'no'}`} points={hexPolygon(x, y, S * 0.9)} fill={target?.ok ? undefined : 'url(#hatch)'} />;
        })}
        {target && dragUpgrade && iconUrl(dragUpgrade.icon) && targetCells.length > 0 && (() => {
          const ic = targetCells[iconCellIndex(upgradePattern(dragUpgrade, drag.rotation))];
          const { x: cx, y: cy } = px(ic.q, ic.r);
          return <image href={iconUrl(dragUpgrade.icon)} x={cx - S * 0.55} y={cy - S * 0.55} width={S * 1.1} height={S * 1.1} opacity={0.85} pointerEvents="none" />;
        })()}
      </svg>
      <div className="board-status">
        <span>
          {t('gridSize')}: <b>{size.w}×{size.h}</b>
          {(size.w !== base.w || size.h !== base.h) && <span className="muted"> ({base.w}×{base.h} + {t('expanders').toLowerCase()})</span>}
        </span>
        <span>
          {t('free')}: <b>{freeCount}</b> · {t('occupied')}: <b>{boardCells.length - freeCount}</b>
        </span>
        <span className={issueText ? 'issue' : state.valid ? 'ok' : 'issue'}>
          {issueText || (state.valid ? t('buildValid') : t('buildInvalid', { n: state.issues.size }))}
        </span>
      </div>
    </div>
  );
}

/** offset coordinates of a placement's anchor, for display/export */
export const anchorOffset = (p: Placement) => axialToOffset(p.anchor.q, p.anchor.r);
