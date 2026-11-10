import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import { toBlob, toPng } from 'html-to-image';
import type { Upgrade } from '../core/types';
import { evaluate } from '../core/placement';
import { statRows } from '../core/stats';
import { iconUrl } from '../data/load';
import { useBuild, useCurrentGear, useGearLevel, usePlacements } from '../store/build';
import { elementColor, rarityColor } from './colors';
import { RichText } from './RichText';
import { StaticBoard } from './StaticBoard';
import { useBoardContext, useT } from './hooks';

interface ShowcaseState {
  open: boolean;
  set: (open: boolean) => void;
}
export const useShowcase = create<ShowcaseState>()((set) => ({ open: false, set: (open) => set({ open }) }));

const SITE = 'zlogdan.github.io/mycoBuild';

/** Full-screen, interface-free card of the current build — for screenshots / PNG export. */
export function Showcase() {
  const open = useShowcase((s) => s.open);
  const data = useBuild((s) => s.data);
  const accountLevel = useBuild((s) => s.accountLevel);
  const gear = useCurrentGear();
  const gearLevel = useGearLevel();
  const placements = usePlacements();
  const ctx = useBoardContext();
  const { t, l, lang } = useT();
  const cardRef = useRef<HTMLDivElement>(null);
  const [showStats, setShowStats] = useState(true);
  const [showDesc, setShowDesc] = useState(false);
  const [busy, setBusy] = useState<'' | 'png' | 'copy'>('');
  const [note, setNote] = useState('');

  // dev-only hook for automated checks of the generated image (not included in production builds)
  useEffect(() => {
    if (!import.meta.env.DEV || !open) return;
    (window as unknown as { __showcasePng?: () => Promise<string> }).__showcasePng = () =>
      toPng(cardRef.current!, { pixelRatio: 2, backgroundColor: '#0b0f0e', cacheBust: false });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useShowcase.getState().set(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // upgrades of the build, copies of the same upgrade (+ same element) grouped
  const entries = useMemo(() => {
    if (!data) return [];
    const map = new Map<string, { u: Upgrade; count: number; element?: string }>();
    for (const p of placements) {
      const u = data.game.upgrades[p.upgradeId];
      if (!u) continue;
      const k = `${u.id}|${p.element ?? ''}`;
      const e = map.get(k);
      if (e) e.count++;
      else map.set(k, { u, count: 1, element: p.element });
    }
    return [...map.values()].sort((a, b) => b.u.rarity - a.u.rarity || l(a.u.name).localeCompare(l(b.u.name), lang));
  }, [data, placements, l, lang]);

  if (!open || !data || !gear || !ctx) return null;
  const state = evaluate(ctx, placements);
  const ability = gear.ability ? data.game.upgrades[gear.ability] : undefined;
  const close = () => useShowcase.getState().set(false);

  const options = { pixelRatio: 2, backgroundColor: '#0b0f0e', cacheBust: false };
  const fileName = `mycobuild-${gear.key}-${new Date().toISOString().slice(0, 10)}.png`;

  const savePng = async () => {
    if (!cardRef.current) return;
    setBusy('png');
    setNote('');
    try {
      const url = await toPng(cardRef.current, options);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
    } catch (e) {
      setNote(t('scError', { error: String(e) }));
    } finally {
      setBusy('');
    }
  };

  const copyPng = async () => {
    if (!cardRef.current) return;
    setBusy('copy');
    setNote('');
    try {
      const blob = await toBlob(cardRef.current, options);
      if (!blob) throw new Error('empty image');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setNote(t('scCopied'));
    } catch (e) {
      setNote(t('scCopyFailed', { error: String(e) }));
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="showcase-backdrop" onClick={close}>
      <div className="showcase-bar" onClick={(e) => e.stopPropagation()}>
        <button className="primary" onClick={savePng} disabled={!!busy}>
          {busy === 'png' ? '…' : '⭳'} {t('scPng')}
        </button>
        <button onClick={copyPng} disabled={!!busy}>
          {busy === 'copy' ? '…' : '⧉'} {t('scCopy')}
        </button>
        <label className="small">
          <input type="checkbox" checked={showStats} onChange={(e) => setShowStats(e.target.checked)} /> {t('scStats')}
        </label>
        <label className="small">
          <input type="checkbox" checked={showDesc} onChange={(e) => setShowDesc(e.target.checked)} /> {t('scDesc')}
        </label>
        {note && <span className="small muted">{note}</span>}
        <span className="grow" />
        <span className="muted small">{t('scHint')}</span>
        <button onClick={close}>✕ {t('afClose')}</button>
      </div>

      <div className="showcase-scroll" onClick={(e) => e.stopPropagation()}>
        <div className="showcase-card" ref={cardRef}>
          <header className="sc-head">
            {gear.icon && <img src={iconUrl(gear.icon)} alt="" />}
            <div className="sc-title">
              <h1>{l(gear.name)}</h1>
              <span className="muted">{t(`cat_${gear.category === 'global' ? 'special' : gear.category}` as const)}</span>
            </div>
            <div className="sc-levels">
              <div>
                <span className="muted">{t('accountLevel')}</span> <b>{accountLevel}</b>
              </div>
              <div>
                <span className="muted">{t('gearLevel')}</span> <b>{gearLevel}</b>
              </div>
              <div>
                <span className="muted">{t('gridSize')}</span>{' '}
                <b>
                  {state.size.w}×{state.size.h}
                </b>
              </div>
            </div>
          </header>
          {ability && (
            <div className="sc-ability">
              {ability.icon && <img src={iconUrl(ability.icon)} alt="" />}
              <span className="muted">{t('ability')}:</span> <b>{l(ability.name)}</b>
            </div>
          )}

          <div className="sc-body">
            <div className="sc-board">
              <StaticBoard ctx={ctx} placements={placements} size={40} />
            </div>
            <ul className="sc-mods">
              {entries.map(({ u, count, element }) => {
                const rows = showStats
                  ? statRows(u, data.game.statLabels, data.overrides.fields, lang, { element, effectName: (k) => l(data.game.effects[k]) || k })
                  : [];
                return (
                  <li key={`${u.id}|${element ?? ''}`} style={{ ['--rc' as string]: rarityColor(u.rarity) }}>
                    <div className="sc-mod-head">
                      {u.icon && <img src={iconUrl(u.icon)} alt="" />}
                      <span className="sc-mod-name">{l(u.name)}</span>
                      {count > 1 && <span className="sc-count">×{count}</span>}
                      {element && (
                        <span className="sc-el">
                          <span className="el-dot" style={{ background: elementColor(element) }} /> {l(data.game.effects[element]) || element}
                        </span>
                      )}
                    </div>
                    {showDesc && u.desc && (
                      <p className="sc-desc">
                        <RichText text={l(u.desc)} />
                      </p>
                    )}
                    {rows.length > 0 && (
                      <table className="sc-stats">
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
                  </li>
                );
              })}
            </ul>
          </div>

          <footer className="sc-foot">
            <span>
              <b>MycoBuild</b> · {t('appSubtitle')}
            </span>
            <span>{SITE}</span>
            <span>Telegram @zlogdan</span>
          </footer>
        </div>
      </div>
    </div>
  );
}
