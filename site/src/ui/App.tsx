import { useEffect } from 'react';
import { loadData } from '../data/load';
import { useBuild } from '../store/build';
import { useDrag } from '../store/drag';
import { BuildHeader } from './BuildHeader';
import { Catalog } from './Catalog';
import { Details } from './Details';
import { GearPicker } from './GearPicker';
import { HexBoard } from './HexBoard';
import { PatternPreview } from './PatternPreview';
import { useT } from './hooks';
import { useDragController } from './useDragController';

export function App() {
  const data = useBuild((s) => s.data);
  const loadError = useBuild((s) => s.loadError);
  const { t } = useT();

  useEffect(() => {
    loadData()
      .then((d) => useBuild.getState().setData(d))
      .catch((e: unknown) => useBuild.getState().setLoadError(String(e)));
  }, []);

  if (loadError)
    return (
      <div className="splash error">
        <h2>{t('loadError')}</h2>
        <pre>{loadError}</pre>
      </div>
    );
  if (!data) return <div className="splash">{t('loading')}</div>;
  return <Main />;
}

function Main() {
  useDragController();
  const dragging = useDrag((s) => s.active);
  return (
    <div className={`app ${dragging ? 'is-dragging' : ''}`}>
      <TopBar />
      <GearPicker />
      <main className="workspace">
        <BuildHeader />
        <HexBoard />
        <Details />
      </main>
      <Catalog />
      <DragLayer />
      <Toast />
    </div>
  );
}

function TopBar() {
  const accountLevel = useBuild((s) => s.accountLevel);
  const setAccountLevel = useBuild((s) => s.setAccountLevel);
  const lang = useBuild((s) => s.lang);
  const meta = useBuild((s) => s.data?.game.meta);
  const { t } = useT();
  return (
    <header className="topbar">
      <div className="brand">
        <span className="logo">⬢</span>
        <b>{t('appTitle')}</b>
        <span className="muted">{t('appSubtitle')}</span>
      </div>
      <label className="level" title={t('accountLevelHint')}>
        <span>{t('accountLevel')}</span>
        <input type="number" min={1} max={999} value={accountLevel} onChange={(e) => setAccountLevel(Number(e.target.value))} />
      </label>
      <span className="muted small grow">{meta && t('dataInfo', { date: meta.extractedAt.slice(0, 10) })}</span>
      <button className="lang" onClick={() => useBuild.getState().setLang(lang === 'ru' ? 'en' : 'ru')}>
        {t('langSwitch')}
      </button>
    </header>
  );
}

/** Pattern following the cursor while dragging outside the board. */
function DragLayer() {
  const d = useDrag();
  const u = useBuild((s) => (d.upgradeId ? s.data?.game.upgrades[d.upgradeId] : undefined));
  if (!d.active || !u || d.target) return null;
  return (
    <div className="drag-layer" style={{ left: d.x, top: d.y }}>
      <PatternPreview upgrade={u} rotation={d.rotation} size={16} highlightIndex={d.grabIndex} />
    </div>
  );
}

function Toast() {
  const toast = useBuild((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => useBuild.setState({ toast: null }), 2600);
    return () => clearTimeout(id);
  }, [toast]);
  return toast ? <div className="toast">{toast.text}</div> : null;
}
