import { gridGrowthLevels, gridSizeForLevel } from '../core/rules';
import { iconUrl } from '../data/load';
import { useBuild, useCurrentGear, useGearLevel, usePlacements } from '../store/build';
import { RichText } from './RichText';
import { useBoardContext, useT } from './hooks';
import { removeSelected, rotateSelected } from './actions';
import { useShowcase } from './Showcase';

export function BuildHeader() {
  const data = useBuild((s) => s.data);
  const gear = useCurrentGear();
  const gearLevel = useGearLevel();
  const setGearLevel = useBuild((s) => s.setGearLevel);
  const selectedUid = useBuild((s) => s.selectedUid);
  const placements = usePlacements();
  const { t, l } = useT();
  const ctx = useBoardContext();
  if (!data || !gear) return null;

  const profile = data.game.gridProfiles[gear.grid] ?? [];
  const size = gridSizeForLevel(profile, gearLevel);
  const growth = gridGrowthLevels(profile).filter((x) => x > 0);
  const ability = gear.ability ? data.game.upgrades[gear.ability] : undefined;


  return (
    <div className="build-header">
      <div className="gear-title">
        {gear.icon && <img src={iconUrl(gear.icon)} alt="" />}
        <div>
          <h1>{l(gear.name)}</h1>
          <span className="muted">{t(`cat_${gear.category === 'global' ? 'special' : gear.category}` as const)}</span>
        </div>
      </div>

      <label className="level" title={t('gearLevelHint')}>
        <span>{t('gearLevel')}</span>
        <input type="number" min={0} max={999} value={gearLevel} onChange={(e) => setGearLevel(Number(e.target.value))} />
        <span className="muted small">
          {t('gridSize')} {size.w}×{size.h}
          {growth.length > 0 && ` · ${t('grows')} ${growth.join(', ')}`}
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

      <div className="toolbar">
        <button disabled={!placements.length} onClick={() => useShowcase.getState().set(true)} title={t('scButtonHint')}>
          📸 {t('scButton')}
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
          {t('clear')}
        </button>
      </div>
    </div>
  );
}
