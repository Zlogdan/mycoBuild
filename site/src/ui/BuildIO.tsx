import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  decodeBuildLink,
  encodeBuildLink,
  exportBuild,
  importBuild,
  type BuildFileV1,
  type ImportMessage,
  type ImportResult,
} from '../core/buildfile';
import { loc, translate, type TKey } from '../i18n';
import { boardContext, newUid, useBuild, useGearLevel, usePlacements, useCurrentGear } from '../store/build';
import { useAutofill } from '../store/autofill';
import { useT } from './hooks';
import { SaveImportButton } from './SaveImport';

/* ---------------- logic ---------------- */

function currentFile(): BuildFileV1 | null {
  const b = useBuild.getState();
  const data = b.data;
  const gear = data?.game.gears.find((g) => g.id === b.gearId);
  if (!data || !gear) return null;
  const gearLevel = b.gearLevels[gear.id] ?? 10;
  const ctx = boardContext(data, gear, b.accountLevel, gearLevel);
  const af = useAutofill.getState();
  return exportBuild(data.game, ctx, {
    gear,
    accountLevel: b.accountLevel,
    gearLevel,
    placements: b.builds[gear.id] ?? [],
    autofill: af.selections[gear.id] ?? [],
    autofillOptions: af.options,
  });
}

function runImport(input: string): ImportResult {
  const b = useBuild.getState();
  const data = b.data!;
  const res = importBuild(input, {
    data: data.game,
    boardContext: (g, a, l) => boardContext(data, g, a, l),
    newUid,
  });
  if (res.ok && res.build) {
    const { gear, accountLevel, gearLevel, placements, autofill, autofillOptions } = res.build;
    useBuild.setState({
      gearId: gear.id,
      accountLevel,
      gearLevels: { ...b.gearLevels, [gear.id]: gearLevel },
      builds: { ...b.builds, [gear.id]: placements },
      selectedUid: null,
      inspectedId: null,
    });
    const af = useAutofill.getState();
    useAutofill.setState({
      selections: { ...af.selections, [gear.id]: autofill },
      options: { ...af.options, ...(autofillOptions ?? {}) },
      preview: null,
    });
  }
  return res;
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---------------- dialog state ---------------- */

interface DialogState {
  importResult: ImportResult | null;
  link: string | null;
  set: (p: Partial<Pick<DialogState, 'importResult' | 'link'>>) => void;
}
const useDialog = create<DialogState>()((set) => ({ importResult: null, link: null, set: (p) => set(p) }));

function showImportResult(res: ImportResult) {
  const b = useBuild.getState();
  if (res.ok && res.messages.length === 0) {
    b.notify(translate(b.lang, 'ioLoaded', { gear: loc(res.build!.gear.name, b.lang) || res.build!.gear.key }));
  } else useDialog.getState().set({ importResult: res });
}

/** Opens a build passed in the URL hash (#b=<token>) once data is loaded. */
export function useBuildFromHash() {
  const data = useBuild((s) => s.data);
  useEffect(() => {
    if (!data) return;
    const m = window.location.hash.match(/[#&]b=([^&]+)/);
    if (!m) return;
    // remove the token so a reload does not overwrite later edits
    history.replaceState(null, '', window.location.pathname + window.location.search);
    decodeBuildLink(decodeURIComponent(m[1]))
      .then((json) => showImportResult(runImport(json)))
      .catch((e: unknown) =>
        useDialog.getState().set({ importResult: { ok: false, messages: [{ level: 'error', code: 'invalidJson', params: { detail: String(e) } }] } }),
      );
  }, [data]);
}

/* ---------------- UI ---------------- */

export function BuildIOButtons() {
  const { t } = useT();
  const gear = useCurrentGear();
  const placements = usePlacements();
  const gearLevel = useGearLevel();
  const fileRef = useRef<HTMLInputElement>(null);

  const onExport = () => {
    const f = currentFile();
    if (!f || !gear) return;
    const date = new Date().toISOString().slice(0, 10);
    download(`mycobuild-${gear.key}-lv${gearLevel}-${date}.json`, JSON.stringify(f, null, 2));
  };

  const onLink = async () => {
    const f = currentFile();
    if (!f) return;
    const token = await encodeBuildLink(f);
    const url = `${window.location.origin}${window.location.pathname}#b=${token}`;
    useDialog.getState().set({ link: url });
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const text = await file.text();
    showImportResult(runImport(text));
    if (fileRef.current) fileRef.current.value = '';
  };

  return (
    <div className="io-buttons">
      <button onClick={onExport} disabled={!gear} title={`${t('ioExport')} (${placements.length})`}>
        ⭳ {t('ioExport')}
      </button>
      <button onClick={() => fileRef.current?.click()} title={t('ioDropHint')}>
        ⭱ {t('ioImport')}
      </button>
      <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      <button onClick={onLink} disabled={!gear}>
        🔗 {t('ioLink')}
      </button>
      <SaveImportButton />
    </div>
  );
}

function messageText(m: ImportMessage, lang: 'ru' | 'en'): string {
  const params = { ...(m.params ?? {}) };
  // show the localised upgrade name instead of the internal key
  const U = useBuild.getState().data?.game.upgrades;
  const named = (typeof params.newId === 'string' && U?.[params.newId]) || (typeof params.id === 'string' && U?.[params.id]);
  if (named) params.key = loc(named.name, lang) || named.key;
  if (m.code === 'placementIssue' && typeof params.issue === 'string')
    params.issue = translate(lang, `issue_${params.issue}` as TKey, { level: params.level ?? '' }).trim();
  return translate(lang, `imp_${m.code}` as TKey, params);
}

export function BuildIODialogs() {
  const { t, lang } = useT();
  const { importResult, link, set } = useDialog();
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [link]);

  if (importResult) {
    const title = !importResult.ok ? t('ioImportFailed') : t('ioImportWarnings');
    return (
      <div className="modal-backdrop" onClick={() => set({ importResult: null })}>
        <div className="modal" role="dialog" aria-label={t('ioImportTitle')} onClick={(e) => e.stopPropagation()}>
          <h3 className={importResult.ok ? 'warn' : 'issue'}>{title}</h3>
          <ul className="messages">
            {importResult.messages.map((m, i) => (
              <li key={i} className={m.level === 'error' ? 'issue' : 'warn'}>
                {m.level === 'error' ? '✕ ' : '⚠ '}
                {messageText(m, lang)}
              </li>
            ))}
          </ul>
          <button className="primary" onClick={() => set({ importResult: null })}>
            {t('ioOk')}
          </button>
        </div>
      </div>
    );
  }
  if (link) {
    return (
      <div className="modal-backdrop" onClick={() => set({ link: null })}>
        <div className="modal" role="dialog" aria-label={t('ioLinkTitle')} onClick={(e) => e.stopPropagation()}>
          <h3>{t('ioLinkTitle')}</h3>
          <p className="muted small">{t('ioLinkHint')}</p>
          <textarea className="link-box" readOnly value={link} onFocus={(e) => e.currentTarget.select()} rows={4} />
          <div className="modal-actions">
            <button
              className="primary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(link);
                  setCopied(true);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? `✓ ${t('ioCopied')}` : t('ioCopy')}
            </button>
            <button onClick={() => set({ link: null })}>{t('afClose')}</button>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
