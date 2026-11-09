import { useMemo } from 'react';
import { parseRichText } from '../core/richtext';
import { useBuild } from '../store/build';
import { useT } from './hooks';

/** Renders game description markup safely (no innerHTML). */
export function RichText({ text }: { text: string }) {
  const keywords = useBuild((s) => s.data?.game.keywords ?? []);
  const { lang } = useT();
  const segs = useMemo(() => parseRichText(text, keywords, lang), [text, keywords, lang]);
  return (
    <span className="rich">
      {segs.map((s, i) =>
        s.text.split('\n').map((line, j, arr) => (
          <span key={`${i}-${j}`}>
            <span
              style={{ color: s.color, fontWeight: s.bold || s.keyword ? 600 : undefined }}
              className={s.keyword ? 'kw' : undefined}
            >
              {line}
            </span>
            {j < arr.length - 1 && <br />}
          </span>
        )),
      )}
    </span>
  );
}
