/**
 * Editor mode: shows comment editing and "Download comments.json".
 * Enabled by opening the site with `?edit` (remembered in this browser), disabled with `?edit=0`.
 * This is not access control — edits only ever live in the editor's own browser; publishing still
 * requires committing comments.json to the repository. It only hides editing UI from visitors.
 */
const KEY = 'mycobuild-editor';

function detect(): boolean {
  let stored = false;
  try {
    stored = localStorage.getItem(KEY) === '1';
  } catch {
    /* storage unavailable */
  }
  const p = new URLSearchParams(window.location.search);
  if (!p.has('edit')) return stored;
  const on = p.get('edit') !== '0';
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
  return on;
}

export const EDITOR_MODE = detect();
