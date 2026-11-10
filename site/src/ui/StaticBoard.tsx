import { axialKey, axialToPixel, directionVector, hexPolygon, offsetToAxial, SQRT3 } from '../core/hex';
import { evaluate, placementPattern, type BoardContext, type Placement } from '../core/placement';
import { iconCellIndex, patternLinks } from '../core/pattern';
import { isGridExpander } from '../core/rules';
import { iconUrl } from '../data/load';
import { elementColor, rarityColor } from './colors';

/** Read-only rendering of a build in the game look (used by the build showcase). */
export function StaticBoard({ ctx, placements, size: S = 40 }: { ctx: BoardContext; placements: readonly Placement[]; size?: number }) {
  const state = evaluate(ctx, placements);
  const PAD = 8;
  const APO = (SQRT3 / 2) * S;
  const { w, h } = state.size;
  const width = PAD * 2 + S * 2 + 1.5 * S * (w - 1);
  const height = PAD * 2 + SQRT3 * S * (h + 0.5);
  const px = (q: number, r: number) => {
    const p = axialToPixel(q, r, S);
    return { x: p.px + PAD, y: p.py + PAD };
  };
  const base = ctx.baseSize;

  const cells: { x: number; y: number; added: boolean }[] = [];
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) cells.push({ x, y, added: x >= base.w || y >= base.h });

  return (
    <svg className="static-board" width={width} height={height} viewBox={`0 0 ${width} ${height}`} xmlns="http://www.w3.org/2000/svg">
      {cells.map(({ x, y, added }) => {
        const a = offsetToAxial(x, y);
        const { x: cx, y: cy } = px(a.q, a.r);
        return (
          <polygon
            key={`c${x},${y}`}
            points={hexPolygon(cx, cy, S * 0.96)}
            fill={added ? '#17140d' : '#101614'}
            stroke={added ? '#8a6a3a' : '#5d4c43'}
            strokeWidth={3}
            strokeLinejoin="round"
          />
        );
      })}
      {placements.map((p) => {
        const u = ctx.getUpgrade(p.upgradeId);
        const abs = state.cells.get(p.uid);
        if (!u || !abs) return null;
        const pat = placementPattern(ctx.getUpgrade, u, p.rotation, p.patternFrom);
        const color = rarityColor(u.rarity);
        const centers = abs.map((c) => px(c.q, c.r));
        const ic = centers[iconCellIndex(pat)];
        const links = patternLinks(pat);
        const icon = iconUrl(u.icon);
        const iconSize = S * 0.78;
        return (
          <g key={p.uid}>
            <g style={{ filter: `drop-shadow(0 0 2.5px ${color})` }}>
              {links.pairs.map(([i, j]) => (
                <line key={`l${i}-${j}`} x1={centers[i].x} y1={centers[i].y} x2={centers[j].x} y2={centers[j].y} stroke={color} strokeWidth={S * 0.26} />
              ))}
              {links.stubs.map(({ cell, dir }) => {
                const v = directionVector(dir);
                const c = centers[cell];
                return <line key={`s${cell}-${dir}`} x1={c.x} y1={c.y} x2={c.x + v.dx * APO} y2={c.y + v.dy * APO} stroke={color} strokeWidth={S * 0.26} />;
              })}
              {centers.map((c, i) => (
                <polygon key={axialKey(abs[i])} points={hexPolygon(c.x, c.y, S * 0.66)} fill={color} />
              ))}
            </g>
            {icon && (
              <image
                href={icon}
                x={ic.x - iconSize / 2}
                y={ic.y - iconSize / 2}
                width={iconSize}
                height={iconSize}
                style={{ filter: 'brightness(0)', opacity: 0.72 }}
              />
            )}
            {p.element && u.elementChoice?.includes(p.element) && (
              <circle cx={ic.x - S * 0.45} cy={ic.y - S * 0.5} r={S * 0.16} fill={elementColor(p.element)} stroke="#0b0f0e" strokeWidth={2} />
            )}
            {isGridExpander(u) && (
              <text x={ic.x} y={ic.y + S * 0.75} fill="#ffad3b" fontSize={16} fontWeight={700} textAnchor="middle">
                {p.expand === 'row' ? '↓' : '→'}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
