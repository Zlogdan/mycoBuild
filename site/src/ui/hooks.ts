import { useCallback, useMemo } from 'react';
import { translate, loc, type TKey } from '../i18n';
import type { Loc } from '../core/types';
import { boardContext, useBuild, useCurrentGear, useGearLevel } from '../store/build';
import type { BoardContext } from '../core/placement';

export function useT() {
  const lang = useBuild((s) => s.lang);
  const t = useCallback((key: TKey, params?: Record<string, string | number>) => translate(lang, key, params), [lang]);
  const l = useCallback((x: Loc | null | undefined) => loc(x, lang), [lang]);
  return { t, l, lang };
}

export function useBoardContext(): BoardContext | null {
  const data = useBuild((s) => s.data);
  const gear = useCurrentGear();
  const accountLevel = useBuild((s) => s.accountLevel);
  const gearLevel = useGearLevel();
  return useMemo(
    () => (data && gear ? boardContext(data, gear, accountLevel, gearLevel) : null),
    [data, gear, accountLevel, gearLevel],
  );
}
