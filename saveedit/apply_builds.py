"""
Writes the solved builds (saveedit/out/layouts.json from plan_builds.ts) into a profile:
  * reuses matching upgrade instances already in the profile, grants the missing ones with the best rolls
    (element, grid-expander direction and Pattern Infuser donor included);
  * slot 0 -> GearData.equippedUpgrades (Current), slots 1..3 -> GearData.loadouts[0..2].

    python saveedit/apply_builds.py "<...>/Профиль 2/PlayerData.saxon" [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import sys
import time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nrbf  # noqa: E402
import rolls  # noqa: E402
from grant import DLL, GAME_JSON, Editor, check_ids  # noqa: E402
from nrbf import BINARY_ARRAY, CLASS_TYPES, CLASS_WITH_ID, MEMBER_REF, OBJ_NULL, SYS_CLASS_TYPES  # noqa: E402

LIST_EQUIP = 'System.Collections.Generic.List`1[[PlayerData+UpgradeEquipData'
LIST_EQUIP_FULL = 'System.Collections.Generic.List`1[[PlayerData+UpgradeEquipData, Assembly-CSharp, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null]]'


def expand_dir(seed: int) -> str:
    n = rolls.GameRandom(seed).next()
    return 'column' if ((~n) & 1) == 0 else 'row'


class BuildWriter(Editor):
    def __init__(self, recs):
        super().__init__(recs)
        self.pending_defs: dict[int, dict] = {}  # synthetic def id -> def record (not in the stream)
        lib = next(r['lib'] for r in self.d.meta.values() if r['t'] == CLASS_TYPES and r['ci']['name'].startswith('PlayerData+'))
        self.lib = lib
        self.equip_def = self.def_named('PlayerData+UpgradeEquipData')
        self.list_equip = self.first_instance_of(LIST_EQUIP)
        loadout = self.defs.get('PlayerData+Loadout')
        if loadout is None:
            loadout = {'t': CLASS_TYPES, 'ci': {'id': self.neg_id(), 'name': 'PlayerData+Loadout', 'members': ['iconIndex', 'upgrades']},
                       'bts': [0, 3], 'extra': [8, LIST_EQUIP_FULL], 'lib': lib, 'values': []}
            self.pending_defs[loadout['ci']['id']] = loadout
            self.d.meta[loadout['ci']['id']] = loadout
        self.loadout_def = loadout
        self.list_equip_meta = self.list_equip['ci']['id'] if self.list_equip['t'] in (CLASS_TYPES, SYS_CLASS_TYPES) else self.list_equip['meta']
        arr = self.d.deref(self.d.get(self.list_equip, '_items'))
        self.equip_arr_tmpl = {k: v for k, v in arr.items() if k not in ('items', 'libs', 'id', 'lengths')}

    # ---- instances ----
    def inventory(self, game):
        """(store gear id, upgrade id, element, patternFrom, expand) -> [instance ids]"""
        inv = defaultdict(list)
        U = game['upgrades']
        for r in list(self.d.by_id.values()):
            if not (isinstance(r, dict) and r['t'] in (CLASS_WITH_ID, CLASS_TYPES) and self.d.class_name(r) == 'UpgradeInstance'):
                continue
            uid = str(self.d.get(self.d.get(r, 'upgradeIDv2'), 'ID'))
            u = U.get(uid)
            if not u:
                continue
            seed = self.d.get(r, '<Seed>k__BackingField')
            pf = self.d.get(r, 'overriddenPatternID')
            key = (self.d.get(r, 'gearID'), uid, rolls.seed_element(u, seed) if u.get('elementRoll') else None,
                   str(pf) if pf and str(pf) != uid else None, expand_dir(seed) if u['role'] == 'gridExpander' else None)
            inv[key].append(self.d.get(r, 'id'))
        return inv

    def set_pattern(self, instance_id, donor_id, cells):
        for r in self.d.by_id.values():
            if isinstance(r, dict) and r['t'] in (CLASS_WITH_ID, CLASS_TYPES) and self.d.class_name(r) == 'UpgradeInstance' \
                    and self.d.get(r, 'id') == instance_id:
                self.d.set(r, 'overriddenPatternID', int(donor_id))
                self.d.set(r, 'patternSize', cells)
                return
        raise KeyError(instance_id)

    # ---- equip lists ----
    def equip_list(self, equips):
        """New List<UpgradeEquipData> (inline object) + its items array (top level)."""
        items = []
        for iid, x, y, rot in equips:
            items.append({'t': CLASS_WITH_ID, 'id': self.neg_id(), 'meta': self.equip_def['ci']['id'], 'values': [iid, x, y, rot]})
        cap = max(4, 1 << (len(items) - 1).bit_length()) if items else 4
        pad = cap - len(items)
        if pad == 1:
            items.append({'t': OBJ_NULL})
        elif pad > 1:
            items.append({'t': nrbf.NULL_MULTI_256, 'count': pad})
        arr = dict(self.equip_arr_tmpl, t=BINARY_ARRAY, id=self.pos_id(), lengths=[cap], items=items)
        self.new_top.append(arr)
        lst = {'t': CLASS_WITH_ID, 'id': self.pos_id(), 'meta': self.list_equip_meta,
               'values': [{'t': MEMBER_REF, 'ref': arr['id']}, len(equips), len(equips)]}
        # member order of List`1: _items, _size, _version
        return lst

    def gear_data(self, gear_id: int):
        kvs = self.d.get(self.d.get(self.root, 'collectedGear'), 'KeyValuePairs')
        for e in kvs['items']:
            e = self.d.deref(e)
            if self.d.get(e, 'key') == gear_id:
                return self.d.deref(self.d.get(e, 'value'))
        raise KeyError(gear_id)

    def write_slots(self, gear_id: int, slots: dict[int, list]):
        gd = self.gear_data(gear_id)
        # like the game: arrays and lists are separate objects referenced from the member (an inline array is not read)
        if 0 in slots:
            lst = self.equip_list(slots[0])
            self.new_top.append(lst)
            self.d.set(gd, 'equippedUpgrades', {'t': MEMBER_REF, 'ref': lst['id']})
        if any(s in slots for s in (1, 2, 3)):
            items = []
            for s in (1, 2, 3):
                ups = self.equip_list(slots[s]) if s in slots else {'t': OBJ_NULL}
                items.append({'t': CLASS_WITH_ID, 'id': self.neg_id(), 'meta': self.loadout_def['ci']['id'],
                              'values': [s if s in slots else 0, ups]})
            arr = {'t': BINARY_ARRAY, 'id': self.pos_id(), 'kind': 0, 'rank': 1, 'lengths': [3], 'lower': None,
                   'bt': nrbf.BT_CLASS, 'ex': ('PlayerData+Loadout', self.lib), 'items': items}
            self.new_top.append(arr)
            self.d.set(gd, 'loadouts', {'t': MEMBER_REF, 'ref': arr['id']})


def normalize_defs(recs, meta_by_id):
    """The first object of every class in stream order must carry the class definition."""
    def sig(r):  # the same class name can come with different member layouts (e.g. an empty Dictionary)
        return (r['ci']['name'], tuple(r['ci']['members']), tuple(r['bts']), json.dumps(r['extra']))

    name_of = {i: sig(r) for i, r in meta_by_id.items()}
    def_of = {i: r for i, r in meta_by_id.items()}
    seen: dict[str, int] = {}

    def visit(r):
        if not isinstance(r, dict):
            return
        t = r['t']
        if t in (CLASS_TYPES, SYS_CLASS_TYPES):
            name = sig(r)
            if name in seen:
                oid = r['ci']['id']
                vals = r['values']
                libs = r.get('libs')
                r.clear()
                r.update({'t': CLASS_WITH_ID, 'id': oid, 'meta': seen[name], 'values': vals})
                if libs:
                    r['libs'] = libs
            else:
                seen[name] = r['ci']['id']
        elif t == CLASS_WITH_ID:
            name = name_of[r['meta']]
            if name in seen:
                r['meta'] = seen[name]
            else:
                src = def_of[r['meta']]
                vals, oid = r['values'], r['id']
                r.clear()
                r.update({'t': src['t'], 'ci': {'id': oid, 'name': src['ci']['name'], 'members': list(src['ci']['members'])},
                          'bts': list(src['bts']), 'extra': list(src['extra']), 'values': vals})
                if src['t'] == CLASS_TYPES:
                    r['lib'] = src['lib']
                seen[name] = oid
        for k in ('values', 'items'):
            for v in r.get(k, []):
                visit(v)

    for r in recs:
        visit(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('save')
    ap.add_argument('--layouts', default=os.path.join(HERE, 'out', 'layouts.json'))
    ap.add_argument('--tries', type=int, default=60000)
    ap.add_argument('--dry-run', action='store_true')
    a = ap.parse_args()
    path = os.path.abspath(a.save)
    if os.path.basename(os.path.dirname(path)).lower() == 'default':
        sys.exit('refusing to edit the default profile')

    game = json.load(open(GAME_JSON, encoding='utf-8'))
    U = game['upgrades']
    gears = {g['id']: g for g in game['gears']}
    player_id = next(g['id'] for g in game['gears'] if g['key'] == 'player')
    steps = rolls.load_steps(os.path.join(HERE, 'roll_steps.json'), DLL)
    builds = json.load(open(a.layouts, encoding='utf-8'))

    raw = open(path, 'rb').read()
    recs = nrbf.read(raw)
    if nrbf.write(recs) != raw:
        sys.exit('round-trip check failed, not touching the file')
    w = BuildWriter(recs)
    inv = w.inventory(game)
    used_seeds: set[int] = set()

    def store_of(gear, u):
        if gear['category'] == 'character' and (player_id in u['gears'] or u['role'] == 'gridExpander'):
            return int(player_id)
        return int(gear['id'])

    granted = 0
    by_gear = defaultdict(dict)
    for b in builds:
        gear = gears[b['gearId']]
        taken: dict[tuple, int] = defaultdict(int)
        equips = []
        for p in b['placements']:
            u = U[p['upgradeId']]
            el = p.get('element') if u.get('elementRoll') else None
            ex = p.get('expand') if u['role'] == 'gridExpander' else None
            key = (store_of(gear, u), u['id'], el, p.get('patternFrom'), ex)
            pool = inv[key]
            i = taken[key]
            taken[key] += 1
            if i >= len(pool):
                ok = (lambda s, ex=ex: expand_dir(s) == ex) if ex else None
                seed, worst, _ = rolls.best_seed(u, steps, el, tries=a.tries, start=len(used_seeds) * 7919 + 101, avoid=used_seeds, accept=ok)
                used_seeds.add(seed)
                donor = p.get('patternFrom')
                cells = len(U[donor]['pattern']['cells']) if donor else len(u['pattern']['cells'])
                iid = w.add_instance(key[0], int(u['id']), seed, len(u['pattern']['cells']))
                if donor:
                    w.set_pattern(iid, donor, cells)
                pool.append(iid)
                granted += 1
            equips.append((pool[i], p['x'], p['y'], p['rotation']))
        by_gear[b['gearId']][b['slot']] = equips
        print(f"{gear['key']:>14} slot {b['slot']} {b['name']:<38} {len(equips)} mods")
    for gid, slots in by_gear.items():
        w.write_slots(int(gid), slots)
    w.finish()
    normalize_defs(recs, {**w.d.meta, **w.pending_defs})
    check_ids(recs)
    out = nrbf.write(recs)
    nrbf.read(out)
    print('granted', granted, 'instances; bytes', len(raw), '->', len(out))
    if a.dry_run:
        open(os.path.join(HERE, 'out', 'dry-run.saxon'), 'wb').write(out)
        return
    bdir = os.path.join(HERE, 'backups')
    os.makedirs(bdir, exist_ok=True)
    backup = os.path.join(bdir, f"{os.path.basename(os.path.dirname(path))}-{time.strftime('%Y%m%d-%H%M%S')}.saxon")
    shutil.copy2(path, backup)
    open(path, 'wb').write(out)
    print('backup:', backup)
    print('written:', path)


if __name__ == '__main__':
    main()
