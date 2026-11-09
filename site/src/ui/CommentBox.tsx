import { useState } from 'react';
import type { Upgrade } from '../core/types';
import { effectiveComment, useComments } from '../store/comments';
import { useBuild } from '../store/build';
import { RichText } from './RichText';
import { useT } from './hooks';
import { EDITOR_MODE } from './editor';

/** "How to obtain" line, composed from the game's collection source texts. */
export function SourceLine({ u }: { u: Upgrade }) {
  const { t, l } = useT();
  const s = u.sourceInfo;
  if (!s) return null;
  return (
    <p className="source-line small">
      <span className="muted">{t('srcTitle')}:</span> {s.text ? <RichText text={l(s.text)} /> : <span className="muted">{s.kind}</span>}
    </p>
  );
}

/** User comment on an upgrade: shared (comments.json) + local edits stored in the browser. */
export function CommentBox({ u, compact = false }: { u: Upgrade; compact?: boolean }) {
  const { t } = useT();
  const shared = useBuild((s) => s.data?.comments ?? { upgrades: {} });
  const local = useComments((s) => s.local);
  // visitors see only published comments; local edits are shown in editor mode only
  const { comment, edited } = EDITOR_MODE ? effectiveComment(shared, local, u.id) : { comment: shared.upgrades[u.id] ?? null, edited: false };
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const start = () => {
    setDraft(comment?.text ?? '');
    setEditing(true);
  };
  const save = () => {
    useComments.getState().setLocal(u.id, draft.trim() ? { key: u.key, text: draft.trim() } : null);
    setEditing(false);
  };

  if (editing)
    return (
      <div className="comment editing" onPointerDown={(e) => e.stopPropagation()}>
        <textarea autoFocus rows={4} value={draft} placeholder={t('cmPlaceholder')} onChange={(e) => setDraft(e.target.value)} />
        <div className="comment-actions">
          <button className="primary" onClick={save}>
            {t('cmSave')}
          </button>
          <button onClick={() => setEditing(false)}>{t('cmCancel')}</button>
          {comment && (
            <button
              onClick={() => {
                useComments.getState().setLocal(u.id, null);
                setEditing(false);
              }}
            >
              {t('cmDelete')}
            </button>
          )}
        </div>
      </div>
    );

  if (!comment && !EDITOR_MODE) return null;

  if (!comment)
    return compact ? (
      <button className="link small add-comment" onClick={start}>
        + {t('cmAdd')}
      </button>
    ) : (
      <div className="comment empty">
        <button className="link small" onClick={start}>
          + {t('cmAdd')}
        </button>
      </div>
    );

  return (
    <div className="comment">
      <div className="comment-head">
        <span className="muted small">💬 {t('cmTitle')}</span>
        {edited && <span className="warn small">· {t('cmLocal')}</span>}
        {EDITOR_MODE && (
          <button className="link small" onClick={start}>
            {t('cmEdit')}
          </button>
        )}
      </div>
      <p className="comment-text">
        <RichText text={comment.text} />
      </p>
    </div>
  );
}
