import { gridGrowthLevels, gridSizeForLevel } from '../core/rules';
import { iconUrl } from '../data/load';
import { SLOTS, buildKey, useBuild, useCurrentGear, useGearLevel, usePlacements, useSlot } from '../store/build';
import { RichText } from './RichText';
import { useBoardContext, useT } from './hooks';
import { removeSelected, rotateSelected } from './actions';
import { useShowcase } from './Showcase';
import { useAutofill } from '../store/autofill';

export function BuildHeader() {
  const data = useBuild((s) => s.data);
  const gear = useCurrentGear();
  const gearLevel = useGearLevel();
  const setGearLevel = useBuild((s) => s.setGearLevel);
  const selectedUid = useBuild((s) => s.selectedUid);
  const placements = usePlacements();
  const slot = useSlot();
  const builds = useBuild((s) => s.builds);
  const { t, l } = useT();
  const ctx = useBoardContext();
  if (!data || !gear) return null;

  const profile = data.game.gridProfiles[gear.grid] ?? [];
  const size = gridSizeForLevel(profile, gearLevel);
  const growth = gridGrowthLevels(profile).filter((x) => x > 0);
  const ability = gear.ability ? data.game.upgrades[gear.ability] : undefined;


  return (
    <div className="build-header">
      <div className="build-top">
      <div className="gear-title">
        {gear.icon && <img src={iconUrl(gear.icon)} alt="" />}
        <div>
          <h1>{l(gear.name)}</h1>
          <span className="muted">{t(`cat_${gear.category === 'global' ? 'special' : gear.category}` as const)}</span>
        </div>
      </div>

      <label className="level gear-level" title={t('gearLevelHint')}>
        <span>{t('gearLevel')}</span>
        <input type="number" min={0} max={999} value={gearLevel} onChange={(e) => setGearLevel(Number(e.target.value))} />
        <span className="muted small grid-info">
          {t('gridSize')} {size.w}×{size.h}
          {growth.length > 0 && <span className="grows"> · {t('grows')} {growth.join(', ')}</span>}
        </span>
      </label>

      {ability && (
        <div className="ability" title={l(ability.desc)}>
          {ability.icon && <img src={iconUrl(ability.icon)} alt="" />}
          <div>
            <span className="muted small">{t('ability')}</span>
            <div className="ability-name">{l(ability.name)}</div>
            <div className="small ability-desc">
              <RichText text={l(ability.desc)} />
            </div>
          </div>
        </div>
      )}

      </div>

      <div className="build-controls">
      <div className="slots" title={t('slotHint')}>
        <div className="seg">
          {SLOTS.map((n) => {
            const count = builds[buildKey(gear.id, n)]?.length ?? 0;
            return (
              <button key={n} className={slot === n ? 'on' : ''} onClick={() => {
                  useAutofill.getState().setPreview(null);
                  useBuild.getState().setSlot(n);
                }}>
                {n ? t('slotLoadout', { n }) : t('slotCurrent')}
                {count > 0 && <span className="slot-count">{count}</span>}
              </button>
            );
          })}
        </div>
        <select
          value=""
          disabled={!placements.length}
          onChange={(e) => {
            const to = Number(e.target.value);
            e.target.value = '';
            const name = to ? t('slotLoadout', { n: to }) : t('slotCurrent');
            const target = builds[buildKey(gear.id, to)]?.length ?? 0;
            if (target && !window.confirm(t('slotCopyConfirm', { slot: name }))) return;
            useBuild.getState().copySlotTo(to);
            useBuild.getState().notify(t('slotCopied', { slot: name }));
          }}
          title={t('slotCopy')}
        >
          <option value="">⧉ {t('slotCopy')}</option>
          {SLOTS.filter((n) => n !== slot).map((n) => (
            <option key={n} value={n}>
              {n ? t('slotLoadout', { n }) : t('slotCurrent')}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar">
        <button disabled={!placements.length} onClick={() => useShowcase.getState().set(true)} title={t('scButtonHint')}>
          📸<span className="tb-label">{t('scButton')}</span>
        </button>
        <button disabled={!selectedUid || !ctx} onClick={() => ctx && rotateSelected(ctx, placements)} title={t('rotate')}>
          ⟳
        </button>
        <button disabled={!selectedUid} onClick={removeSelected} title={t('remove')}>
          ✕
        </button>
        <button
          disabled={!placements.length}
          onClick={() => {
            if (window.confirm(t('clearConfirm'))) useBuild.getState().clearBuild();
          }}
          title={t('clear')}
        >
          🗑<span className="tb-label">{t('clear')}</span>
        </button>
      </div>
      </div>
    </div>
  );
}
