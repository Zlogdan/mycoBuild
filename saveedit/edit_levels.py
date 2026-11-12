"""
Step 1 of the profile editor: unlock all player gear (characters, weapons, grenades), set their level
and unlock rotations for every rarity. Writes a backup first and refuses to touch the default profile.

    python saveedit/edit_levels.py "<...>/Profiles/default/Профиль 2/PlayerData.saxon" --level 20
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import nrbf  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
GAME_JSON = os.path.join(HERE, '..', 'site', 'public', 'data', 'game.json')
CATEGORIES = {'character', 'primary', 'throwable', 'heavy'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('save')
    ap.add_argument('--level', type=int, default=20)
    ap.add_argument('--only', default='character,primary,throwable,heavy', help='comma-separated gear categories')
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()

    path = os.path.abspath(a.save)
    profile_dir = os.path.dirname(path)
    if os.path.basename(profile_dir).lower() == 'default':
        sys.exit('refusing to edit the default profile')

    gears = {g['id']: g for g in json.load(open(GAME_JSON, encoding='utf-8'))['gears']}
    raw = open(path, 'rb').read()
    recs = nrbf.read(raw)
    if nrbf.write(recs) != raw:
        sys.exit('round-trip check failed, not touching the file')
    d = nrbf.Doc(recs)
    root = d.root()

    changed = []
    kvs = d.get(d.get(root, 'collectedGear'), 'KeyValuePairs')
    for e in kvs['items']:
        e = d.deref(e)
        gid = str(d.get(e, 'key'))
        g = gears.get(gid)
        if not g or g['category'] not in CATEGORIES or g['category'] not in a.only.split(','):
            continue
        v = d.deref(d.get(e, 'value'))
        us = d.deref(d.get(v, 'unlockState'))
        before = (d.get(us, 'value__'), d.get(v, 'level'))
        d.set(us, 'value__', 2)
        if g['category'] != 'heavy':
            d.set(v, 'level', max(a.level, d.get(v, 'level')))
            d.set(v, 'levelXP', 0)
        changed.append(f"{g['key']}: {before} -> {(2, d.get(v, 'level'))}")
    d.set(root, 'upgradeRarityRotations', 15)

    out = nrbf.write(recs)
    nrbf.read(out)  # must parse again
    print('\n'.join(changed))
    print('rotations: 15, bytes', len(raw), '->', len(out))
    if a.dry_run:
        return
    bdir = os.path.join(HERE, 'backups')
    os.makedirs(bdir, exist_ok=True)
    backup = os.path.join(bdir, f"{os.path.basename(profile_dir)}-{time.strftime('%Y%m%d-%H%M%S')}.saxon")
    shutil.copy2(path, backup)
    with open(path, 'wb') as f:
        f.write(out)
    print('backup:', backup)
    print('written:', path)


if __name__ == '__main__':
    main()
