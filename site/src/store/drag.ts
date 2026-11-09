import { create } from 'zustand';
import type { Axial } from '../core/hex';
import type { ExpandDirection, Issue } from '../core/placement';

export interface DragTarget {
  anchor: Axial;
  ok: boolean;
  issues: Issue[];
}

export interface DragState {
  active: boolean;
  /** pointer went down but the drag threshold was not passed yet */
  pending: boolean;
  upgradeId: string | null;
  /** uid of the placement being moved, or a fresh uid for a new one */
  uid: string | null;
  isNew: boolean;
  rotation: number;
  /** index of the pattern cell held under the cursor */
  grabIndex: number;
  expand?: ExpandDirection;
  startX: number;
  startY: number;
  x: number;
  y: number;
  target: DragTarget | null;

  begin: (p: {
    upgradeId: string;
    uid: string;
    isNew: boolean;
    rotation: number;
    grabIndex: number;
    expand?: ExpandDirection;
    x: number;
    y: number;
  }) => void;
  move: (x: number, y: number) => void;
  setRotation: (r: number) => void;
  setTarget: (t: DragTarget | null) => void;
  end: () => void;
}

const idle = {
  active: false,
  pending: false,
  upgradeId: null,
  uid: null,
  isNew: false,
  rotation: 0,
  grabIndex: 0,
  expand: undefined,
  startX: 0,
  startY: 0,
  x: 0,
  y: 0,
  target: null,
};

export const DRAG_THRESHOLD = 5;

export const useDrag = create<DragState>()((set, get) => ({
  ...idle,
  begin: (p) => set({ ...idle, ...p, pending: true, startX: p.x, startY: p.y }),
  move: (x, y) => {
    const s = get();
    if (s.pending && Math.hypot(x - s.startX, y - s.startY) >= DRAG_THRESHOLD) set({ pending: false, active: true, x, y });
    else set({ x, y });
  },
  setRotation: (rotation) => set({ rotation: ((rotation % 6) + 6) % 6 }),
  setTarget: (target) => set({ target }),
  end: () => set({ ...idle }),
}));
