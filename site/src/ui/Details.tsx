import { useMemo, useState } from 'react';
import { statRows } from '../core/stats';
import { canRotate, isGridExpander, isSpatial, isStackable, rotationUnlockLevel } from '../core/rules';
import { iconUrl } from '../data/load';
import { useBuild, usePlacements } from '../store/build';
import { PatternPreview } from './PatternPreview';
import { RichText } from './RichText';
import { CommentBox, SourceLine } from './CommentBox';
import { elementColor, rarityColor } from './colors';
import { useT } from './hooks';

/** Details of the inspected upgrade (+ controls of the selected placement). */
export function Details() {
  const data = useBuild((s) => s.data);
  const inspectedId = useBuild((s) => s.inspectedId);
  const selectedUid = useBuild((s) => s.selectedUid);
  const accountLevel = useBuild((s) => s.accountLevel);
  const placements = usePlacements();
  const { t, l, lang } = useT();
  const [showAll, setShowAll] = useState(false);

  const u = inspectedId ? data?.game.upgrades[inspectedId] : undefined;
  const placement = placements.find((p) => p.uid === selectedUid && p.upgradeId === inspectedId);
  const rows = useMemo(
    () => (u && data ? statRows(u, data.game.statLabels, data.overrides.fields, lang, showAll) : []),
    [u, data, lang, showAll],
  );

  if (!data) return null;
  if (!u)
    return (
      <section className="panel details empty">
        <p className="muted">{t('noSelection')}</p>
        <p className="muted small">{t('dragHint')}</p>
      </section>
    );

  const rarity = data.game.rarities.find((r) => r.id === u.rarity);
  const color = rarityColor(u.rarity);

  return (
    <section className="panel details" style={{ ['--rc' as string]: color }}>
      <div className="details-head">
        <div className="icon big">{u.icon && <img src={iconUrl(u.icon)} alt="" />}</div>
        <div>
          <h3>{l(u.name)}</h3>
          <div className="meta">
            <span style={{ color }}>{l(rarity?.name)}</span>
            {u.effect !== 'normal' && <span> · {l(data.game.effects[u.effect]) || u.effect}</span>}
            <span className="muted"> · {u.key} · id {u.id}</span>
          </div>
        </div>
        <PatternPreview upgrade={u} size={12} rotation={placement?.rotation ?? 0} className="details-pattern" />
      </div>

      {u.desc && (
        <p className="desc">
          <RichText text={l(u.desc)} />
        </p>
      )}
      <SourceLine u={u} />
      <CommentBox u={u} />

      <ul className="tags">
        <li>⬡ {u.pattern.cells.length} {t('cells')}</li>
        {isStackable(u) && <li>×∞ {t('stackable')}</li>}
        {isSpatial(u) && <li className="spatial">◈ {t('spatial')}</li>}
        {u.elementChoice && (
          <li title={t('elHint')}>
            ◆ {t('elBadge')}:{' '}
            {u.elementChoice.map((e) => (
              <span key={e} className="el-dot" style={{ background: elementColor(e) }} title={l(data.game.effects[e]) || e} />
            ))}
          </li>
        )}
        {!canRotate(u.rarity, accountLevel) && <li className="warn">⟲ {t('rotationLocked', { level: rotationUnlockLevel(u.rarity) })}</li>}
      </ul>

      {placement && isGridExpander(u) && (
        <div className="expander-ctl">
          <span>{t('expandDir')}:</span>
          <div className="seg">
            {(['column', 'row'] as const).map((d) => (
              <button
                key={d}
                className={(placement.expand ?? 'column') === d ? 'on' : ''}
                onClick={() => useBuild.getState().upsertPlacement({ ...placement, expand: d })}
              >
                {d === 'column' ? `→ ${t('expandColumn')}` : `↓ ${t('expandRow')}`}
              </button>
            ))}
          </div>
          <p className="muted small">{t('expandHint')}</p>
        </div>
      )}

      {placement && u.elementChoice && (
        <div className="expander-ctl">
          <span>{t('elChoice')}:</span>
          <div className="seg">
            {[undefined, ...u.elementChoice].map((e) => (
              <button
                key={e ?? '-'}
                className={placement.element === e ? 'on' : ''}
                style={e ? { ['--el' as string]: elementColor(e) } : undefined}
                onClick={() => useBuild.getState().upsertPlacement({ ...placement, element: e })}
              >
                {e ? (
                  <>
                    <span className="el-dot" style={{ background: elementColor(e) }} /> {l(data.game.effects[e]) || e}
                  </>
                ) : (
                  t('elNotSet')
                )}
              </button>
            ))}
          </div>
          <p className="muted small">{t('elHint')}</p>
        </div>
      )}

      {(rows.length > 0 || u.props.length > 0) && (
        <div className="stats">
          <div className="stats-head">
            <h4>{t('stats')}</h4>
            <label className="small muted">
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> {t('showAllStats')}
            </label>
          </div>
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.path} title={`${r.path} (${r.labelSource})`}>
                  <td className={r.labelSource === 'auto' ? 'muted' : ''}>{r.label}</td>
                  <td className="val">{r.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted small">{t('statRangeHint')}</p>
        </div>
      )}
    </section>
  );
}
