import { useMemo } from 'react';
import type { Upgrade } from '../core/types';
import { isGridExpander, isStackable } from '../core/rules';
import { iconUrl } from '../data/load';
import { useAutofill } from '../store/autofill';
import { useBuild, useCurrentGear, usePlacements } from '../store/build';
import { applyVariant, autofillKey, startAutofill } from './autofillActions';
import { rarityColor } from './colors';
import { useBoardContext, useT } from './hooks';

const EMPTY: never[] = [];

export function AutofillPanel() {
  const data = useBuild((s) => s.data);
  const gear = useCurrentGear();
  const placements = usePlacements();
  const ctx = useBoardContext();
  const { t, l } = useT();
  const af = useAutofill();
  const selection = (gear && af.selections[gear.id]) || EMPTY;

  const currentKey = useMemo(
    () => (gear && ctx ? autofillKey(gear.id, ctx, placements, selection, af.options) : ''),
    [gear, ctx, placements, selection, af.options],
  );
  const stale = af.status === 'done' && af.resultKey !== currentKey;

  if (!data || !gear || !ctx) return null;
  const U = data.game.upgrades;
  const sorted = selection
    .map((e) => ({ e, u: U[e.upgradeId] as Upgrade | undefined }))
    .filter((x): x is { e: typeof x.e; u: Upgrade } => !!x.u)
    .sort((a, b) => b.e.weight - a.e.weight);
  const totalWeight = sorted.reduce((s, x) => s + x.e.weight * (isStackable(x.u) ? x.e.count : 1), 0);
  const running = af.status === 'running';
  const result = af.result;
  const solutions = running ? af.progress?.solutions ?? [] : result?.solutions ?? [];
  const maxScore = result?.maxScore ?? totalWeight;

  return (
    <div className="autofill">
      {sorted.length === 0 ? (
        <p className="muted small">{t('afEmpty')}</p>
      ) : (
        <>
          <div className="af-head muted small">
            {t('afSelected', { n: sorted.length, w: totalWeight })}
            <button className="link" onClick={() => af.clearSelection(gear.id)}>
              {t('afClear')}
            </button>
          </div>
          <ul className="af-list">
            {sorted.map(({ e, u }) => (
              <li key={u.id} style={{ ['--rc' as string]: rarityColor(u.rarity) }}>
                <span className="icon">{u.icon && <img src={iconUrl(u.icon)} alt="" />}</span>
                <span className="name" title={l(u.name)} onClick={() => useBuild.getState().inspect(u.id)}>
                  {l(u.name)}
                  {isGridExpander(u) && <span className="muted small"> · {t('afExpanderNote')}</span>}
                </span>
                <label title={t('afWeight')}>
                  <span className="muted small">{t('afWeight')}</span>
                  <input
                    type="number"
                    min={1}
                    max={999}
                    value={e.weight}
                    onChange={(ev) => af.setEntry(gear.id, u.id, { weight: Math.max(1, Math.min(999, Number(ev.target.value) || 1)) })}
                  />
                </label>
                {isStackable(u) && (
                  <label title={t('afCount')}>
                    <span className="muted small">×</span>
                    <input
                      type="number"
                      min={1}
                      max={20}
                      value={e.count}
                      onChange={(ev) => af.setEntry(gear.id, u.id, { count: Math.max(1, Math.min(20, Number(ev.target.value) || 1)) })}
                    />
                  </label>
                )}
                <button className="x" title={t('afRemove')} onClick={() => af.toggle(gear.id, u.id)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="af-options">
        <label>
          <input type="checkbox" checked={af.options.keepPlaced} onChange={(e) => af.setOptions({ keepPlaced: e.target.checked })} /> {t('afKeep')}
        </label>
        <label>
          {t('afTime')}{' '}
          <select value={af.options.timeLimitMs} onChange={(e) => af.setOptions({ timeLimitMs: Number(e.target.value) })}>
            {[1000, 3000, 10000, 30000, 60000].map((ms) => (
              <option key={ms} value={ms}>
                {ms / 1000} s
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('afVariants')}{' '}
          <select value={af.options.topK} onChange={(e) => af.setOptions({ topK: Number(e.target.value) })}>
            {[1, 3, 5, 10].map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="af-run">
        {running ? (
          <button className="primary" onClick={() => af.cancel?.()}>
            {t('afStop')}
          </button>
        ) : (
          <button className="primary" disabled={!sorted.length} onClick={() => startAutofill(gear.id, ctx, placements)}>
            {t('afRun')}
          </button>
        )}
        {running && af.progress && (
          <span className="muted small">
            {t('afRunning', { nodes: af.progress.nodes.toLocaleString(), sec: (af.progress.elapsedMs / 1000).toFixed(1), best: af.progress.best })}
          </span>
        )}
      </div>

      {af.status === 'error' && <p className="issue small">{af.error}</p>}
      {stale && <p className="warn small">{t('afStale')}</p>}
      {af.status === 'done' && result && result.solutions.length === 0 && <p className="muted">{t('afNoSolution')}</p>}

      {solutions.length > 0 && !stale && (
        <ol className="af-variants">
          {solutions.map((s, i) => {
            const placedN = s.placements.length;
            const total = placedN + Object.values(s.unplaced).reduce((a, b) => a + b, 0);
            const active = af.preview === i;
            return (
              <li key={i} className={active ? 'active' : ''}>
                <button className="variant-btn" onClick={() => af.setPreview(active ? null : i)}>
                  <b>{t('afVariant', { n: i + 1 })}</b>
                  <span>{t('afScore', { score: s.score, max: maxScore })}</span>
                  <span className="muted">{t('afPlacedN', { a: placedN, b: total })}</span>
                  {i === 0 && !running && result && (
                    <span
                      className={result.optimal ? 'badge ok' : 'badge warn'}
                      title={result.optimal ? t('afOptimalHint') : t('afBestFoundHint')}
                    >
                      {result.optimal ? t('afOptimal') : t('afBestFound')}
                    </span>
                  )}
                </button>
                {active && (
                  <div className="variant-details">
                    {Object.keys(s.unplaced).length > 0 && (
                      <p className="small">
                        <span className="warn">{t('afUnplaced')}:</span>{' '}
                        {Object.entries(s.unplaced)
                          .map(([id, n]) => `${l(U[id]?.name)}${n > 1 ? ` ×${n}` : ''}`)
                          .join(', ')}
                      </p>
                    )}
                    <p className="small muted">
                      {t('afPlaced')}: {s.placements.map((p) => l(U[p.upgradeId]?.name)).join(', ')}
                    </p>
                    {!running && (
                      <button className="primary" onClick={() => applyVariant(i)}>
                        {t('afApply')}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
