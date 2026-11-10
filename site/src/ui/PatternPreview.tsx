import { memo } from 'react';
import type { Upgrade } from '../core/types';
import { axialToPixel, directionVector, hexPolygon, SQRT3 } from '../core/hex';
import { upgradePattern } from '../core/placement';
import { patternLinks } from '../core/pattern';
import { rarityColor } from './colors';

interface Props {
  upgrade: Upgrade;
  rotation?: number;
  size?: number; // hex radius in px
  className?: string;
  highlightIndex?: number;
  /** Pattern Infuser donor: its shape is drawn (in the colour of `upgrade`) */
  patternOf?: Upgrade;
}

/** Small SVG rendering of an upgrade's hex pattern (with the game's connection lines). */
export const PatternPreview = memo(function PatternPreview({ upgrade, rotation = 0, size = 7, className, highlightIndex, patternOf }: Props) {
  const pat = upgradePattern(patternOf ?? upgrade, rotation);
  if (!pat.cells.length) return null;
  const pts = pat.cells.map((c) => ({ ...axialToPixel(c.q, c.r, size), c: c.c }));
  const minX = Math.min(...pts.map((p) => p.px)) - size;
  const maxX = Math.max(...pts.map((p) => p.px)) + size;
  const minY = Math.min(...pts.map((p) => p.py)) - (SQRT3 / 2) * size;
  const maxY = Math.max(...pts.map((p) => p.py)) + (SQRT3 / 2) * size;
  const color = rarityColor(upgrade.rarity);
  const apo = (SQRT3 / 2) * size;
  const links = patternLinks(pat);
  return (
    <svg
      className={className}
      width={maxX - minX + 2}
      height={maxY - minY + 2}
      viewBox={`${minX - 1} ${minY - 1} ${maxX - minX + 2} ${maxY - minY + 2}`}
      aria-hidden
    >
      {/* cell frames */}
      {pts.map((p, i) => (
        <polygon
          key={`f${i}`}
          points={hexPolygon(p.px, p.py, size * 0.96)}
          fill="#101614"
          stroke="#5d4c43"
          strokeWidth={Math.max(0.7, size / 10)}
        />
      ))}
      {/* bridges (connection bits) + filled hexes, as in game */}
      {links.pairs.map(([i, j]) => (
        <line key={`l${i}-${j}`} x1={pts[i].px} y1={pts[i].py} x2={pts[j].px} y2={pts[j].py} stroke={color} strokeWidth={size * 0.26} />
      ))}
      {links.stubs.map(({ cell, dir }) => {
        const v = directionVector(dir);
        const p = pts[cell];
        return (
          <line
            key={`s${cell}-${dir}`}
            x1={p.px}
            y1={p.py}
            x2={p.px + v.dx * apo}
            y2={p.py + v.dy * apo}
            stroke={color}
            strokeWidth={size * 0.26}
          />
        );
      })}
      {pts.map((p, i) => (
        <polygon
          key={i}
          points={hexPolygon(p.px, p.py, size * 0.66)}
          fill={color}
          stroke={i === highlightIndex ? '#fff' : 'none'}
          strokeWidth={Math.max(1, size / 8)}
        />
      ))}
    </svg>
  );
});
