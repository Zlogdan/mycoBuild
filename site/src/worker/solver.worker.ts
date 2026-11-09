/// <reference lib="webworker" />
import { solve, type SolveInput } from '../core/solver/solve';

export type SolverRequest = { id: number; input: Omit<SolveInput, 'onProgress' | 'shouldStop'> };
export type SolverMessage =
  | { id: number; type: 'progress'; progress: import('../core/solver/solve').SolveProgress }
  | { id: number; type: 'done'; result: import('../core/solver/solve').SolveResult }
  | { id: number; type: 'error'; error: string };

self.onmessage = (e: MessageEvent<SolverRequest>) => {
  const { id, input } = e.data;
  try {
    const result = solve({
      ...input,
      onProgress: (progress) => (self as unknown as Worker).postMessage({ id, type: 'progress', progress } satisfies SolverMessage),
    });
    (self as unknown as Worker).postMessage({ id, type: 'done', result } satisfies SolverMessage);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, type: 'error', error: String(err) } satisfies SolverMessage);
  }
};
