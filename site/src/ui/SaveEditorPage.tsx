import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { Gear, Loc, Upgrade } from '../core/types';
import { canInfuse, infuseDonors } from '../core/placement';
import { isGridExpander } from '../core/rules';
import { statRows } from '../core/stats';
import { SaveDoc, expandDirection, findSeed, rollUpgrade, type RollSteps, type SaveInstanceInfo } from '../core/save/editor';
import { accountLevelFromMask, seededElement } from '../core/save/savegame';
import { placementsToSlot, slotToPlacements } from '../core/save/equip';
import { StaticBoard } from './StaticBoard';
import { navigate } from './route';
import { DATA_BASE, iconUrl } from '../data/load';
import { loc } from '../i18n';
import { boardContext, buildKey, newUid, useBuild } from '../store/build';
import { elementColor, rarityColor } from './colors';
import { useT } from './hooks';

interface EditorData {
  skins: Record<string, { id: string; key: string; name: Loc; rarity: number; icon: string | null; gears: string[] }>;
  resources: { key: string; name: Loc; desc: Loc | null; max: number; item: boolean; rarity: number; hidden: boolean; icon: string | null }[];
  items: { key: string; gear: string | null; rarity: number; icon: string | null }[];
  excludedUpgrades: Record<string, { id: string; key: string; name: Loc; rarity: number; cells: number; icon: string | null }>;
  rollSteps: RollSteps;
}

const TXT = {
  ru: {
    title: 'Редактор сохранений',
    intro: 'Файл обрабатывается только в вашем браузере и никуда не отправляется. После правок скачайте новый файл и положите его вместо старого.',
    where: 'Где лежит сейв',
    pick: 'Открыть PlayerData.saxon',
    drop: 'или перетащите файл сюда',
    rules: [
      'Закройте игру перед заменой файла, иначе она перезапишет его своим.',
      'Сделайте копию исходного файла. Рекомендуется править отдельный профиль, а не основной.',
      'При конфликте облачного сохранения Steam выберите локальную версию.',
      'Если игра не сможет прочитать файл, она молча загрузит свой бэкап из папки Backups.',
    ],
    download: 'Скачать изменённый сейв',
    changes: 'изменений',
    close: 'Закрыть файл',
    tabGear: 'Снаряжение',
    tabRes: 'Ресурсы и предметы',
    tabMods: 'Моды',
    tabSkins: 'Скины',
    account: 'Уровень аккаунта',
    accountHint: 'сумма уровней персонажей − 4',
    rotations: 'Повороты модов открыты для всех редкостей',
    allLevel: 'Всем до уровня',
    unlockAll: 'Открыть всё снаряжение',
    apply: 'Применить',
    level: 'Уровень',
    state: ['Не найдено', 'Найдено', 'Открыто'],
    resources: 'Ресурсы',
    items: 'Допуски персонажей',
    max: 'макс.',
    allMax: 'Все ресурсы на максимум',
    gear: 'Снаряжение',
    owned: 'Экземпляры',
    none: 'Нет экземпляров',
    quality: 'качество',
    worst: 'худший ролл',
    best: 'Лучший ролл',
    target: 'Целевое качество',
    setTarget: 'Подобрать',
    seed: 'Seed',
    setSeed: 'Задать',
    element: 'Стихия',
    pattern: 'Паттерн (Pattern Infuser)',
    own: 'Свой',
    add: 'Добавить мод',
    addBtn: 'Выдать',
    count: 'Копий',
    search: 'Поиск по названию',
    any: 'любая',
    expand: 'Расширение',
    column: 'столбец',
    row: 'строка',
    statsNote: 'Значения посчитаны по seed так же, как это делает игра.',
    skinsOf: 'Скины снаряжения',
    giveAll: 'Выдать все отсутствующие',
    have: 'есть',
    give: 'Выдать',
    stored: 'хранится в',
    error: 'Ошибка',
    globalSkins: 'Общие скины',
    universal: 'общий',
    tabEquip: 'Экипировка',
    slotNames: ['Текущий', 'Лоадаут 1', 'Лоадаут 2', 'Лоадаут 3'],
    toBuilder: 'Открыть в конструкторе',
    fromBuilder: 'Взять из конструктора',
    clear: 'Очистить',
    grantMissing: 'Выдавать недостающие моды (лучшие роллы)',
    empty: 'Пусто',
    mods: 'модов',
    written: 'Записано модов: {w}, выдано новых: {g}',
    notFound: 'Нет подходящих экземпляров: {list} — включите выдачу недостающих',
    builderEmpty: 'В этом слоте конструктора пусто',
    equipHint: 'Конструктор хранит свои слоты для каждого снаряжения: соберите билд в нужном слоте, затем возьмите его сюда. «Открыть в конструкторе» копирует слот сейва в тот же слот конструктора.',
    unreadable: 'Не прочитано: {n}',
  },
  en: {
    title: 'Save editor',
    intro: 'The file is processed only in your browser and never uploaded. After editing, download the new file and put it in place of the old one.',
    where: 'Where the save is',
    pick: 'Open PlayerData.saxon',
    drop: 'or drop the file here',
    rules: [
      'Close the game before replacing the file, otherwise it overwrites it with its own.',
      'Keep a copy of the original. Editing a separate profile rather than the main one is recommended.',
      'On a Steam Cloud conflict choose the local version.',
      'If the game cannot read the file it silently loads its own backup from the Backups folder.',
    ],
    download: 'Download the edited save',
    changes: 'changes',
    close: 'Close file',
    tabGear: 'Gear',
    tabRes: 'Resources & items',
    tabMods: 'Upgrades',
    tabSkins: 'Skins',
    account: 'Account level',
    accountHint: 'sum of character levels − 4',
    rotations: 'Upgrade rotation unlocked for every rarity',
    allLevel: 'Set all to level',
    unlockAll: 'Unlock all gear',
    apply: 'Apply',
    level: 'Level',
    state: ['Not found', 'Found', 'Unlocked'],
    resources: 'Resources',
    items: 'Employee authorizations',
    max: 'max',
    allMax: 'All resources to max',
    gear: 'Gear',
    owned: 'Instances',
    none: 'No instances',
    quality: 'quality',
    worst: 'worst roll',
    best: 'Best roll',
    target: 'Target quality',
    setTarget: 'Find',
    seed: 'Seed',
    setSeed: 'Set',
    element: 'Element',
    pattern: 'Pattern (Pattern Infuser)',
    own: 'Own',
    add: 'Add upgrade',
    addBtn: 'Grant',
    count: 'Copies',
    search: 'Search by name',
    any: 'any',
    expand: 'Expansion',
    column: 'column',
    row: 'row',
    statsNote: 'Values are computed from the seed the same way the game does.',
    skinsOf: 'Skins of',
    giveAll: 'Grant all missing',
    have: 'owned',
    give: 'Grant',
    stored: 'stored in',
    error: 'Error',
    globalSkins: 'Shared skins',
    universal: 'shared',
    tabEquip: 'Equipment',
    slotNames: ['Current', 'Loadout 1', 'Loadout 2', 'Loadout 3'],
    toBuilder: 'Open in builder',
    fromBuilder: 'Take from builder',
    clear: 'Clear',
    grantMissing: 'Grant missing upgrades (best rolls)',
    empty: 'Empty',
    mods: 'upgrades',
    written: 'Written: {w} upgrades, newly granted: {g}',
    notFound: 'No matching instances: {list} - enable granting missing upgrades',
    builderEmpty: 'This builder slot is empty',
    equipHint: 'The builder keeps its own slots for every gear: build in the slot you want, then take it here. "Open in builder" copies the save slot into the same builder slot.',
    unreadable: 'Not read: {n}',
  },
} as const;

type Tab = 'gear' | 'res' | 'mods' | 'equip' | 'skins';

interface EditorState {
  extra: EditorData | null;
  doc: SaveDoc | null;
  fileName: string;
  version: number;
  changes: number;
  error: string | null;
  tab: Tab;
}
const useSaveEditor = create<EditorState>()(() => ({
  extra: null, doc: null, fileName: 'PlayerData.saxon', version: 0, changes: 0, error: null, tab: 'gear',
}));
const CATS = ['character', 'primary', 'throwable', 'heavy'] as const;

export function SaveEditorPage() {
  const data = useBuild((s) => s.data);
  const { lang, l } = useT();
  const T = lang === 'ru' ? TXT.ru : TXT.en;
  // the opened save lives outside the page, so it survives switching to the builder and back
  const { extra, doc, fileName, version, changes, error, tab } = useSaveEditor();
  const set = useSaveEditor.setState;
  const setExtra = (v: EditorData) => set({ extra: v });
  const setDoc = (v: SaveDoc | null) => set({ doc: v });
  const setFileName = (v: string) => set({ fileName: v });
  const setVersion = (f: (v: number) => number) => set((s) => ({ version: f(s.version) }));
  const setChanges = (v: number | ((c: number) => number)) => set((s) => ({ changes: typeof v === 'function' ? v(s.changes) : v }));
  const setError = (v: string | null) => set({ error: v });
  const setTab = (v: Tab) => set({ tab: v });

  useEffect(() => {
    if (extra) return;
    fetch(`${DATA_BASE}saveeditor.json`, { cache: 'no-cache' })
      .then((r) => r.json())
      .then(setExtra)
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const edit = useCallback((fn: (d: SaveDoc) => void) => {
    if (!doc) return;
    try {
      fn(doc);
      setChanges((c) => c + 1);
      setVersion((v) => v + 1);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, [doc]);

  const open = async (file: File) => {
    try {
      const d = new SaveDoc(new Uint8Array(await file.arrayBuffer()));
      setDoc(d);
      setFileName(file.name);
      setChanges(0);
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  const download = () => {
    if (!doc) return;
    try {
      const bytes = doc.save();
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setDoc(new SaveDoc(bytes)); // continue editing the written state
      setVersion((v) => v + 1);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  if (!data || !extra) return <div className="save-editor"><p className="muted">…</p>{error && <p className="issue">{error}</p>}</div>;

  return (
    <div className="save-editor">
      <h2>{T.title}</h2>
      {!doc ? (
        <OpenFile T={T} onFile={open} />
      ) : (
        <>
          <div className="se-bar">
            <b>{fileName}</b>
            <span className="muted">{changes} {T.changes}</span>
            <button className="primary" onClick={download}>⬇ {T.download}</button>
            <button onClick={() => setDoc(null)}>{T.close}</button>
          </div>
          <div className="seg se-tabs">
            {(['gear', 'res', 'mods', 'equip', 'skins'] as Tab[]).map((k) => (
              <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                {k === 'gear' ? T.tabGear : k === 'res' ? T.tabRes : k === 'mods' ? T.tabMods : k === 'equip' ? T.tabEquip : T.tabSkins}
              </button>
            ))}
          </div>
          {error && <p className="issue">{T.error}: {error}</p>}
          {tab === 'gear' && <GearTab key={version} doc={doc} T={T} edit={edit} />}
          {tab === 'res' && <ResourcesTab key={version} doc={doc} T={T} edit={edit} extra={extra} />}
          {tab === 'mods' && <ModsTab version={version} doc={doc} T={T} edit={edit} extra={extra} />}
          {tab === 'equip' && <EquipTab version={version} doc={doc} T={T} edit={edit} extra={extra} />}
          {tab === 'skins' && <SkinsTab version={version} doc={doc} T={T} edit={edit} extra={extra} l={l} />}
        </>
      )}
    </div>
  );
}

type TT = (typeof TXT)['ru'] | (typeof TXT)['en'];
type Edit = (fn: (d: SaveDoc) => void) => void;

function OpenFile({ T, onFile }: { T: TT; onFile: (f: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div
      className={`se-open ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      <p>{T.intro}</p>
      <p>
        <b>{T.where}:</b> <code>%USERPROFILE%\AppData\LocalLow\Pigeons at Play\Mycopunk\Profiles\default\</code>
        <span className="muted"> (…\default\PlayerData.saxon — default profile, …\default\&lt;profile&gt;\PlayerData.saxon — others)</span>
      </p>
      <ul className="small">{T.rules.map((r) => <li key={r}>{r}</li>)}</ul>
      <button className="primary" onClick={() => input.current?.click()}>{T.pick}</button> <span className="muted">{T.drop}</span>
      <input ref={input} type="file" accept=".saxon" hidden onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </div>
  );
}

/* ---------------- gear ---------------- */

function GearTab({ doc, T, edit }: { doc: SaveDoc; T: TT; edit: Edit }) {
  const data = useBuild((s) => s.data)!;
  const { l } = useT();
  const saved = new Map(doc.gears().map((g) => [g.id, g]));
  const [bulk, setBulk] = useState(32);
  const gears = data.game.gears.filter((g) => (CATS as readonly string[]).includes(g.category) && saved.has(g.id));
  const chars = gears.filter((g) => g.category === 'character');
  const account = chars.reduce((s, g) => s + (saved.get(g.id)?.level ?? 0), 0) - (chars.length - 1);
  return (
    <div className="se-panel">
      <div className="se-row wrap">
        <span>{T.account}: <b>{account}</b> <span className="muted small">({T.accountHint})</span></span>
        <label>
          <input type="checkbox" checked={(doc.rotationMask & 15) === 15} onChange={(e) => edit((d) => (d.rotationMask = e.target.checked ? 15 : 0))} /> {T.rotations}
        </label>
      </div>
      <div className="se-row wrap">
        <span>{T.allLevel}</span>
        <input type="number" min={1} max={999} value={bulk} onChange={(e) => setBulk(Math.max(1, Number(e.target.value) || 1))} />
        <button onClick={() => edit((d) => gears.forEach((g) => g.category !== 'heavy' && d.setGear(g.id, { level: bulk })))}>{T.apply}</button>
        <button onClick={() => edit((d) => gears.forEach((g) => d.setGear(g.id, { unlock: 2 })))}>{T.unlockAll}</button>
      </div>
      {CATS.map((cat) => (
        <div key={cat} className="se-gear-group">
          {gears.filter((g) => g.category === cat).map((g) => {
            const s = saved.get(g.id)!;
            return (
              <div key={g.id} className="se-gear">
                {g.icon && <img src={iconUrl(g.icon)} alt="" />}
                <span className="name">{l(g.name)}</span>
                <select value={s.unlock} onChange={(e) => edit((d) => d.setGear(g.id, { unlock: Number(e.target.value) }))}>
                  {T.state.map((n, i) => <option key={i} value={i}>{n}</option>)}
                </select>
                {g.category !== 'heavy' && (
                  <label className="small">
                    {T.level}{' '}
                    <input type="number" min={1} max={999} defaultValue={s.level}
                      onBlur={(e) => Number(e.target.value) !== s.level && edit((d) => d.setGear(g.id, { level: Math.max(1, Number(e.target.value) || 1) }))} />
                  </label>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------------- resources ---------------- */

function ResourcesTab({ doc, T, edit, extra }: { doc: SaveDoc; T: TT; edit: Edit; extra: EditorData }) {
  const { l } = useT();
  const data = useBuild((s) => s.data)!;
  const res = doc.rootDictInt('resources');
  const items = doc.rootDictInt('items');
  return (
    <div className="se-panel">
      <div className="se-row"><button onClick={() => edit((d) => extra.resources.forEach((r) => d.setRootDictInt('resources', r.key, r.max)))}>{T.allMax}</button></div>
      <h4>{T.resources}</h4>
      <div className="se-res">
        {extra.resources.map((r) => (
          <label key={r.key} className="se-res-item" title={l(r.desc ?? undefined) || r.key} style={{ ['--rc' as string]: rarityColor(r.rarity) }}>
            {r.icon ? <img src={iconUrl(r.icon)} alt="" /> : <span className="dot" />}
            <span className="name">{l(r.name).replace(/<[^>]+>/g, '')}</span>
            <input type="number" min={0} defaultValue={res.get(r.key) ?? 0}
              onBlur={(e) => Number(e.target.value) !== (res.get(r.key) ?? 0) && edit((d) => d.setRootDictInt('resources', r.key, Math.max(0, Number(e.target.value) || 0)))} />
            <span className="muted small">{T.max} {r.max}</span>
          </label>
        ))}
      </div>
      <h4>{T.items}</h4>
      <div className="se-res">
        {extra.items.map((it) => {
          const g = data.game.gears.find((x) => x.id === it.gear);
          return (
            <label key={it.key} className="se-res-item">
              <input type="checkbox" checked={(items.get(it.key) ?? 0) > 0} onChange={(e) => edit((d) => d.setRootDictInt('items', it.key, e.target.checked ? 1 : 0))} />
              <span className="name">{g ? l(g.name) : it.key}</span>
              <span className="muted small">{it.key}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- upgrades ---------------- */

function useNames(extra: EditorData) {
  const data = useBuild((s) => s.data)!;
  const { l } = useT();
  return useCallback(
    (id: string) => {
      const u = data.game.upgrades[id];
      if (u) return { name: l(u.name), rarity: u.rarity, icon: u.icon };
      const s = extra.skins[id] ?? extra.excludedUpgrades[id];
      if (s) return { name: l(s.name), rarity: s.rarity, icon: s.icon };
      return { name: `#${id}`, rarity: 0, icon: null };
    },
    [data, extra, l],
  );
}

function GearSelect({ value, onChange, withPlayer }: { value: string; onChange: (id: string) => void; withPlayer?: boolean }) {
  const data = useBuild((s) => s.data)!;
  const { l } = useT();
  const gears = data.game.gears.filter((g) => (CATS as readonly string[]).includes(g.category) || (withPlayer && g.category === 'global'));
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {gears.map((g) => <option key={g.id} value={g.id}>{l(g.name)}</option>)}
    </select>
  );
}

function ModsTab({ doc, T, edit, extra, version }: { doc: SaveDoc; T: TT; edit: Edit; extra: EditorData; version: number }) {
  const data = useBuild((s) => s.data)!;
  const { l } = useT();
  const names = useNames(extra);
  const [gearId, setGearId] = useState(data.game.gears.find((g) => g.category === 'character')!.id);
  const [sel, setSel] = useState<number | null>(null);
  const gear = data.game.gears.find((g) => g.id === gearId)!;
  const player = data.game.gears.find((g) => g.category === 'global')!;
  const stores = gear.category === 'character' ? [gear.id, player.id] : [gear.id];
  const list = useMemo(
    () => doc.instances().filter((i) => stores.includes(i.gearId) && !extra.skins[i.upgradeId]),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version, gearId],
  );
  const selected = list.find((i) => i.id === sel) ?? null;
  return (
    <div className="se-panel se-mods">
      <div className="se-row wrap">
        <span>{T.gear}:</span>
        <GearSelect value={gearId} onChange={(id) => { setGearId(id); setSel(null); }} />
        <span className="muted small">{T.owned}: {list.length}</span>
      </div>
      <div className="se-cols">
        <div className="se-list">
          {!list.length && <p className="muted">{T.none}</p>}
          {list.map((i) => {
            const u = data.game.upgrades[i.upgradeId];
            const n = names(i.upgradeId);
            const q = u ? rollUpgrade(u, i.seed, extra.rollSteps) : null;
            const el = u?.elementRoll ? seededElement(u, i.seed) : undefined;
            return (
              <button key={i.id} className={`se-inst ${sel === i.id ? 'on' : ''}`} style={{ ['--rc' as string]: rarityColor(n.rarity) }} onClick={() => setSel(i.id)}>
                {n.icon ? <img src={iconUrl(n.icon)} alt="" /> : <span className="dot" />}
                <span className="name">{n.name}</span>
                {el && <span className="el-dot" style={{ background: elementColor(el) }} />}
                {i.patternFrom && <span className="muted small">⇐ {names(i.patternFrom).name}</span>}
                {u && isGridExpander(u) && <span className="muted small">{expandDirection(i.seed) === 'row' ? '↓' : '→'}</span>}
                {q && q.qualities.length > 0 && <QualityBar q={q.worst} />}
              </button>
            );
          })}
        </div>
        <div className="se-detail">
          {selected ? <InstanceDetail inst={selected} doc={doc} T={T} edit={edit} extra={extra} /> : <AddUpgrade gear={gear} player={player} T={T} edit={edit} extra={extra} />}
          {selected && <button className="se-back" onClick={() => setSel(null)}>+ {T.add}</button>}
        </div>
      </div>
      <p className="muted small">{T.statsNote} {l(gear.name)}</p>
    </div>
  );
}

function QualityBar({ q }: { q: number }) {
  return (
    <span className="se-q" title={`${Math.round(q * 100)}%`}>
      <span style={{ width: `${Math.round(q * 100)}%`, background: q > 0.9 ? 'var(--ok)' : q > 0.5 ? '#e0b84a' : 'var(--accent2)' }} />
    </span>
  );
}

function InstanceDetail({ inst, doc, T, edit, extra }: { inst: SaveInstanceInfo; doc: SaveDoc; T: TT; edit: Edit; extra: EditorData }) {
  const data = useBuild((s) => s.data)!;
  const { l, lang } = useT();
  const u = data.game.upgrades[inst.upgradeId];
  const [target, setTarget] = useState(100);
  const [seedText, setSeedText] = useState(String(inst.seed));
  useEffect(() => setSeedText(String(inst.seed)), [inst.seed]);
  if (!u) return <p className="muted">#{inst.upgradeId}</p>;
  const roll = rollUpgrade(u, inst.seed, extra.rollSteps);
  const el = u.elementRoll ? seededElement(u, inst.seed) : undefined;
  const rows = statRows(roll.upgrade, data.game.statLabels, data.overrides.fields, lang, { element: el, effectName: (k) => loc(data.game.effects[k], lang) || k });
  const donors = infuseDonors(u, Object.values(data.game.upgrades));
  const expand = isGridExpander(u) ? expandDirection(inst.seed) : undefined;
  const reseed = (wish: Parameters<typeof findSeed>[2]) =>
    edit((d) => d.setSeed(inst.rec, findSeed(u, extra.rollSteps, { element: el, expand, ...wish }).seed));
  return (
    <div>
      <h3 style={{ color: rarityColor(u.rarity) }}>{l(u.name)}</h3>
      <p className="small muted">id {inst.id} · {T.seed} {inst.seed} · {T.quality} {Math.round(roll.mean * 100)}% · {T.worst} {Math.round(roll.worst * 100)}%</p>
      <table className="se-stats">
        <tbody>{rows.map((r) => <tr key={r.path}><td>{r.label}</td><td className="val">{r.value}</td></tr>)}</tbody>
      </table>
      <div className="se-row wrap">
        <button className="primary" onClick={() => reseed({ target: 1 })}>★ {T.best}</button>
        <span>{T.target}</span>
        <input type="range" min={0} max={100} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        <span>{target}%</span>
        <button onClick={() => reseed({ target: target / 100 })}>{T.setTarget}</button>
      </div>
      <div className="se-row wrap">
        <span>{T.seed}</span>
        <input value={seedText} onChange={(e) => setSeedText(e.target.value)} />
        <button onClick={() => Number.isFinite(Number(seedText)) && edit((d) => d.setSeed(inst.rec, Number(seedText)))}>{T.setSeed}</button>
      </div>
      {u.elementRoll && u.elementChoice && (
        <div className="se-row wrap">
          <span>{T.element}</span>
          {u.elementChoice.map((e) => (
            <button key={e} className={el === e ? 'on' : ''} onClick={() => edit((d) => d.setSeed(inst.rec, findSeed(u, extra.rollSteps, { element: e, expand }).seed))}>
              <span className="el-dot" style={{ background: elementColor(e) }} /> {l(data.game.effects[e]) || e}
            </button>
          ))}
        </div>
      )}
      {expand && (
        <div className="se-row wrap">
          <span>{T.expand}</span>
          {(['column', 'row'] as const).map((x) => (
            <button key={x} className={expand === x ? 'on' : ''} onClick={() => edit((d) => d.setSeed(inst.rec, findSeed(u, extra.rollSteps, { expand: x }).seed))}>
              {x === 'row' ? `↓ ${T.row}` : `→ ${T.column}`}
            </button>
          ))}
        </div>
      )}
      {donors.length > 0 && (
        <div className="se-row wrap">
          <span>{T.pattern}</span>
          <select value={inst.patternFrom ?? ''}
            onChange={(e) => {
              const d0 = e.target.value ? data.game.upgrades[e.target.value] : null;
              edit((d) => d.setPattern(inst.rec, d0 && canInfuse(u, d0) ? d0.id : null, (d0 ?? u).pattern.cells.length));
            }}>
            <option value="">{T.own} ({u.pattern.cells.length})</option>
            {donors.map((x) => <option key={x.id} value={x.id}>{l(x.name)} ({x.pattern.cells.length})</option>)}
          </select>
        </div>
      )}
      <p className="muted small">{doc ? '' : ''}</p>
    </div>
  );
}

function AddUpgrade({ gear, player, T, edit, extra }: { gear: Gear; player: Gear; T: TT; edit: Edit; extra: EditorData }) {
  const data = useBuild((s) => s.data)!;
  const { l } = useT();
  const [q, setQ] = useState('');
  const [count, setCount] = useState(1);
  const [element, setElement] = useState('');
  const [target, setTarget] = useState(100);
  const [expand, setExpand] = useState<'row' | 'column'>('row');
  const pool = useMemo(() => {
    const ids = new Set(gear.upgrades);
    if (gear.category === 'character') player.upgrades.forEach((id) => ids.add(id));
    const ups = [...ids].map((id) => data.game.upgrades[id]).filter((u): u is Upgrade => !!u && u.role !== 'ability');
    const exp = Object.values(data.game.upgrades).filter((u) => isGridExpander(u));
    return [...ups, ...exp].sort((a, b) => b.rarity - a.rarity || l(a.name).localeCompare(l(b.name)));
  }, [data, gear, player, l]);
  const list = pool.filter((u) => !q || l(u.name).toLowerCase().includes(q.toLowerCase()) || u.key.toLowerCase().includes(q.toLowerCase()));
  const grant = (u: Upgrade) =>
    edit((d) => {
      const store = gear.category === 'character' && (player.upgrades.includes(u.id) || isGridExpander(u)) ? player.id : gear.id;
      const avoid = new Set<number>();
      for (let i = 0; i < count; i++) {
        const el = u.elementRoll && element && u.elementChoice?.includes(element) ? element : undefined;
        const s = findSeed(u, extra.rollSteps, { element: el, expand: isGridExpander(u) ? expand : undefined, target: target / 100, avoid });
        avoid.add(s.seed);
        d.addInstance(store, u.id, s.seed, u.pattern.cells.length);
      }
    });
  return (
    <div>
      <h3>{T.add}</h3>
      <div className="se-row wrap">
        <input placeholder={T.search} value={q} onChange={(e) => setQ(e.target.value)} />
        <label>{T.count} <input type="number" min={1} max={50} value={count} onChange={(e) => setCount(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></label>
      </div>
      <div className="se-row wrap">
        <span>{T.target}</span>
        <input type="range" min={0} max={100} value={target} onChange={(e) => setTarget(Number(e.target.value))} />
        <span>{target}%</span>
        <span>{T.element}</span>
        <select value={element} onChange={(e) => setElement(e.target.value)}>
          <option value="">{T.any}</option>
          {['fire', 'shock', 'acid', 'cryo', 'bees', 'normal'].map((e) => <option key={e} value={e}>{l(data.game.effects[e]) || e}</option>)}
        </select>
        <span>{T.expand}</span>
        <select value={expand} onChange={(e) => setExpand(e.target.value as 'row' | 'column')}>
          <option value="row">{T.row}</option>
          <option value="column">{T.column}</option>
        </select>
      </div>
      <div className="se-add-list">
        {list.map((u) => (
          <div key={u.id} className="se-add" style={{ ['--rc' as string]: rarityColor(u.rarity) }}>
            {u.icon ? <img src={iconUrl(u.icon)} alt="" /> : <span className="dot" />}
            <span className="name" title={l(u.desc ?? undefined)}>{l(u.name)}</span>
            <span className="muted small">{u.pattern.cells.length}⬡</span>
            <button onClick={() => grant(u)}>{T.addBtn}</button>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------- skins ---------------- */

function SkinsTab({ doc, T, edit, extra, version, l }: { doc: SaveDoc; T: TT; edit: Edit; extra: EditorData; version: number; l: (x: Loc | null | undefined) => string }) {
  const data = useBuild((s) => s.data)!;
  const [gearId, setGearId] = useState(data.game.gears.find((g) => g.category === 'primary')!.id);
  const owned = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of doc.instances()) if (extra.skins[i.upgradeId]) m.set(`${i.gearId}:${i.upgradeId}`, (m.get(`${i.gearId}:${i.upgradeId}`) ?? 0) + 1);
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, version]);
  const player = data.game.gears.find((g) => g.category === 'global')!;
  const skins = Object.values(extra.skins).filter((s) => s.gears.includes(gearId));
  const shared = Object.values(extra.skins).filter((s) => s.gears.includes(player.id));
  const give = (ids: string[], store: string) => edit((d) => ids.forEach((id) => d.addInstance(store, id, (Math.random() * 0x7fffffff) | 0, 0)));
  const block = (title: string, list: typeof skins, store: string) => {
    const missing = list.filter((s) => !owned.get(`${store}:${s.id}`)).map((s) => s.id);
    return (
      <div>
        <div className="se-row wrap"><h4>{title}</h4>{missing.length > 0 && <button onClick={() => give(missing, store)}>{T.giveAll} ({missing.length})</button>}</div>
        <div className="se-skins">
          {list.map((s) => {
            const n = owned.get(`${store}:${s.id}`) ?? 0;
            return (
              <div key={s.id} className={`se-skin ${n ? 'have' : ''}`} style={{ ['--rc' as string]: rarityColor(s.rarity) }}>
                {s.icon ? <img src={iconUrl(s.icon)} alt="" /> : <span className="dot" />}
                <span className="name">{l(s.name)}</span>
                {n ? <span className="ok small">✓ {T.have}</span> : <button onClick={() => give([s.id], store)}>{T.give}</button>}
              </div>
            );
          })}
        </div>
      </div>
    );
  };
  return (
    <div className="se-panel">
      <div className="se-row wrap"><span>{T.skinsOf}:</span><GearSelect value={gearId} onChange={setGearId} /></div>
      {block(l(data.game.gears.find((g) => g.id === gearId)!.name), skins, gearId)}
      {shared.length > 0 && block(T.globalSkins, shared, gearId)}
    </div>
  );
}

/* ---------------- equipment ---------------- */

const fmt = (s: string, p: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(p[k] ?? ''));

function EquipTab({ doc, T, edit, extra, version }: { doc: SaveDoc; T: TT; edit: Edit; extra: EditorData; version: number }) {
  const data = useBuild((s) => s.data)!;
  const builds = useBuild((s) => s.builds);
  const [gearId, setGearId] = useState(data.game.gears.find((g) => g.category === 'primary')!.id);
  const [grant, setGrant] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const gear = data.game.gears.find((g) => g.id === gearId)!;
  const player = data.game.gears.find((g) => g.category === 'global')!;
  const level = doc.gears().find((g) => g.id === gearId)?.level ?? 1;
  const account = accountLevelFromMask(doc.rotationMask, false);
  const ctx = useMemo(() => boardContext(data, gear, account, level), [data, gear, account, level]);
  const slots = useMemo(
    () => [0, 1, 2, 3].map((s) => slotToPlacements(doc, gearId, s, (id) => data.game.upgrades[id], newUid)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, version, gearId],
  );
  const toBuilder = (slot: number) => {
    const list = slots[slot].placements;
    useBuild.setState((s) => ({
      builds: { ...s.builds, [buildKey(gearId, slot)]: list },
      slots: { ...s.slots, [gearId]: slot },
      gearLevels: { ...s.gearLevels, [gearId]: level },
      gearId,
    }));
    navigate('builder');
  };
  const fromBuilder = (slot: number) => {
    const list = builds[buildKey(gearId, slot)] ?? [];
    if (!list.length) return setNotice(T.builderEmpty);
    edit((d) => {
      const r = placementsToSlot(d, ctx, gearId, slot, list, {
        gearCategory: gear.category, playerId: player.id, playerUpgrades: player.upgrades, steps: extra.rollSteps, grantMissing: grant,
      });
      setNotice(fmt(T.written, { w: r.written, g: r.granted }) + (r.missing.length ? ' · ' + fmt(T.notFound, { list: r.missing.join(', ') }) : ''));
    });
  };
  return (
    <div className="se-panel">
      <div className="se-row wrap">
        <span>{T.gear}:</span>
        <GearSelect value={gearId} onChange={(id) => { setGearId(id); setNotice(null); }} />
        <label><input type="checkbox" checked={grant} onChange={(e) => setGrant(e.target.checked)} /> {T.grantMissing}</label>
      </div>
      <p className="muted small">{T.equipHint}</p>
      {notice && <p className="small">{notice}</p>}
      <div className="se-slots">
        {slots.map((s, i) => {
          const inBuilder = (builds[buildKey(gearId, i)] ?? []).length;
          return (
            <div key={i} className="se-slot">
              <div className="se-row wrap">
                <b>{T.slotNames[i]}</b>
                <span className="muted small">{s.placements.length ? `${s.placements.length} ${T.mods}` : T.empty}</span>
                {s.issues.length > 0 && <span className="warn small">{fmt(T.unreadable, { n: s.issues.length })}</span>}
              </div>
              <div className="se-board">{s.placements.length > 0 ? <StaticBoard ctx={ctx} placements={s.placements} size={16} /> : <div className="se-board-empty" />}</div>
              <div className="se-row wrap">
                <button disabled={!s.placements.length} onClick={() => toBuilder(i)}>{T.toBuilder}</button>
                <button disabled={!inBuilder} onClick={() => fromBuilder(i)}>{T.fromBuilder}{inBuilder ? ` (${inBuilder})` : ''}</button>
                <button disabled={!s.placements.length} onClick={() => edit((d) => d.setEquips(gearId, i, []))}>{T.clear}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
