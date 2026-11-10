import type { GearCategory } from '../core/types';
import { iconUrl } from '../data/load';
import { buildKey, useBuild } from '../store/build';
import { useT } from './hooks';

const ORDER = ['character', 'primary', 'heavy', 'throwable', 'special'] as const satisfies readonly GearCategory[];

export function GearPicker() {
  const data = useBuild((s) => s.data);
  const gearId = useBuild((s) => s.gearId);
  const builds = useBuild((s) => s.builds);
  const slots = useBuild((s) => s.slots);
  const setGear = useBuild((s) => s.setGear);
  const { t, l } = useT();
  if (!data) return null;

  return (
    <nav className="panel gear-picker">
      {ORDER.map((cat) => {
        const gears = data.game.gears.filter((g) => g.category === cat);
        if (!gears.length) return null;
        return (
          <div key={cat} className="gear-group">
            <h4>{t(`cat_${cat}` as const)}</h4>
            <ul>
              {gears.map((g) => {
                const n = builds[buildKey(g.id, slots[g.id] ?? 0)]?.length ?? 0;
                return (
                  <li key={g.id}>
                    <button className={`gear-btn ${g.id === gearId ? 'on' : ''}`} onClick={() => setGear(g.id)} title={l(g.name)}>
                      <span className="gear-icon">{g.icon && <img src={iconUrl(g.icon)} alt="" />}</span>
                      <span className="gear-name">{l(g.name)}</span>
                      {n > 0 && <span className="gear-count">{n}</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}
