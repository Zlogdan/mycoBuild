/**
 * Hex grid math.
 *
 * The game (HexMap.HexToCube / CubeToHex) stores grids in OFFSET "odd-q" coordinates:
 *   x = column, y = row, flat-top hexes, odd columns shifted DOWN by half a cell.
 * All geometry here is done in AXIAL coordinates (q, r), equivalent to the game's cube (x, -x-z, z):
 *   q = x,  r = y - (x - (x & 1)) / 2
 * In axial, translating a shape is plain vector addition (independent of column parity) and a
 * 60° rotation is a coordinate permutation - which is why the game converts to cube for rotation.
 */

export interface Axial {
  q: number;
  r: number;
}

export interface Offset {
  x: number;
  y: number;
}

/** (x - (x & 1)) / 2, exact for negative x as well (x & 1 is 1 for odd negatives in JS). */
const half = (x: number) => (x - (x & 1)) / 2;

export function offsetToAxial(x: number, y: number): Axial {
  return { q: x, r: y - half(x) };
}

export function axialToOffset(q: number, r: number): Offset {
  return { x: q, y: r + half(q) };
}

/**
 * One 60° rotation step exactly as HexMap.RotateCube: cube (x, y, z) -> (-y, -z, -x).
 * With x = q, z = r, y = -q - r this gives (q, r) -> (q + r, -q).
 * On screen (y pointing down) this turns N into NW, i.e. counter-clockwise.
 */
export function rotateAxial(a: Axial, steps: number): Axial {
  let { q, r } = a;
  const n = ((steps % 6) + 6) % 6;
  for (let i = 0; i < n; i++) {
    const nq = q + r;
    const nr = -q;
    q = nq;
    r = nr;
  }
  return { q: q + 0, r: r + 0 }; // normalise -0
}

/**
 * Connection bits: 1=N 2=NE 4=SE 8=S 16=SW 32=NW (HexMap.AddBidirectionalConnections).
 * The game rotates them with CircularShiftLeft6Bits(c, 6 - rotation) == rotate right by `rotation`.
 */
export function rotateConnections(bits: number, steps: number): number {
  const n = ((steps % 6) + 6) % 6;
  const b = bits & 63;
  return ((b >> n) | (b << (6 - n))) & 63;
}

/** Axial direction vectors indexed like the connection bits (0=N … 5=NW). */
export const DIRECTIONS: readonly Axial[] = [
  { q: 0, r: -1 }, // N
  { q: 1, r: -1 }, // NE
  { q: 1, r: 0 }, // SE
  { q: 0, r: 1 }, // S
  { q: -1, r: 1 }, // SW
  { q: -1, r: 0 }, // NW
];

export function neighbors(a: Axial): Axial[] {
  return DIRECTIONS.map((d) => ({ q: a.q + d.q, r: a.r + d.r }));
}

export const axialKey = (a: Axial) => `${a.q},${a.r}`;

/* ---------- pixel layout (flat-top) ---------- */

export const SQRT3 = Math.sqrt(3);

/** Centre of an offset cell for hex "radius" `size` (corner distance). Origin cell (0,0) touches (0,0). */
export function offsetToPixel(x: number, y: number, size: number): { px: number; py: number } {
  return {
    px: size + 1.5 * size * x,
    py: (SQRT3 / 2) * size + SQRT3 * size * (y + 0.5 * (x & 1)),
  };
}

/** Same layout as offsetToPixel, from axial coordinates (y + (x&1)/2 == r + q/2). */
export function axialToPixel(q: number, r: number, size: number): { px: number; py: number } {
  return { px: size + 1.5 * size * q, py: (SQRT3 / 2) * size + SQRT3 * size * (r + q / 2) };
}

/** Inverse of offsetToPixel, rounding to the nearest hex. */
export function pixelToAxial(px: number, py: number, size: number): Axial {
  const x = px - size;
  const y = py - (SQRT3 / 2) * size;
  const qf = ((2 / 3) * x) / size;
  const rf = ((-1 / 3) * x + (SQRT3 / 3) * y) / size;
  return axialRound(qf, rf);
}

export function axialRound(qf: number, rf: number): Axial {
  const sf = -qf - rf;
  let q = Math.round(qf);
  let r = Math.round(rf);
  const s = Math.round(sf);
  const dq = Math.abs(q - qf);
  const dr = Math.abs(r - rf);
  const ds = Math.abs(s - sf);
  if (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds) r = -q - s;
  return { q: q + 0, r: r + 0 };
}

/** SVG polygon points of a flat-top hex centred at (cx, cy). */
export function hexPolygon(cx: number, cy: number, size: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const ang = (Math.PI / 180) * (60 * i);
    pts.push(`${(cx + size * Math.cos(ang)).toFixed(2)},${(cy + size * Math.sin(ang)).toFixed(2)}`);
  }
  return pts.join(' ');
}

/** Unit vector (screen space, y down) pointing from a hex centre towards neighbour direction `dir`. */
export function directionVector(dir: number): { dx: number; dy: number } {
  // flat-top neighbour directions are at -90°(N), -30°(NE), 30°(SE), 90°(S), 150°(SW), 210°(NW)
  const ang = (Math.PI / 180) * (-90 + 60 * dir);
  return { dx: Math.cos(ang), dy: Math.sin(ang) };
}
