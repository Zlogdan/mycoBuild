import { memo, useMemo, useState } from 'react';
import type { Gear, GearCategory, Upgrade } from '../core/types';
import { isSpatial, isStackable } from '../core/rules';
import { statRows } from '../core/stats';
import { iconUrl } from '../data/load';
import { useBuild } from '../store/build';
import { effectiveComment, mergedComments, useComments } from '../store/comments';
import { CommentBox, SourceLine } from './CommentBox';
import { PatternPreview } from './PatternPreview';
import { RichText } from './RichText';
import { elementColor, rarityColor } from './colors';
import { useT } from './hooks';
import { navigate } from './route';
import { EDITOR_MODE } from './editor';

type Cat = 'all' | Exclude<GearCategory, 'global'> | 'common' | 'expanders';
type Sort = 'rarity' | 'name' | 'gear';
const PAGE = 60;
const CATS: Cat[] = ['all', 'character', 'common', 'primary', 'heavy', 'throwable', 'special', 'expanders'];
const SOURCES = ['WorldPool', 'AfterOther', 'UpgradeTree', 'DropsFromSource', 'LevelUp', 'Resources'] as const;

export function ModsPage() {
  const data = useBuild((s) => s.data);
  const { t, l, lang } = useT();
  const local = useComments((s) => s.local);

  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<Cat>('all');
  const [gearId, setGearId] = useState('');
  const [rarities, setRarities] = useState<Set<number>>(new Set());
  const [element, setElement] = useState('');
  const [source, setSource] = useState('');
  const [cells, setCells] = useState('');
  const [onlyStack, setOnlyStack] = useState(false);
  const [onlySpatial, setOnlySpatial] = useState(false);
  const [onlyCommented, setOnlyCommented] = useState(false);
  const [sort, setSort] = useState<Sort>('rarity');
  const [limit, setLimit] = useState(PAGE);

  const gearsById = useMemo(() => new Map((data?.game.gears ?? []).map((g) => [g.id, g])), [data]);

  const all = useMemo(
    () => (data ? Object.values(data.game.upgrades).filter((u) => u.role !== 'ability') : []),
    [data],
  );

  const gearOptions = useMemo(() => {
    if (!data) return [] as Gear[];
    return data.game.gears.filter((g) => {
      if (g.category === 'global') return cat === 'all' || cat === 'common';
      return cat === 'all' || cat === g.category;
    });
  }, [data, cat]);

  const list = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const gearsOf = (u: Upgrade) => u.gears.map((id) => gearsById.get(id)).filter((g): g is Gear => !!g);
    const res = all.filter((u) => {
      const gs = gearsOf(u);
      if (cat === 'expanders' && u.role !== 'gridExpander') return false;
      if (cat === 'common' && !gs.some((g) => g.category === 'global')) return false;
      if (cat !== 'all' && cat !== 'expanders' && cat !== 'common' && !gs.some((g) => g.category === cat)) return false;
      if (gearId && !u.gears.includes(gearId)) return false;
      if (rarities.size && !rarities.has(u.rarity)) return false;
      if (element && u.effect !== element && !u.elementChoice?.includes(element)) return false;
      if (source && u.sourceInfo?.kind !== source) return false;
      if (cells && String(u.pattern.cells.length) !== cells && !(cells === '7+' && u.pattern.cells.length >= 7)) return false;
      if (onlyStack && !isStackable(u)) return false;
      if (onlySpatial && !isSpatial(u)) return false;
      if (onlyCommented && !(EDITOR_MODE ? effectiveComment(data.comments, local, u.id).comment : data.comments.upgrades[u.id])) return false;
      if (q) {
        const c = (EDITOR_MODE ? effectiveComment(data.comments, local, u.id).comment : data.comments.upgrades[u.id])?.text ?? '';
        const hay = [l(u.name), u.name.en, u.key, l(u.desc), l(u.sourceInfo?.text), c, ...gs.map((g) => l(g.name))].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const gearName = (u: Upgrade) => l(gearsOf(u)[0]?.name) || '~';
    res.sort((a, b) => {
      if (sort === 'name') return l(a.name).localeCompare(l(b.name), lang);
      if (sort === 'gear') return gearName(a).localeCompare(gearName(b), lang) || a.rarity - b.rarity || l(a.name).localeCompare(l(b.name), lang);
      return a.rarity - b.rarity || l(a.name).localeCompare(l(b.name), lang);
    });
    return res;
  }, [data, all, query, cat, gearId, rarities, element, source, cells, onlyStack, onlySpatial, onlyCommented, sort, gearsById, local, l, lang]);

  if (!data) return null;
  const elements = [...new Set(all.flatMap((u) => [u.effect, ...(u.elementChoice ?? [])]))].sort((a, b) =>
    (l(data.game.effects[a]) || a).localeCompare(l(data.game.effects[b]) || b, lang),
  );
  const localCount = Object.keys(local).length;
  const reset = () => setLimit(PAGE);

  const downloadComments = () => {
    const merged = mergedComments(data.comments, local);
    const file = {
      _readme:
        'Comments on upgrades shown on the site. Key = upgrade id; "key" is the internal name for readability. Edit here or in the site (then use "Download comments.json" and replace this file).',
      ...merged,
    };
    const blob = new Blob([JSON.stringify(file, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'comments.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  return (
    <div className="mods-page">
      <div className="mods-filters panel">
        <div className="mods-found">{t('mpFound', { n: list.length })}</div>
        <input className="search" placeholder={t('search')} value={query} onChange={(e) => (setQuery(e.target.value), reset())} />
        <select value={cat} onChange={(e) => (setCat(e.target.value as Cat), setGearId(''), reset())} title={t('mpCategory')}>
          {CATS.map((c) => (
            <option key={c} value={c}>
              {c === 'all' ? t('mpAllCats') : c === 'common' ? t('mpCommonChars') : c === 'expanders' ? t('expanders') : t(`cat_${c}` as const)}
            </option>
          ))}
        </select>
        <select value={gearId} onChange={(e) => (setGearId(e.target.value), reset())} title={t('mpGear')}>
          <option value="">{t('mpAllGear')}</option>
          {gearOptions.map((g) => (
            <option key={g.id} value={g.id}>
              {g.category === 'global' ? t('mpCommonChars') : l(g.name)}
            </option>
          ))}
        </select>
        <div className="rarity-filter">
          {data.game.rarities
            .filter((r) => all.some((u) => u.rarity === r.id))
            .map((r) => (
              <button
                key={r.id}
                title={l(r.name)}
                className={rarities.has(r.id) ? 'on' : ''}
                style={{ ['--rc' as string]: r.color }}
                onClick={() => {
                  const n = new Set(rarities);
                  if (n.has(r.id)) n.delete(r.id);
                  else n.add(r.id);
                  setRarities(n);
                  reset();
                }}
              />
            ))}
        </div>
        <select value={element} onChange={(e) => (setElement(e.target.value), reset())} title={t('element')}>
          <option value="">
            {t('element')}: {t('anyElement')}
          </option>
          {elements.map((e) => (
            <option key={e} value={e}>
              {l(data.game.effects[e]) || e}
            </option>
          ))}
        </select>
        <select value={source} onChange={(e) => (setSource(e.target.value), reset())} title={t('mpSource')}>
          <option value="">{t('mpAnySource')}</option>
          {SOURCES.map((s) => (
            <option key={s} value={s}>
              {t(`src_${s}` as const)}
            </option>
          ))}
        </select>
        <select value={cells} onChange={(e) => (setCells(e.target.value), reset())} title={t('mpCells')}>
          <option value="">{t('mpCells')}: {t('anyElement')}</option>
          {['1', '2', '3', '4', '5', '6', '7+'].map((c) => (
            <option key={c} value={c}>
              ⬡ {c}
            </option>
          ))}
        </select>
        <label className="small">
          <input type="checkbox" checked={onlyStack} onChange={(e) => (setOnlyStack(e.target.checked), reset())} /> ×∞ {t('mpStackOnly')}
        </label>
        <label className="small">
          <input type="checkbox" checked={onlySpatial} onChange={(e) => (setOnlySpatial(e.target.checked), reset())} /> ◈ {t('mpSpatialOnly')}
        </label>
        <label className="small">
          <input type="checkbox" checked={onlyCommented} onChange={(e) => (setOnlyCommented(e.target.checked), reset())} /> 💬 {t('mpOnlyCommented')}
        </label>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} title={t('mpSort')}>
          <option value="rarity">{t('mpSort')}: {t('mpSortRarity')}</option>
          <option value="name">{t('mpSort')}: {t('mpSortName')}</option>
          <option value="gear">{t('mpSort')}: {t('mpSortGear')}</option>
        </select>
        {EDITOR_MODE && (
          <button onClick={downloadComments} title={t('cmExportHint')}>
            ⭳ {t('cmExport')}
          </button>
        )}
        {EDITOR_MODE && localCount > 0 && (
          <span className="warn small">
            {t('cmLocalCount', { n: localCount })}{' '}
            <button className="link small" onClick={() => window.confirm(t('cmDiscard') + '?') && useComments.getState().clearLocal()}>
              {t('cmDiscard')}
            </button>
          </span>
        )}
      </div>

      <div className="mods-results">
      <ul className="mods-grid">
        {list.slice(0, limit).map((u) => (
          <ModCard key={u.id} u={u} gears={u.gears.map((id) => gearsById.get(id)).filter((g): g is Gear => !!g)} />
        ))}
      </ul>
      {list.length > limit && (
        <button className="more" onClick={() => setLimit(limit + PAGE)}>
          {t('mpMore', { n: list.length - limit })}
        </button>
      )}
      </div>
    </div>
  );
}

const ModCard = memo(function ModCard({ u, gears }: { u: Upgrade; gears: Gear[] }) {
  const { t, l, lang } = useT();
  const data = useBuild((s) => s.data)!;
  const color = rarityColor(u.rarity);
  const rarity = data.game.rarities.find((r) => r.id === u.rarity);
  const rows = statRows(u, data.game.statLabels, data.overrides.fields, lang);

  const open = (g: Gear) => {
    const target = g.category === 'global' ? data.game.gears.find((x) => x.category === 'character') : g;
    if (!target) return;
    useBuild.getState().setGear(target.id);
    useBuild.getState().inspect(u.id);
    navigate('builder');
  };

  return (
    <li className="mod-card" style={{ ['--rc' as string]: color }}>
      <div className="mod-head">
        <div className="icon">{u.icon && <img src={iconUrl(u.icon)} alt="" loading="lazy" />}</div>
        <div className="mod-title">
          <h3>{l(u.name)}</h3>
          <div className="meta small">
            <span style={{ color }}>{l(rarity?.name)}</span>
            {u.effect !== 'normal' && <span> · {l(data.game.effects[u.effect]) || u.effect}</span>}
            <span className="muted"> · ⬡{u.pattern.cells.length}</span>
            {isStackable(u) && <span title={t('stackable')}> · ×∞</span>}
            {isSpatial(u) && <span title={t('spatial')}> · ◈</span>}
            {u.elementChoice && (
              <span title={t('elHint')}>
                {' · '}
                {u.elementChoice.map((e) => (
                  <span key={e} className="el-dot" style={{ background: elementColor(e) }} title={l(data.game.effects[e]) || e} />
                ))}
              </span>
            )}
          </div>
        </div>
        <PatternPreview upgrade={u} size={9} className="mod-pattern" />
      </div>
      <div className="mod-gears">
        {u.role === 'gridExpander' ? (
          <span className="chip">{t('mpAllGear')}</span>
        ) : (
          gears.map((g) => (
            <button key={g.id} className="chip" onClick={() => open(g)} title={t('mpOpen')}>
              {g.icon && <img src={iconUrl(g.icon)} alt="" />}
              {g.category === 'global' ? t('mpCommonChars') : l(g.name)}
            </button>
          ))
        )}
      </div>
      {u.desc && (
        <p className="desc small">
          <RichText text={l(u.desc)} />
        </p>
      )}
      <SourceLine u={u} />
      {rows.length > 0 && (
        <table className="mod-stats small">
          <tbody>
            {rows.map((r) => (
              <tr key={r.path}>
                <td>{r.label}</td>
                <td className="val">{r.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <CommentBox u={u} compact />
    </li>
  );
});
