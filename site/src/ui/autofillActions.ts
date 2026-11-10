import type { BoardContext, Placement } from '../core/placement';
import { prepareSolve, solutionToPlacements, type AutofillEntry } from '../core/solver/prepare';
import type { Solution } from '../core/solver/solve';
import { translate } from '../i18n';
import { newUid, useBuild } from '../store/build';
import { useAutofill, type AutofillOptions } from '../store/autofill';
import { runSolver } from '../worker/client';

/** Fingerprint of everything the result depends on; a different key means the result is stale. */
export function autofillKey(
  gearId: string,
  ctx: BoardContext,
  placements: readonly Placement[],
  selection: readonly AutofillEntry[],
  options: AutofillOptions,
): string {
  return JSON.stringify({
    gearId,
    base: ctx.baseSize,
    level: ctx.accountLevel,
    sel: selection.map((e) => [e.upgradeId, e.weight, e.count]),
    keep: options.keepPlaced,
    inf: options.infuser.enabled ? [options.infuser.neutralOnly, options.infuser.forceShrink] : null,
    placed: options.keepPlaced
      ? placements.map((p) => [p.upgradeId, p.rotation, p.anchor.q, p.anchor.r, p.expand ?? '', p.patternFrom ?? ''])
      : [],
  });
}

export function startAutofill(gearId: string, ctx: BoardContext, placements: readonly Placement[]) {
  const af = useAutofill.getState();
  af.cancel?.();
  const selection = af.selections[gearId] ?? [];
  const input = prepareSolve(ctx, placements, selection, {
    keepPlaced: af.options.keepPlaced,
    topK: af.options.topK,
    timeLimitMs: af.options.timeLimitMs,
    infuser: af.options.infuser,
    allUpgrades: Object.values(useBuild.getState().data?.game.upgrades ?? {}),
  });
  if (!input.items.length) {
    const b = useBuild.getState();
    b.notify(translate(b.lang, 'afNoItems'));
    return;
  }
  const keep = af.options.keepPlaced;
  const toVariants = (sols: Solution[]) => sols.map((s) => solutionToPlacements(s, placements, keep, newUid));
  const b = useBuild.getState();
  const key = autofillKey(`${gearId}#${b.slots[gearId] ?? 0}`, ctx, placements, selection, af.options);

  const run = runSolver(input, (progress) =>
    useAutofill.setState({ progress, variants: toVariants(progress.solutions) }),
  );
  useAutofill.setState({ status: 'running', error: null, progress: null, result: null, variants: [], preview: null, resultKey: key, cancel: run.cancel });
  run.promise
    .then((result) =>
      useAutofill.setState({ status: 'done', result, variants: toVariants(result.solutions), cancel: null, preview: result.solutions.length ? 0 : null }),
    )
    .catch((e: unknown) => useAutofill.setState({ status: 'error', error: String(e), cancel: null }));
}

export function applyVariant(i: number) {
  const v = useAutofill.getState().variants[i];
  if (!v) return;
  useBuild.getState().setPlacements(v.map((p) => ({ ...p, anchor: { ...p.anchor } })));
  useAutofill.setState({ preview: null });
}
