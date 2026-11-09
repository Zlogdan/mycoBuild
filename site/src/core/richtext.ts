import type { Keyword, Lang } from './types';

export interface TextSegment {
  text: string;
  color?: string;
  bold?: boolean;
  keyword?: boolean;
}

/**
 * Parses the game's description markup into plain segments (rendered without innerHTML):
 *   <color=#RRGGBB>..</color>, <b>..</b>, <font=..>..</font> (ignored), <sprite ..> (dropped),
 *   [word] / {word}   -> highlighted keyword (coloured by the game's keyword table when known),
 *   <>                -> input binding placeholder (shown as ⌨)
 */
export function parseRichText(src: string, keywords: Keyword[], lang: Lang): TextSegment[] {
  const colorOf = (word: string): string | undefined => {
    const w = word.toLowerCase().trim();
    for (const k of keywords) {
      const list = k.words[lang] ?? k.words.en ?? [];
      if (list.some((x) => x.toLowerCase() === w)) return k.color ?? undefined;
    }
    return undefined;
  };

  const out: TextSegment[] = [];
  const colorStack: string[] = [];
  let bold = 0;
  const re = /<color=([^>]+)>|<\/color>|<b>|<\/b>|<\/?font[^>]*>|<sprite[^>]*>|<\/?[a-z]+(=[^>]*)?>|<>|\[([^\]]+)\]|\{([^}]+)\}/gi;
  let last = 0;
  const push = (text: string, extra: Partial<TextSegment> = {}) => {
    if (!text) return;
    out.push({ text, color: colorStack[colorStack.length - 1], bold: bold > 0 || undefined, ...extra });
  };
  for (let m = re.exec(src); m; m = re.exec(src)) {
    push(src.slice(last, m.index));
    last = m.index + m[0].length;
    const tag = m[0].toLowerCase();
    if (m[1]) colorStack.push(m[1].trim());
    else if (tag === '</color>') colorStack.pop();
    else if (tag === '<b>') bold++;
    else if (tag === '</b>') bold = Math.max(0, bold - 1);
    else if (tag === '<>') push('⌨', { bold: true });
    else if (m[3] || m[4]) {
      const word = (m[3] ?? m[4])!;
      push(word, { keyword: true, color: colorOf(word) ?? colorStack[colorStack.length - 1] ?? 'var(--accent)' });
    }
    // other tags (font, sprite, size, ...) are dropped
  }
  push(src.slice(last));
  return out;
}
