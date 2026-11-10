import type { Lang, StatLabel, StatOverride, Upgrade } from './types';

export interface StatRow {
  path: string; // "<PropertyType>.<field>"
  label: string;
  value: string;
  /** label taken from the game (TextBlocks) vs. override vs. auto-generated from the field name */
  labelSource: 'override' | 'game' | 'auto';
}

type Range = { min: number; max: number };

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRange = (v: unknown): v is Range =>
  !!v && typeof v === 'object' && isNum((v as Range).min) && isNum((v as Range).max);

/** enum OverrideType (Assembly-CSharp): how an OverrideData<T> value is applied to the base stat. */
export const OverrideType = { None: 0, Add: 1, Multiply: 2, Override: 3, OverrideThenAdd: 4 } as const;

interface NumericValue {
  value: number | Range;
  /** OverrideType when the field is OverrideData<T>, undefined for plain values */
  method?: number;
}

/** Unwraps OverrideData<T> ({data, method}) and returns the numeric payload + apply method. */
export function numericValue(v: unknown): NumericValue | null {
  if (isNum(v) || isRange(v)) return { value: v };
  if (v && typeof v === 'object' && 'data' in (v as object)) {
    const inner = numericValue((v as { data: unknown }).data);
    const method = (v as { method?: unknown }).method;
    return inner ? { value: inner.value, method: typeof method === 'number' ? method : inner.method } : null;
  }
  return null;
}

/** 1/x for multipliers shown inversely (e.g. fire interval -> fire rate, StatData.CreateInverse). */
function invert(v: number | Range): number | Range {
  if (isNum(v)) return v === 0 ? v : 1 / v;
  return { min: v.max === 0 ? 0 : 1 / v.max, max: v.min === 0 ? 0 : 1 / v.min };
}

/**
 * Display format for a stat, following StatData.GetValueString in the game:
 *   OverrideType.Add       -> "+value" (with a "%" C# format: "+value×100%")
 *   OverrideType.Multiply  -> "+(value-1)×100%" / "-(1-value)×100%"
 *   OverrideType.Override  -> "value"
 * The type is the one passed to StatData.Create (statLabels[].overrideType) or, for OverrideData<T>
 * fields, the data's own method. StatData.CreateInverse shows a multiplier inverted (fire interval -> rate).
 */
function autoFormat(nv: NumericValue, label: StatLabel | undefined): { value: number | Range; format: string; prefix: string } | null {
  const type = label?.overrideType ?? nv.method;
  const pct = !!label?.format && label.format.includes('%');
  switch (type) {
    case OverrideType.Add:
      return { value: nv.value, format: pct ? 'signedPercent' : 'signed', prefix: '' };
    case OverrideType.Multiply:
      return { value: label?.inverse ? invert(nv.value) : nv.value, format: 'multiplier', prefix: '' };
    case OverrideType.Override:
    case OverrideType.OverrideThenAdd:
      return { value: nv.value, format: pct ? 'percent' : 'number', prefix: '' };
    case OverrideType.None:
      return null; // not applied in game
    default:
      // no type known (plain value without OverrideData): CreateInverse values are multipliers
      if (label?.inverse) return { value: invert(nv.value), format: 'multiplier', prefix: '' };
      return { value: nv.value, format: pct ? 'percent' : 'number', prefix: '' };
  }
}

/** "fireRateMultiplier" -> "Fire rate multiplier" */
export function humanize(field: string): string {
  const s = field
    .replace(/^_+/, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const trim = (n: number) => {
  const r = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100;
  return String(r);
};

function formatScalar(n: number, format: string): string {
  switch (format) {
    case 'multiplier': {
      const d = Math.round((n - 1) * 1000) / 10;
      return `${d >= 0 ? '+' : ''}${trim(d)}%`;
    }
    case 'percent':
      return `${trim(n * 100)}%`;
    case 'signedPercent':
      return `${n >= 0 ? '+' : ''}${trim(n * 100)}%`;
    case 'signed':
      return `${n >= 0 ? '+' : ''}${trim(n)}`;
    case 'seconds':
      return `${trim(n)} s`;
    default:
      return trim(n);
  }
}

export function formatValue(v: number | Range, format: string): string {
  if (isNum(v)) return formatScalar(v, format);
  const a = formatScalar(v.min, format);
  const b = formatScalar(v.max, format);
  return a === b ? a : `${a} … ${b}`;
}

/** enum EffectType values -> keys used in game.json (effects{}) */
const EFFECT_CODES: Record<number, string> = {
  0: 'normal', 1: 'fire', 2: 'shock', 3: 'acid', 4: 'decay', 5: 'immunity', 6: 'yellowresource',
  7: 'rot', 8: 'bees', 9: 'water', 10: 'cryo', 127: 'all',
};
/** Fields holding an EffectType (OverrideData<EffectType> or plain) — shown as an element name, not a number. */
const ELEMENT_FIELD = /^(effect|effectType|element)$/;

export interface StatRowOptions {
  showAll?: boolean;
  /** element chosen for this instance (Placement.element): replaces "All (127)" */
  element?: string;
  /** element key -> display name */
  effectName?: (key: string) => string;
}

/**
 * Human readable stat rows of an upgrade.
 * Label priority: stats.overrides.json > game label (TextBlocks via GetStatData analysis) > humanized field.
 * By default only fields that have a game or manual label are shown (the rest are internal tuning values).
 */
export function statRows(
  u: Upgrade,
  labels: Record<string, StatLabel>,
  overrides: Record<string, StatOverride>,
  lang: Lang,
  optsOrShowAll: boolean | StatRowOptions = false,
): StatRow[] {
  const opts: StatRowOptions = typeof optsOrShowAll === 'boolean' ? { showAll: optsOrShowAll } : optsOrShowAll;
  const showAll = !!opts.showAll;
  const rows: StatRow[] = [];
  for (const prop of u.props) {
    for (const [field, raw] of Object.entries(prop.data)) {
      const path = `${prop.type}.${field}`;
      const ov = overrides[path];
      if (ov?.format === 'hidden') continue;
      const nv = numericValue(raw);
      if (nv === null) continue;
      const gl = labels[path];
      const auto = autoFormat(nv, gl);
      // OverrideType.None: the value is not applied in game -> nothing to show
      if (!auto && !ov?.format) continue;
      const ovLabel = ov?.[lang] || '';
      let label = '';
      let labelSource: StatRow['labelSource'] = 'auto';
      if (ovLabel) {
        label = ovLabel;
        labelSource = 'override';
      } else if (gl?.label?.[lang] || gl?.label?.en) {
        label = (gl.label[lang] || gl.label.en)!;
        labelSource = 'game';
      } else {
        if (!showAll) continue;
        label = humanize(field);
      }
      let value: string;
      if (ELEMENT_FIELD.test(field) && typeof nv.value === 'number' && !ov?.format) {
        const code = nv.value;
        const key = code === 127 && opts.element ? opts.element : EFFECT_CODES[code] ?? String(code);
        value = opts.effectName ? opts.effectName(key) : key;
      } else value = ov?.format ? formatValue(nv.value, ov.format) : auto!.prefix + formatValue(auto!.value, auto!.format);
      rows.push({ path, label, value, labelSource });
    }
  }
  return rows;
}
