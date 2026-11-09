import type { SolveInput, SolveProgress, SolveResult } from '../core/solver/solve';
import type { SolverMessage, SolverRequest } from './solver.worker';

export interface SolverRun {
  promise: Promise<SolveResult>;
  /** stops the search; the promise resolves with the best solutions reported so far */
  cancel: () => void;
}

let seq = 0;

/**
 * Runs the solver in a dedicated Web Worker (one per run). A synchronous search cannot be interrupted
 * from outside, so cancel() terminates the worker and resolves with the last progress snapshot.
 */
export function runSolver(input: Omit<SolveInput, 'onProgress' | 'shouldStop'>, onProgress?: (p: SolveProgress) => void): SolverRun {
  const id = ++seq;
  const worker = new Worker(new URL('./solver.worker.ts', import.meta.url), { type: 'module' });
  const t0 = Date.now();
  let last: SolveProgress | null = null;
  let settle: (r: SolveResult) => void = () => {};
  let fail: (e: Error) => void = () => {};
  const promise = new Promise<SolveResult>((res, rej) => {
    settle = res;
    fail = rej;
  });
  const maxScore = input.items.reduce((s, i) => s + i.weight * i.count, 0);

  worker.onmessage = (e: MessageEvent<SolverMessage>) => {
    const m = e.data;
    if (m.id !== id) return;
    if (m.type === 'progress') {
      last = m.progress;
      onProgress?.(m.progress);
    } else if (m.type === 'done') {
      worker.terminate();
      settle(m.result);
    } else {
      worker.terminate();
      fail(new Error(m.error));
    }
  };
  worker.onerror = (e) => {
    worker.terminate();
    fail(new Error(e.message));
  };
  worker.postMessage({ id, input } satisfies SolverRequest);

  return {
    promise,
    cancel: () => {
      worker.terminate();
      const solutions = last?.solutions ?? [];
      settle({
        solutions,
        complete: false,
        optimal: solutions.length > 0 && solutions[0].score >= maxScore,
        nodes: last?.nodes ?? 0,
        elapsedMs: Date.now() - t0,
        maxScore,
      });
    },
  };
}
