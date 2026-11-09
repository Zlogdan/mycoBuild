import { useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { evaluate } from '../core/placement';
import { accountLevelFromMask, convertEquips, readSave, type SaveData, type SaveEquip } from '../core/save/savegame';
import { iconUrl } from '../data/load';
import { boardContext, newUid, useBuild } from '../store/build';
import { useAutofill } from '../store/autofill';
import { useT } from './hooks';

interface SaveState {
  save: SaveData | null;
  set: (s: SaveData | null) => void;
}
const useSave = create<SaveState>()((set) => ({ save: null, set: (save) => set({ save }) }));

export function SaveImportButton() {
  const { t } = useT();
  const ref = useRef<HTMLInputElement>(null);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const save = readSave(new Uint8Array(await f.arrayBuffer()));
      useSave.getState().set(save);
    } catch (e) {
      const b = useBuild.getState();
      b.notify(t('svError', { error: e instanceof Error ? e.message : String(e) }));
    }
    if (ref.current) ref.current.value = '';
  };
  return (
    <>
      <button onClick={() => ref.current?.click()} title={t('svHint')}>
        🎮 {t('svButton')}
      </button>
      <input ref={ref} type="file" accept=".saxon" hidden onChange={(e) => onFile(e.target.files?.[0])} />
    </>
  );
}

interface BuildOption {
  label: string;
  equips: SaveEquip[];
  issues: number;
}

/** Choose which build (current or a loadout) of which gear to load from the save. */
export function SaveImportDialog() {
  const { t, l } = useT();
  const save = useSave((s) => s.save);
  const data = useBuild((s) => s.data);
  const [applyLevels, setApplyLevels] = useState(true);

  const account = save ? accountLevelFromMask(save.rotationMask, save.canRotateUpgrades) : 30;
  const rows = useMemo(() => {
    if (!save || !data) return [];
    return save.gears
      .map((g) => {
        const gear = data.game.gears.find((x) => x.id === g.gearId);
        if (!gear || gear.category === 'global') return null;
        const ctx = boardContext(data, gear, account, g.level);
        const options: BuildOption[] = [
          { label: t('svEquipped'), equips: g.equipped },
          ...g.loadouts.map((lo, i) => ({ label: t('svLoadout', { n: i + 1 }), equips: lo })),
        ]
          .filter((o) => o.equips.length > 0)
          .map((o) => {
            let k = 0;
            const conv = convertEquips(o.equips, save, (id) => data.game.upgrades[id], () => `chk${k++}`);
            const st = evaluate(ctx, conv.placements);
            return { ...o, issues: conv.issues.length + st.issues.size };
          });
        return options.length ? { gear, level: g.level, options } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => data.game.gears.indexOf(a.gear) - data.game.gears.indexOf(b.gear));
  }, [save, data, account, t]);

  if (!save || !data) return null;
  const close = () => useSave.getState().set(null);

  const load = (gearId: string, opt: BuildOption) => {
    const b = useBuild.getState();
    const gear = data.game.gears.find((g) => g.id === gearId)!;
    const g = save.gears.find((x) => x.gearId === gearId)!;
    const { placements } = convertEquips(opt.equips, save, (id) => data.game.upgrades[id], newUid);
    const gearLevels = { ...b.gearLevels, [gearId]: g.level };
    if (applyLevels) for (const sg of save.gears) gearLevels[sg.gearId] = sg.level;
    useBuild.setState({
      gearId,
      gearLevels,
      accountLevel: applyLevels ? account : b.accountLevel,
      builds: { ...b.builds, [gearId]: placements },
      selectedUid: null,
      inspectedId: null,
    });
    useAutofill.setState({ preview: null });
    b.notify(t('svLoaded', { gear: l(gear.name), build: opt.label }));
    close();
  };

  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="modal wide" role="dialog" aria-label={t('svTitle')} onClick={(e) => e.stopPropagation()}>
        <h3>{t('svTitle')}</h3>
        <p className="muted small">{t('svAccount', { level: account })}</p>
        <label className="small">
          <input type="checkbox" checked={applyLevels} onChange={(e) => setApplyLevels(e.target.checked)} /> {t('svApplyLevels')}
        </label>
        {rows.length === 0 ? (
          <p className="muted">{t('svNoBuilds')}</p>
        ) : (
          <ul className="save-rows">
            {rows.map((r) => (
              <li key={r.gear.id}>
                <span className="gear-icon">{r.gear.icon && <img src={iconUrl(r.gear.icon)} alt="" />}</span>
                <span className="save-gear">
                  {l(r.gear.name)} <span className="muted small">{t('svLevel', { n: r.level })}</span>
                </span>
                <span className="save-builds">
                  {r.options.map((o) => (
                    <button key={o.label} onClick={() => load(r.gear.id, o)} title={o.issues ? t('svIssues', { n: o.issues }) : undefined}>
                      {o.label} <span className="muted small">({o.equips.length})</span>
                      {o.issues > 0 && <span className="warn"> ⚠</span>}
                    </button>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button onClick={close}>{t('afClose')}</button>
        </div>
      </div>
    </div>
  );
}
