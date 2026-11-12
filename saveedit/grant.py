"""
Grant upgrade instances to a Mycopunk profile, with the best possible stat rolls.

    python saveedit/grant.py <PlayerData.saxon> plan.json [--dry-run]

plan.json: [{"gear": "bounceshotgun", "key": "Twins", "count": 1, "element": "fire"?}, ...]
  gear = the gear the upgrade is used on (characters get the shared "player" mods and grid expanders
  through the player gear, as the game stores them).
Every new instance gets a seed whose rolls are all close to the good end of their ranges (see rolls.py),
and, for upgrades with a per-instance element, the requested element.
"""
from __future__ import annotations

import argparse
import copy
import datetime
import json
import os
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nrbf  # noqa: E402
import rolls  # noqa: E402
from nrbf import CLASS_TYPES, CLASS_WITH_ID, MEMBER_REF, NULL_MULTI, NULL_MULTI_256, OBJ_NULL, SYS_CLASS_TYPES  # noqa: E402

GAME_JSON = os.path.join(HERE, '..', 'site', 'public', 'data', 'game.json')
DLL = r'C:/Program Files (x86)/Steam/steamapps/common/Mycopunk/Mycopunk_Data/Managed/Assembly-CSharp.dll'
PLAYER_GEAR = 'player'


def net_ticks_now() -> int:
    epoch = datetime.datetime(1, 1, 1, tzinfo=datetime.timezone.utc)
    return int((datetime.datetime.now(datetime.timezone.utc) - epoch).total_seconds() * 10_000_000)


class Editor:
    def __init__(self, recs):
        self.recs = recs
        self.d = nrbf.Doc(recs)
        self.root = self.d.root()
        # BinaryFormatter numbers all objects with ONE counter; nested value types get the negated id.
        # |id| must stay unique ("An object cannot be registered twice" otherwise).
        self.next_id = max(abs(i) for i in self.d.by_id if isinstance(i, int)) + 1
        self.new_top: list[dict] = []
        self.defs = {}
        for r in self.d.meta.values():
            self.defs.setdefault(r['ci']['name'].split(',')[0], r)

    # ---- ids / records ----
    def pos_id(self):
        self.next_id += 1
        return self.next_id - 1

    def neg_id(self):
        self.next_id += 1
        return -(self.next_id - 1)

    def def_named(self, prefix):
        for name, r in self.defs.items():
            if name.startswith(prefix):
                return r
        raise KeyError(prefix)

    def clone_inline(self, v):
        """Copy of a nested value; nested objects get new ids and refer to their class definition."""
        if not isinstance(v, dict):
            return copy.deepcopy(v)
        if v['t'] in (CLASS_TYPES, SYS_CLASS_TYPES):
            return {'t': CLASS_WITH_ID, 'id': self.neg_id(), 'meta': v['ci']['id'], 'values': [self.clone_inline(x) for x in v['values']]}
        if v['t'] == CLASS_WITH_ID:
            return {'t': CLASS_WITH_ID, 'id': self.neg_id(), 'meta': v['meta'], 'values': [self.clone_inline(x) for x in v['values']]}
        return copy.deepcopy(v)

    def new_object(self, template, top=True):
        """New top-level object of the template's class, values cloned from the template."""
        meta = template['ci']['id'] if template['t'] in (CLASS_TYPES, SYS_CLASS_TYPES) else template['meta']
        r = {'t': CLASS_WITH_ID, 'id': self.pos_id(), 'meta': meta, 'values': [self.clone_inline(x) for x in template['values']]}
        if top:
            self.new_top.append(r)
        return r

    def first_instance_of(self, cls_name):
        """First object whose class name equals cls_name (or starts with it, for generic names)."""
        for r in self.d.by_id.values():
            if isinstance(r, dict) and r['t'] in (CLASS_WITH_ID, CLASS_TYPES, SYS_CLASS_TYPES):
                n = self.d.class_name(r)
                if n == cls_name or n.startswith(cls_name):
                    return r
        raise KeyError(cls_name)

    # ---- lists ----
    def list_refs(self, lst):
        arr = self.d.deref(self.d.get(lst, '_items'))
        return arr, [x for x in arr['items'] if isinstance(x, dict) and x['t'] == MEMBER_REF]

    def _refcounts(self):
        counts = {}

        def walk(rs):
            for r in rs:
                if isinstance(r, dict):
                    if r['t'] == MEMBER_REF:
                        counts[r['ref']] = counts.get(r['ref'], 0) + 1
                    for k in ('values', 'items'):
                        if k in r:
                            walk(r[k])
        walk(self.recs)
        walk(self.new_top)
        return counts

    def own_array(self, lst):
        """Lists may share one array (.NET serializes the static empty array of List<T> once): give lst its own."""
        ref = lst['values'][self.d.index_of(lst, '_items')]  # raw value (Doc.get dereferences)
        if not (isinstance(ref, dict) and ref['t'] == MEMBER_REF):
            return
        if self._refcounts().get(ref['ref'], 0) <= 1:
            return
        arr = self.d.by_id[ref['ref']]
        size = self.d.get(lst, '_size')
        refs = [x for x in arr['items'] if isinstance(x, dict) and x['t'] == MEMBER_REF][:size]
        new = {k: copy.deepcopy(v) for k, v in arr.items() if k not in ('items', 'libs')}
        new['id'] = self.pos_id()
        new['items'] = refs
        new['lengths'] = [len(refs)]
        self.new_top.append(new)
        self.d.by_id[new['id']] = new
        self.d.set(lst, '_items', {'t': MEMBER_REF, 'ref': new['id']})

    def list_append(self, lst, obj):
        self.own_array(lst)
        arr, refs = self.list_refs(lst)
        size = self.d.get(lst, '_size')
        refs = refs[:size] + [{'t': MEMBER_REF, 'ref': obj['id']}]
        cap = max(4, arr['lengths'][0])
        while cap < len(refs):
            cap *= 2
        items = list(refs)
        pad = cap - len(refs)
        if pad == 1:
            items.append({'t': OBJ_NULL})
        elif pad > 1:
            items.append({'t': NULL_MULTI_256, 'count': pad} if pad < 256 else {'t': NULL_MULTI, 'count': pad})
        arr['items'] = items
        arr['lengths'] = [cap]
        self.d.set(lst, '_size', len(refs))
        self.d.set(lst, '_version', self.d.get(lst, '_version') + 1)

    def new_list(self, list_template):
        lst = self.new_object(list_template)
        arr_t = self.d.deref(self.d.get(list_template, '_items'))
        arr = {k: copy.deepcopy(v) for k, v in arr_t.items() if k not in ('items', 'libs')}
        arr['id'] = self.pos_id()
        arr['lengths'] = [4]
        arr['items'] = [{'t': NULL_MULTI_256, 'count': 4}]
        self.new_top.append(arr)
        self.d.set(lst, '_items', {'t': MEMBER_REF, 'ref': arr['id']})
        self.d.set(lst, '_size', 0)
        self.d.set(lst, '_version', 0)
        self.d.by_id[lst['id']] = lst
        self.d.by_id[arr['id']] = arr
        return lst

    # ---- save structure ----
    def gear_infos(self, gear_id: int):
        kvs = self.d.get(self.d.get(self.root, 'data'), 'KeyValuePairs')
        for e in kvs['items']:
            e = self.d.deref(e)
            if self.d.get(e, 'key') == gear_id:
                return self.d.deref(self.d.get(e, 'value'))
        raise KeyError(f'gear {gear_id} has no upgrade list in this save')

    def upgrade_info(self, gear_id: int, upgrade_id: int):
        lst = self.gear_infos(gear_id)
        _, refs = self.list_refs(lst)
        for ref in refs:
            info = self.d.by_id[ref['ref']]
            if self.d.get(self.d.get(info, 'idV2'), 'ID') == upgrade_id:
                return info
        tmpl = self.first_instance_of('UpgradeInfo')
        info = self.new_object(tmpl)
        self.d.by_id[info['id']] = info
        self.d.set(info, 'upgradeID', 0)
        self.d.set(self.d.get(info, 'idV2'), 'ID', upgrade_id)
        self.d.set(info, 'Instances', {'t': OBJ_NULL})
        self.d.set(info, 'totalInstancesCollected', 0)
        self.d.set(info, 'hasViewed', False)
        self.d.set(info, '<IsUnlockable>k__BackingField', True)
        self.list_append(lst, info)
        return info

    def add_instance(self, gear_id: int, upgrade_id: int, seed: int, cells: int):
        info = self.upgrade_info(gear_id, upgrade_id)
        inst_list = self.d.get(info, 'Instances')
        if not (isinstance(inst_list, dict) and inst_list['t'] in (CLASS_WITH_ID, CLASS_TYPES, SYS_CLASS_TYPES)):
            tmpl = self.first_instance_of('System.Collections.Generic.List`1[[UpgradeInstance')
            inst_list = self.new_list(tmpl)
            self.d.set(info, 'Instances', {'t': MEMBER_REF, 'ref': inst_list['id']})
        tmpl = self.first_instance_of('UpgradeInstance')
        inst = self.new_object(tmpl)
        self.d.by_id[inst['id']] = inst
        counter = self.d.get(self.root, 'upgradeIDCounter') + 1
        self.d.set(self.root, 'upgradeIDCounter', counter)
        g = self.d.get
        s = self.d.set
        s(inst, 'upgradeID', 0)
        s(g(inst, 'upgradeIDv2'), 'ID', upgrade_id)
        s(g(inst, 'upgradeIDv2'), 'Mod', {'t': OBJ_NULL})
        s(inst, 'gearID', gear_id)
        s(inst, '<IsUnlocked>k__BackingField', True)
        s(inst, '<RemoveOnQuit>k__BackingField', False)
        s(inst, '<TimeUnlocked>k__BackingField', net_ticks_now())
        s(inst, 'timeEquipped', 0)
        s(inst, '<HasBeenSeen>k__BackingField', False)
        s(inst, '<Seed>k__BackingField', seed)
        s(inst, 'id', counter)
        s(inst, 'overriddenPatternID', 0)
        s(inst, 'overriddenPatternMod', {'t': OBJ_NULL})
        s(g(inst, 'flags'), 'value__', 0)
        s(inst, 'patternSize', cells)
        self.list_append(inst_list, inst)
        s(info, 'totalInstancesCollected', g(info, 'totalInstancesCollected') + 1)
        return counter

    def finish(self):
        end = self.recs.pop()
        self.recs.extend(self.new_top)
        self.recs.append(end)
        self.new_top = []


def check_ids(recs):
    seen = set()

    def walk(rs):
        for r in rs:
            if not isinstance(r, dict):
                continue
            i = r['ci']['id'] if r['t'] in (CLASS_TYPES, SYS_CLASS_TYPES) else (r.get('id') if r['t'] != 0 else None)
            if i is not None:
                if abs(i) in seen:
                    raise SystemExit(f'object id {i} used twice - not writing')
                seen.add(abs(i))
            for k in ('values', 'items'):
                if k in r:
                    walk(r[k])
    walk(recs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('save')
    ap.add_argument('plan')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--tries', type=int, default=40000)
    a = ap.parse_args()

    path = os.path.abspath(a.save)
    profile_dir = os.path.dirname(path)
    if os.path.basename(profile_dir).lower() == 'default':
        sys.exit('refusing to edit the default profile')

    game = json.load(open(GAME_JSON, encoding='utf-8'))
    gears = {g['key']: g for g in game['gears']}
    player = gears[PLAYER_GEAR]
    steps = rolls.load_steps(os.path.join(HERE, 'roll_steps.json'), DLL)
    plan = json.load(open(a.plan, encoding='utf-8'))

    raw = open(path, 'rb').read()
    recs = nrbf.read(raw)
    if nrbf.write(recs) != raw:
        sys.exit('round-trip check failed, not touching the file')
    ed = Editor(recs)

    used_seeds = set()
    report = []
    for item in plan:
        gear = gears[item['gear']]
        u = next((x for x in game['upgrades'].values() if x['key'] == item['key'] and
                  (gear['id'] in x['gears'] or (x['role'] == 'gridExpander') or player['id'] in x['gears'])), None)
        if u is None:
            sys.exit(f"unknown upgrade {item['key']} for {item['gear']}")
        # where the game stores it: shared player mods (and character grid expanders) -> player gear
        store = player if (player['id'] in u['gears'] and gear['category'] == 'character') or \
            (u['role'] == 'gridExpander' and gear['category'] == 'character') else gear
        element = item.get('element')
        if element and element not in (u.get('elementChoice') or []):
            sys.exit(f"{u['key']}: element {element} not possible")
        for _ in range(item.get('count', 1)):
            seed, worst, mean = rolls.best_seed(u, steps, element, tries=a.tries, start=len(used_seeds) * 7919 + 17, avoid=used_seeds)
            used_seeds.add(seed)
            iid = ed.add_instance(int(store['id']), int(u['id']), seed, len(u['pattern']['cells']))
            report.append(f"{gear['key']:>14} {u['key']:<28} id {iid:<5} seed {seed:<11} worst {worst:.3f} mean {mean:.3f}"
                          + (f" element {rolls.seed_element(u, seed)}" if u.get('elementRoll') else ''))
    ed.finish()
    check_ids(recs)
    out = nrbf.write(recs)
    nrbf.read(out)
    print('\n'.join(report))
    print('bytes', len(raw), '->', len(out))
    if a.dry_run:
        return out
    bdir = os.path.join(HERE, 'backups')
    os.makedirs(bdir, exist_ok=True)
    backup = os.path.join(bdir, f"{os.path.basename(profile_dir)}-{time.strftime('%Y%m%d-%H%M%S')}.saxon")
    shutil.copy2(path, backup)
    with open(path, 'wb') as f:
        f.write(out)
    print('backup:', backup)
    print('written:', path)
    return out


if __name__ == '__main__':
    main()
