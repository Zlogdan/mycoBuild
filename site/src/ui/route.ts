import { useSyncExternalStore } from 'react';

/**
 * Tiny hash router: "#/mods" = all upgrades page, anything else = builder.
 * Build links use "#b=…" and are handled by the builder (useBuildFromHash).
 */
export type Route = 'builder' | 'mods';

const current = (): Route => (window.location.hash.startsWith('#/mods') ? 'mods' : 'builder');

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, current, current);
}

export function navigate(r: Route) {
  if (r === current()) return;
  window.location.hash = r === 'mods' ? '#/mods' : '';
  if (r === 'builder') history.replaceState(null, '', window.location.pathname + window.location.search);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}
