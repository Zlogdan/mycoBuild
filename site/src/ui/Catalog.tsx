import { memo, useMemo, useState } from 'react';
import type { Upgrade } from '../core/types';
import { canRotate, isSpatial, isStackable, rotationUnlockLevel } from '../core/rules';
import { findFreeSpot } from '../core/placement';
import { iconUrl } from '../data/load';
import { newUid, upgradePool, useBuild, useCurrentGear, usePlacements } from '../store/build';
import { useDrag } from '../store/drag';
import { PatternPreview } from './PatternPreview';
import { rarityColor } from './colors';
import { useBoardContext, useT } from './hooks';
import { useAutofill } from '../store/autofill';
import { AutofillPanel } from './AutofillPanel';

type Group = 'all' | 'own' | 'common' | 'expanders';

export function Catalog() {
  const data = useBuild((s) => s.data);
  const gear = useCurrentGear();
  const placements = usePlacements();
  const accountLevel = useBuild((s) => s.accountLevel);
  const inspectedId = useBuild((s) => s.inspectedId);
  const { t, l, lang } = useT();
  const ctx = useBoardContext();

  const [query, setQuery] = useState('');
  const [rarities, setRarities] = useState<Set<number>>(new Set());
  const [element, setElement] = useState('');
  const [group, setGroup] = useState<Group>('all');
  const [tab, setTab] = useState<'catalog' | 'autofill'>('catalog');
  const afSelection = useAutofill((s) => (gear ? s.selections[gear.id] : undefined));
  const afIds = useMemo(() => new Set((afSelection ?? []).map((e) => e.upgradeId)), [afSelection]);

  const pool = useMemo(() => (data && gear ? upgradePool(data, gear) : null), [data, gear]);

  const list = useMemo(() => {
    if (!pool) return [] as { u: Upgrade; group: Group }[];
    const items: { u: Upgrade; group: Group }[] = [
      ...pool.own.map((u) => ({ u, group: 'own' as Group })),
      ...pool.common.map((u) => ({ u, group: 'common' as Group })),
      ...pool.expanders.map((u) => ({ u, group: 'expanders' as Group })),
    ];
    const q = query.trim().toLowerCase();
    return items
      .filter((x) => group === 'all' || x.group === group)
      .filter((x) => !rarities.size || rarities.has(x.u.rarity))
      .filter((x) => !element || x.u.effect === element)
      .filter((x) => {
        if (!q) return true;
        const hay = [l(x.u.name), x.u.name.en, x.u.key, l(x.u.desc)].join(' ').toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => a.u.rarity - b.u.rarity || l(a.u.name).localeCompare(l(b.u.name), lang));
  }, [pool, query, rarities, element, group, l, lang]);

  const placedCount = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of placements) m.set(p.upgradeId, (m.get(p.upgradeId) ?? 0) + 1);
    return m;
  }, [placements]);

  if (!data || !gear || !pool) return null;

  const elements = [...new Set([...pool.own, ...pool.common].map((u) => u.effect))].sort();

  const quickPlace = (u: Upgrade) => {
    if (!ctx) return;
    const rot = canRotate(u.rarity, ctx.accountLevel) ? [0, 1, 2, 3, 4, 5] : [0];
    const spot = findFreeSpot(ctx, placements, { uid: newUid(), upgradeId: u.id, expand: u.role === 'gridExpander' ? 'column' : undefined }, rot);
    if (spot) {
      useBuild.getState().upsertPlacement(spot);
      useBuild.getState().select(spot.uid);
    } else useBuild.getState().notify(t('noFreeSpot', { name: l(u.name) }));
  };

  return (
    <section className="panel catalog">
      <div className="tabs">
        <button className={tab === 'catalog' ? 'on' : ''} onClick={() => setTab('catalog')}>
          {t('tabCatalog')} <span className="muted small">{list.length}</span>
        </button>
        <button className={tab === 'autofill' ? 'on' : ''} onClick={() => setTab('autofill')}>
          {t('tabAutofill')} {afIds.size > 0 && <span className="count">{afIds.size}</span>}
        </button>
      </div>
      {tab === 'autofill' ? (
        <AutofillPanel />
      ) : (
      <>
      <input className="search" placeholder={t('search')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <div className="filters">
        <div className="seg">
          {(['all', 'own', ...(pool.common.length ? ['common'] : []), 'expanders'] as Group[]).map((g) => (
            <button key={g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>
              {g === 'expanders' ? t('expanders') : t(g)}
            </button>
          ))}
        </div>
        <div className="rarity-filter">
          {data.game.rarities.map((r) => (
            <button
              key={r.id}
              title={l(r.name)}
              className={rarities.has(r.id) ? 'on' : ''}
              style={{ ['--rc' as string]: r.color }}
              onClick={() => {
                const next = new Set(rarities);
                if (next.has(r.id)) next.delete(r.id);
                else next.add(r.id);
                setRarities(next);
              }}
            />
          ))}
          <select value={element} onChange={(e) => setElement(e.target.value)} title={t('element')}>
            <option value="">
              {t('element')}: {t('anyElement')}
            </option>
            {elements.map((e) => (
              <option key={e} value={e}>
                {l(data.game.effects[e]) || e}
              </option>
            ))}
          </select>
        </div>
      </div>
      <ul className="upgrade-list">
        {list.map(({ u }) => (
          <UpgradeCard
            key={u.id}
            u={u}
            placed={placedCount.get(u.id) ?? 0}
            locked={!canRotate(u.rarity, accountLevel)}
            active={inspectedId === u.id}
            onQuickPlace={quickPlace}
            inAutofill={afIds.has(u.id)}
            onToggleAutofill={() => useAutofill.getState().toggle(gear.id, u.id)}
          />
        ))}
      </ul>
      </>
      )}
    </section>
  );
}

const UpgradeCard = memo(function UpgradeCard({
  u,
  placed,
  locked,
  active,
  onQuickPlace,
  inAutofill,
  onToggleAutofill,
}: {
  u: Upgrade;
  placed: number;
  locked: boolean;
  active: boolean;
  onQuickPlace: (u: Upgrade) => void;
  inAutofill: boolean;
  onToggleAutofill: () => void;
}) {
  const { t, l } = useT();
  const color = rarityColor(u.rarity);
  const stack = isStackable(u);
  const exhausted = placed > 0 && !stack;
  return (
    <li
      className={`upgrade-card ${active ? 'active' : ''} ${exhausted ? 'exhausted' : ''}`}
      style={{ ['--rc' as string]: color }}
      onClick={() => useBuild.getState().inspect(u.id)}
      onDoubleClick={() => onQuickPlace(u)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        useAutofill.getState().setPreview(null);
        useDrag.getState().begin({
          upgradeId: u.id,
          uid: newUid(),
          isNew: true,
          rotation: 0,
          grabIndex: 0,
          expand: u.role === 'gridExpander' ? 'column' : undefined,
          x: e.clientX,
          y: e.clientY,
        });
      }}
    >
      <div className="icon">{u.icon && <img src={iconUrl(u.icon)} alt="" draggable={false} loading="lazy" />}</div>
      <div className="body">
        <div className="name">{l(u.name)}</div>
        <div className="badges">
          <span title={t('cells')}>⬡{u.pattern.cells.length}</span>
          {stack && <span title={t('stackable')}>×∞</span>}
          {isSpatial(u) && <span title={t('spatial')}>◈</span>}
          {locked && <span title={t('rotationLocked', { level: rotationUnlockLevel(u.rarity) })}>⟲🔒</span>}
          {placed > 0 && <span className="placed-badge" title={t('placed')}>✓{stack ? placed : ''}</span>}
        </div>
      </div>
      <PatternPreview upgrade={u} size={6} className="mini-pattern" />
      <button
        className={`af-toggle ${inAutofill ? 'on' : ''}`}
        title={inAutofill ? t('afRemove') : t('afAdd')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onToggleAutofill();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        {inAutofill ? '✓' : '+'}
      </button>
    </li>
  );
});
