import { describe, expect, it } from 'vitest';
import {
  DIRECTIONS,
  axialKey,
  axialToOffset,
  offsetToAxial,
  offsetToPixel,
  pixelToAxial,
  rotateAxial,
  rotateConnections,
} from '../src/core/hex';

/** Literal port of the game's HexMap.HexToCube / RotateCube / CubeToHex (Assembly-CSharp IL). */
const game = {
  hexToCube(x: number, y: number) {
    const z = y - Math.trunc((x - (x & 1)) / 2);
    return { x, y: -x - z, z };
  },
  rotateCube(c: { x: number; y: number; z: number }, n: number) {
    let v = { ...c };
    for (let i = 0; i < n; i++) v = { x: -v.y, y: -v.z, z: -v.x };
    return v;
  },
  cubeToHex(c: { x: number; z: number }) {
    return { x: c.x, y: c.z + Math.trunc((c.x - (c.x & 1)) / 2) };
  },
  /** neighbour of offset cell for connection bit, from HexMap.AddBidirectionalConnections */
  neighbor(x: number, y: number, bit: number) {
    const up = x % 2 !== 0 ? 0 : -1;
    switch (bit) {
      case 1: return { x, y: y - 1 }; // N
      case 2: return { x: x + 1, y: y + up }; // NE
      case 32: return { x: x - 1, y: y + up }; // NW
      case 8: return { x, y: y + 1 }; // S
      case 16: return { x: x - 1, y: y + up + 1 }; // SW
      case 4: return { x: x + 1, y: y + up + 1 }; // SE
    }
    throw new Error('bit');
  },
};

describe('offset <-> axial', () => {
  it('round-trips every cell of a 9×9 area incl. negatives', () => {
    for (let x = -4; x < 9; x++)
      for (let y = -4; y < 9; y++) {
        const a = offsetToAxial(x, y);
        expect(axialToOffset(a.q, a.r)).toEqual({ x, y });
      }
  });

  it('matches the game cube conversion', () => {
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) {
        const c = game.hexToCube(x, y);
        expect(offsetToAxial(x, y)).toEqual({ q: c.x, r: c.z });
      }
  });

  it('axial directions equal the game offset neighbours (even and odd columns)', () => {
    const bits = [1, 2, 4, 8, 16, 32];
    for (const x of [2, 3])
      for (const y of [2, 3])
        bits.forEach((bit, i) => {
          const a = offsetToAxial(x, y);
          const n = { q: a.q + DIRECTIONS[i].q, r: a.r + DIRECTIONS[i].r };
          expect(axialToOffset(n.q, n.r)).toEqual(game.neighbor(x, y, bit));
        });
  });
});

describe('rotation', () => {
  it('6 steps are identity, steps are additive', () => {
    for (let q = -3; q <= 3; q++)
      for (let r = -3; r <= 3; r++) {
        expect(rotateAxial({ q, r }, 6)).toEqual({ q, r });
        expect(rotateAxial(rotateAxial({ q, r }, 2), 3)).toEqual(rotateAxial({ q, r }, 5));
      }
  });

  it('equals the game RotateCube for every step', () => {
    for (let x = 0; x < 6; x++)
      for (let y = 0; y < 6; y++)
        for (let n = 0; n < 6; n++) {
          const g = game.rotateCube(game.hexToCube(x, y), n);
          const a = rotateAxial(offsetToAxial(x, y), n);
          expect(a).toEqual({ q: g.x + 0, r: g.z + 0 });
        }
  });

  it('connection bits rotate together with geometry', () => {
    for (let i = 0; i < 6; i++)
      for (let n = 0; n < 6; n++) {
        const v = rotateAxial(DIRECTIONS[i], n);
        const j = DIRECTIONS.findIndex((d) => d.q === v.q && d.r === v.r);
        expect(rotateConnections(1 << i, n)).toBe(1 << j);
      }
  });

  it('game CircularShiftLeft6Bits(c, 6 - n) equals rotateConnections(c, n)', () => {
    const shl = (v: number, s: number) => {
      s %= 6;
      return ((v << (s & 31)) | (v >> ((6 - s) & 31))) & 63;
    };
    for (let c = 0; c < 64; c++) for (let n = 0; n < 6; n++) expect(rotateConnections(c, n)).toBe(shl(c, 6 - n));
  });

  it('matches the game shape after offset rotation (up to translation)', () => {
    // a 3-cell L shape in a 3×3 box, rotated by the game algorithm on offset coordinates
    const cells = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ];
    for (let n = 0; n < 6; n++) {
      const gameCells = cells.map((c) => game.cubeToHex(game.rotateCube(game.hexToCube(c.x, c.y), n)));
      const ours = cells.map((c) => rotateAxial(offsetToAxial(c.x, c.y), n));
      const norm = (list: { q: number; r: number }[]) => {
        const mq = Math.min(...list.map((a) => a.q));
        const mr = Math.min(...list.map((a) => a.r));
        return list.map((a) => axialKey({ q: a.q - mq, r: a.r - mr })).sort();
      };
      expect(norm(ours)).toEqual(norm(gameCells.map((o) => offsetToAxial(o.x, o.y))));
    }
  });
});

describe('pixels', () => {
  it('pixel centre maps back to the same cell', () => {
    for (let x = 0; x < 8; x++)
      for (let y = 0; y < 8; y++) {
        const { px, py } = offsetToPixel(x, y, 30);
        expect(pixelToAxial(px + 7, py - 5, 30)).toEqual(offsetToAxial(x, y));
      }
  });
});
