/**
 * Editing a Mycopunk save (PlayerData.saxon) on top of the lossless record model (nrbfw.ts).
 * Port of the saveedit/ Python tools, with the rules learned against the game's own loader:
 *  - |object id| must be unique (BinaryFormatter numbers all objects with one counter, value types negated);
 *  - arrays and lists are separate objects referenced from members (an inline array is not read by the game);
 *  - several empty lists may share one array (List<T>'s static empty array) - a list gets its own before growing;
 *  - the first object of every class (by name + member layout) in stream order carries the class definition.
 */
import { BT, readRecords, RT, writeRecords, type Extra, type Rec, type Value } from './nrbfw';
import { GameRandom, gameRandomNextBool, modifyPropertySeed, seededElement } from './savegame';
import type { Upgrade } from '../types';

const isRec = (v: Value): v is Rec => typeof v === 'object' && v !== null;
const isClass = (r: Rec) => r.t === RT.ClassWithId || r.t === RT.ClassTypes || r.t === RT.SysClassTypes;
const isNullRun = (v: Value) => isRec(v) && (v.t === RT.NullMulti || v.t === RT.NullMulti256);
const ref = (id: number): Rec => ({ t: RT.MemberRef, ref: id });
const LIST_EQUIP = 'System.Collections.Generic.List`1[[PlayerData+UpgradeEquipData';
const LIST_EQUIP_FULL = 'System.Collections.Generic.List`1[[PlayerData+UpgradeEquipData, Assembly-CSharp, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null]]';

export interface SaveEquipEntry {
  instanceId: number;
  x: number;
  y: number;
  rotation: number;
}
const NULL: Rec = { t: RT.ObjNull };

export interface SaveInstanceInfo {
  rec: Rec;
  id: number;
  upgradeId: string;
  gearId: string;
  seed: number;
  patternFrom?: string;
  unlocked: boolean;
}

export interface SaveGearInfo {
  id: string;
  level: number;
  unlock: number;
}

export class SaveDoc {
  recs: Rec[];
  byId = new Map<number, Rec>();
  meta = new Map<number, Rec>();
  private nextId: number;
  private newTop: Rec[] = [];
  private pendingDefs = new Map<number, Rec>();

  constructor(bytes: Uint8Array) {
    this.recs = readRecords(bytes);
    this.index(this.recs);
    let max = 0;
    for (const id of this.byId.keys()) max = Math.max(max, Math.abs(id));
    this.nextId = max + 1;
    if (this.className(this.root) !== 'PlayerData') throw new Error(`not a Mycopunk PlayerData save (${this.className(this.root)})`);
  }

  private index(rs: Value[]) {
    for (const r of rs) {
      if (!isRec(r)) continue;
      if (r.t === RT.ClassTypes || r.t === RT.SysClassTypes) {
        this.meta.set(r.ci!.id, r);
        this.byId.set(r.ci!.id, r);
      } else if (r.id !== undefined && r.t !== RT.Header) this.byId.set(r.id, r);
      if (r.values) this.index(r.values);
      if (r.items) this.index(r.items);
    }
  }

  // ---------- generic access ----------
  get root(): Rec {
    return this.byId.get(this.recs[0].root!)!;
  }
  def(r: Rec): Rec {
    return r.t === RT.ClassWithId ? (this.meta.get(r.meta!) ?? this.pendingDefs.get(r.meta!))! : r;
  }
  className(r: Rec): string {
    return this.def(r).ci!.name;
  }
  indexOf(r: Rec, member: string): number {
    const i = this.def(r).ci!.members.indexOf(member);
    if (i < 0) throw new Error(`no member ${member} in ${this.className(r)}`);
    let slot = 0;
    for (let pos = 0; pos < r.values!.length; pos++) {
      if (slot === i) return pos;
      const v = r.values![pos];
      slot += isNullRun(v) ? (v as Rec).count! : 1;
    }
    throw new Error(`member ${member} not found`);
  }
  raw(r: Rec, member: string): Value {
    return r.values![this.indexOf(r, member)];
  }
  get(r: Rec, member: string): Value {
    return this.deref(this.raw(r, member));
  }
  rec(r: Rec, member: string): Rec | null {
    const v = this.get(r, member);
    return isRec(v) && v.t !== RT.ObjNull ? v : null;
  }
  num(r: Rec, member: string): number {
    return Number(this.get(r, member));
  }
  set(r: Rec, member: string, v: Value) {
    r.values![this.indexOf(r, member)] = v;
  }
  deref(v: Value): Value {
    return isRec(v) && v.t === RT.MemberRef ? this.byId.get(v.ref!)! : v;
  }
  hasMember(r: Rec, member: string) {
    return this.def(r).ci!.members.includes(member);
  }

  private posId() {
    return this.nextId++;
  }
  private negId() {
    return -this.nextId++;
  }
  private top(r: Rec) {
    this.newTop.push(r);
    this.byId.set(r.id!, r);
    return r;
  }

  /** First object of a class (exact name or name prefix for generics). */
  firstOf(name: string): Rec | undefined {
    for (const r of this.byId.values()) if (isClass(r)) {
      const n = this.className(r);
      if (n === name || n.startsWith(name)) return r;
    }
    return undefined;
  }

  private clone(v: Value): Value {
    if (!isRec(v)) return v;
    if (v.t === RT.ClassTypes || v.t === RT.SysClassTypes)
      return { t: RT.ClassWithId, id: this.negId(), meta: v.ci!.id, values: v.values!.map((x) => this.clone(x)) };
    if (v.t === RT.ClassWithId) return { t: RT.ClassWithId, id: this.negId(), meta: v.meta, values: v.values!.map((x) => this.clone(x)) };
    return structuredClone(v);
  }

  private newObject(template: Rec): Rec {
    const meta = template.t === RT.ClassWithId ? template.meta! : template.ci!.id;
    return this.top({ t: RT.ClassWithId, id: this.posId(), meta, values: template.values!.map((x) => this.clone(x)) });
  }

  // ---------- lists & dictionaries ----------
  private refCounts(): Map<number, number> {
    const c = new Map<number, number>();
    const walk = (rs: Value[]) => {
      for (const r of rs) {
        if (!isRec(r)) continue;
        if (r.t === RT.MemberRef) c.set(r.ref!, (c.get(r.ref!) ?? 0) + 1);
        if (r.values) walk(r.values);
        if (r.items) walk(r.items);
      }
    };
    walk(this.recs);
    walk(this.newTop);
    return c;
  }

  listItems(lst: Rec): Rec[] {
    const arr = this.get(lst, '_items') as Rec;
    const size = this.num(lst, '_size');
    return arr.items!.filter((x): x is Rec => isRec(x) && !isNullRun(x) && x.t !== RT.ObjNull).slice(0, size).map((x) => this.deref(x) as Rec);
  }

  private ownArray(lst: Rec) {
    const r = this.raw(lst, '_items');
    if (!isRec(r) || r.t !== RT.MemberRef || (this.refCounts().get(r.ref!) ?? 0) <= 1) return;
    const arr = this.byId.get(r.ref!)!;
    const size = this.num(lst, '_size');
    const items = arr.items!.filter((x) => isRec(x) && x.t === RT.MemberRef).slice(0, size);
    const copy: Rec = { ...structuredClone({ ...arr, items: [] }), id: this.posId(), items, lengths: [items.length] };
    delete copy.libs;
    this.top(copy);
    this.set(lst, '_items', ref(copy.id!));
  }

  private padItems(items: Value[], cap: number): Value[] {
    const pad = cap - items.length;
    if (pad === 1) return [...items, NULL];
    if (pad > 1) return [...items, pad < 256 ? { t: RT.NullMulti256, count: pad } : { t: RT.NullMulti, count: pad }];
    return items;
  }

  listAppend(lst: Rec, item: Value) {
    this.ownArray(lst);
    const arr = this.get(lst, '_items') as Rec;
    const size = this.num(lst, '_size');
    const cur = arr.items!.filter((x) => isRec(x) && !isNullRun(x) && x.t !== RT.ObjNull).slice(0, size);
    const items = [...cur, item];
    let cap = Math.max(4, arr.lengths![0]);
    while (cap < items.length) cap *= 2;
    arr.items = this.padItems(items, cap);
    arr.lengths = [cap];
    this.set(lst, '_size', items.length);
    this.set(lst, '_version', this.num(lst, '_version') + 1);
  }

  /** Dictionary<K,V> entries as [key, value, entry record]. */
  dictEntries(dict: Rec): { key: Value; value: Value; entry: Rec }[] {
    if (!this.hasMember(dict, 'KeyValuePairs')) return [];
    const arr = this.rec(dict, 'KeyValuePairs');
    if (!arr) return [];
    return arr.items!.filter((x): x is Rec => isRec(x) && !isNullRun(x) && x.t !== RT.ObjNull).map((x) => {
      const e = this.deref(x) as Rec;
      const k = this.get(e, 'key');
      return { key: isRec(k) && k.t === RT.ObjString ? k.v! : k, value: this.get(e, 'value'), entry: e };
    });
  }

  /** Sets dict[key] for a Dictionary<string, int> member of the root (resources, items, flags...). */
  setRootDictInt(member: string, key: string, value: number) {
    const dict = this.rec(this.root, member);
    if (!dict) throw new Error(`${member} is missing`);
    const found = this.dictEntries(dict).find((e) => e.key === key);
    if (found) {
      this.set(found.entry, 'value', value);
      return;
    }
    // the same Dictionary type with entries elsewhere in the save gives the layout (an empty dictionary has no KeyValuePairs)
    const name = this.className(dict);
    let full: Rec | undefined;
    for (const r of this.byId.values())
      if (isClass(r) && this.className(r) === name && this.hasMember(r, 'KeyValuePairs') && this.rec(r, 'KeyValuePairs')) {
        full = r;
        break;
      }
    if (!full) throw new Error(`no ${name} with entries to copy the layout from`);
    if (!this.hasMember(dict, 'KeyValuePairs')) {
      const meta = full.t === RT.ClassWithId ? full.meta! : full.ci!.id;
      const vals = [this.get(dict, 'Version'), this.raw(dict, 'Comparer'), this.get(dict, 'HashSize')];
      if (dict.t !== RT.ClassWithId) {
        // the dictionary carried the definition of the empty layout: other empty dictionaries still use it,
        // keep a copy (normalizeDefs hands the definition to the next object of that layout)
        const id = dict.ci!.id;
        const defCopy = structuredClone({ ...dict, values: [] });
        this.meta.set(id, defCopy);
        this.pendingDefs.set(id, defCopy);
        dict.id = id;
      }
      dict.t = RT.ClassWithId;
      delete dict.ci;
      delete dict.bts;
      delete dict.extra;
      delete dict.lib;
      dict.meta = meta;
      dict.values = [...vals, NULL];
    }
    let arr = this.rec(dict, 'KeyValuePairs');
    if (!arr) {
      const t = this.rec(full, 'KeyValuePairs')!;
      arr = this.top({ ...structuredClone({ ...t, items: [] }), id: this.posId(), lengths: [0], items: [] });
      delete arr.libs;
      this.set(dict, 'KeyValuePairs', ref(arr.id!));
    }
    const tmpl = this.dictEntries(full)[0].entry;
    const entry = this.clone(tmpl) as Rec;
    entry.values = [{ t: RT.ObjString, id: this.posId(), v: key }, value];
    arr.items = [...arr.items!.filter((x) => isRec(x) && !isNullRun(x) && x.t !== RT.ObjNull), entry];
    arr.lengths = [arr.items.length];
    this.set(dict, 'Version', this.num(dict, 'Version') + 1);
  }

  rootDictInt(member: string): Map<string, number> {
    const dict = this.rec(this.root, member);
    const m = new Map<string, number>();
    if (dict) for (const e of this.dictEntries(dict)) m.set(String(e.key), Number(e.value));
    return m;
  }

  // ---------- gear ----------
  private gearEntries(): { id: string; data: Rec }[] {
    const dict = this.rec(this.root, 'collectedGear')!;
    return this.dictEntries(dict).map((e) => ({ id: String(e.key), data: this.deref(e.value) as Rec }));
  }
  gearData(id: string): Rec | undefined {
    return this.gearEntries().find((g) => g.id === id)?.data;
  }
  gears(): SaveGearInfo[] {
    return this.gearEntries().map(({ id, data }) => ({
      id,
      level: this.num(data, 'level'),
      unlock: this.num(this.rec(data, 'unlockState')!, 'value__'),
    }));
  }
  setGear(id: string, patch: { level?: number; unlock?: number }) {
    const gd = this.gearData(id);
    if (!gd) throw new Error(`gear ${id} not in save`);
    if (patch.level !== undefined) {
      this.set(gd, 'level', patch.level);
      this.set(gd, 'levelXP', 0);
    }
    if (patch.unlock !== undefined) this.set(this.rec(gd, 'unlockState')!, 'value__', patch.unlock);
  }
  get rotationMask() {
    return this.num(this.root, 'upgradeRarityRotations');
  }
  set rotationMask(v: number) {
    this.set(this.root, 'upgradeRarityRotations', v);
  }

  // ---------- upgrade instances ----------
  instances(): SaveInstanceInfo[] {
    const out: SaveInstanceInfo[] = [];
    for (const r of this.byId.values()) {
      if (!isClass(r) || this.className(r) !== 'UpgradeInstance') continue;
      const uid = String(this.num(this.rec(r, 'upgradeIDv2')!, 'ID') || this.num(r, 'upgradeID'));
      const pf = this.num(r, 'overriddenPatternID');
      out.push({
        rec: r,
        id: this.num(r, 'id'),
        upgradeId: uid,
        gearId: String(this.num(r, 'gearID')),
        seed: this.num(r, '<Seed>k__BackingField'),
        unlocked: this.get(r, '<IsUnlocked>k__BackingField') === true,
        ...(pf && String(pf) !== uid ? { patternFrom: String(pf) } : {}),
      });
    }
    return out.sort((a, b) => a.id - b.id);
  }

  private gearInfoList(gearId: string): Rec {
    const dict = this.rec(this.root, 'data')!;
    const e = this.dictEntries(dict).find((x) => String(x.key) === gearId);
    if (!e) throw new Error(`gear ${gearId} has no upgrade list in this save (open it once in the game)`);
    return this.deref(e.value) as Rec;
  }

  private upgradeInfo(gearId: string, upgradeId: string): Rec {
    const lst = this.gearInfoList(gearId);
    for (const info of this.listItems(lst)) if (String(this.num(this.rec(info, 'idV2')!, 'ID')) === upgradeId) return info;
    const tmpl = this.firstOf('UpgradeInfo')!;
    const info = this.newObject(tmpl);
    this.set(info, 'upgradeID', 0);
    this.set(this.rec(info, 'idV2')!, 'ID', Number(upgradeId));
    this.set(info, 'Instances', NULL);
    this.set(info, 'totalInstancesCollected', 0);
    this.set(info, 'hasViewed', false);
    this.set(info, '<IsUnlockable>k__BackingField', true);
    this.listAppend(lst, ref(info.id!));
    return info;
  }

  private newList(template: Rec): Rec {
    const lst = this.newObject(template);
    const arrT = this.get(template, '_items') as Rec;
    const arr = this.top({ ...structuredClone({ ...arrT, items: [] }), id: this.posId(), lengths: [4], items: [{ t: RT.NullMulti256, count: 4 }] });
    delete arr.libs;
    this.set(lst, '_items', ref(arr.id!));
    this.set(lst, '_size', 0);
    this.set(lst, '_version', 0);
    return lst;
  }

  /** Adds an upgrade (or skin) instance stored under `storeGearId`; returns its instance id. */
  addInstance(storeGearId: string, upgradeId: string, seed: number, patternSize: number, patternFrom?: string): number {
    const info = this.upgradeInfo(storeGearId, upgradeId);
    let lst = this.rec(info, 'Instances');
    if (!lst) {
      lst = this.newList(this.firstOf('System.Collections.Generic.List`1[[UpgradeInstance')!);
      this.set(info, 'Instances', ref(lst.id!));
    }
    const inst = this.newObject(this.firstOf('UpgradeInstance')!);
    const counter = this.num(this.root, 'upgradeIDCounter') + 1;
    this.set(this.root, 'upgradeIDCounter', counter);
    const ticks = BigInt(Date.now()) * 10000n + 621355968000000000n;
    this.set(inst, 'upgradeID', 0);
    const idv2 = this.rec(inst, 'upgradeIDv2')!;
    this.set(idv2, 'ID', Number(upgradeId));
    this.set(idv2, 'Mod', NULL);
    this.set(inst, 'gearID', Number(storeGearId));
    this.set(inst, '<IsUnlocked>k__BackingField', true);
    this.set(inst, '<RemoveOnQuit>k__BackingField', false);
    this.set(inst, '<TimeUnlocked>k__BackingField', ticks);
    this.set(inst, 'timeEquipped', 0n);
    this.set(inst, '<HasBeenSeen>k__BackingField', false);
    this.set(inst, '<Seed>k__BackingField', seed | 0);
    this.set(inst, 'id', counter);
    this.set(inst, 'overriddenPatternID', patternFrom ? Number(patternFrom) : 0);
    this.set(inst, 'overriddenPatternMod', NULL);
    this.set(this.rec(inst, 'flags')!, 'value__', 0);
    this.set(inst, 'patternSize', patternSize);
    this.listAppend(lst, ref(inst.id!));
    this.set(info, 'totalInstancesCollected', this.num(info, 'totalInstancesCollected') + 1);
    return counter;
  }

  setSeed(inst: Rec, seed: number) {
    this.set(inst, '<Seed>k__BackingField', seed | 0);
  }

  setPattern(inst: Rec, donorId: string | null, patternSize: number) {
    this.set(inst, 'overriddenPatternID', donorId ? Number(donorId) : 0);
    this.set(inst, 'patternSize', patternSize);
  }

  // ---------- equipment (Current + loadouts 1..3) ----------
  /** Equip entries of a slot: 0 = equipped (Current), 1..3 = GearData.loadouts[slot - 1]. */
  equips(gearId: string, slot: number): SaveEquipEntry[] {
    const gd = this.gearData(gearId);
    if (!gd) return [];
    let lst: Rec | null = null;
    if (slot === 0) lst = this.rec(gd, 'equippedUpgrades');
    else {
      const arr = this.rec(gd, 'loadouts');
      const lo = arr?.items?.[slot - 1];
      if (lo !== undefined && isRec(lo) && isClass(this.deref(lo) as Rec)) lst = this.rec(this.deref(lo) as Rec, 'upgrades');
    }
    if (!lst) return [];
    return this.listItems(lst).map((e) => ({
      instanceId: this.num(e, 'upgradeID'),
      x: this.num(e, 'x'),
      y: this.num(e, 'y'),
      rotation: this.num(e, 'rotation'),
    }));
  }

  private libId(): number {
    let id: number | undefined;
    const walk = (rs: Value[]) => {
      for (const r of rs) {
        if (!isRec(r) || id !== undefined) continue;
        for (const l of r.libs ?? []) if (l.name.startsWith('Assembly-CSharp,')) id = l.id;
        if (r.values) walk(r.values);
        if (r.items) walk(r.items);
      }
    };
    walk(this.recs);
    if (id === undefined) throw new Error('Assembly-CSharp library not found');
    return id;
  }

  /** Definition id of a class, creating a pending definition (written on first use) when the save has none. */
  private defId(name: string, make: () => Omit<Rec, 'values'>): number {
    for (const [id, r] of [...this.meta, ...this.pendingDefs]) if (r.ci && (r.ci.name === name || r.ci.name.startsWith(name))) return id;
    const def = { ...make(), values: [] } as Rec;
    const id = this.negId();
    def.ci = { ...def.ci!, id };
    this.pendingDefs.set(id, def);
    this.meta.set(id, def);
    return id;
  }

  private equipDefs() {
    const lib = this.libId();
    const equip = this.defId('PlayerData+UpgradeEquipData', () => ({
      t: RT.ClassTypes, ci: { id: 0, name: 'PlayerData+UpgradeEquipData', members: ['upgradeID', 'x', 'y', 'rotation'] },
      bts: [BT.Prim, BT.Prim, BT.Prim, BT.Prim], extra: [8, 10, 10, 2], lib,
    }));
    const list = this.defId(LIST_EQUIP, () => ({
      t: RT.SysClassTypes, ci: { id: 0, name: LIST_EQUIP_FULL, members: ['_items', '_size', '_version'] },
      bts: [BT.Class, BT.Prim, BT.Prim], extra: [['PlayerData+UpgradeEquipData[]', lib], 8, 8],
    }));
    const loadout = this.defId('PlayerData+Loadout', () => ({
      t: RT.ClassTypes, ci: { id: 0, name: 'PlayerData+Loadout', members: ['iconIndex', 'upgrades'] },
      bts: [BT.Prim, BT.SysClass], extra: [8, LIST_EQUIP_FULL], lib,
    }));
    return { lib, equip, list, loadout };
  }

  /** New List<UpgradeEquipData> object (not yet placed) + its items array (top level). */
  private equipList(entries: SaveEquipEntry[]): Rec {
    const { lib, equip, list } = this.equipDefs();
    const items: Value[] = entries.map((e) => ({ t: RT.ClassWithId, id: this.negId(), meta: equip, values: [e.instanceId, e.x, e.y, e.rotation] }));
    let cap = 4;
    while (cap < items.length) cap *= 2;
    const arr = this.top({ t: RT.BinaryArray, id: this.posId(), kind: 0, rank: 1, lengths: [cap], lower: null, bt: BT.Class,
      ex: ['PlayerData+UpgradeEquipData', lib], items: this.padItems(items, cap) });
    return { t: RT.ClassWithId, id: this.posId(), meta: list, values: [ref(arr.id!), entries.length, entries.length] };
  }

  /** Writes a slot like the game does (lists and the loadout array are separate referenced objects). */
  setEquips(gearId: string, slot: number, entries: SaveEquipEntry[]) {
    const gd = this.gearData(gearId);
    if (!gd) throw new Error(`gear ${gearId} not in save`);
    if (slot === 0) {
      const lst = this.top(this.equipList(entries));
      this.set(gd, 'equippedUpgrades', ref(lst.id!));
      return;
    }
    const { lib, loadout } = this.equipDefs();
    const old = this.rec(gd, 'loadouts');
    const slots: Value[] = [0, 1, 2].map((i) => {
      const cur = old?.items?.[i];
      return cur !== undefined && isRec(cur) && isClass(this.deref(cur) as Rec) ? (this.deref(cur) as Rec) : null;
    });
    const items = slots.map((cur, i) => {
      const icon = cur ? this.num(cur as Rec, 'iconIndex') : 0;
      if (i === slot - 1)
        return { t: RT.ClassWithId, id: this.negId(), meta: loadout, values: [icon, entries.length ? this.equipList(entries) : NULL] } as Rec;
      if (cur) {
        const c = cur as Rec;
        const ups = this.rec(c, 'upgrades');
        const keep = ups ? this.listItems(ups).map((e) => ({ instanceId: this.num(e, 'upgradeID'), x: this.num(e, 'x'), y: this.num(e, 'y'), rotation: this.num(e, 'rotation') })) : [];
        return { t: RT.ClassWithId, id: this.negId(), meta: loadout, values: [icon, keep.length ? this.equipList(keep) : NULL] } as Rec;
      }
      return { t: RT.ClassWithId, id: this.negId(), meta: loadout, values: [0, NULL] } as Rec;
    });
    const arr = this.top({ t: RT.BinaryArray, id: this.posId(), kind: 0, rank: 1, lengths: [3], lower: null, bt: BT.Class,
      ex: ['PlayerData+Loadout', lib], items });
    this.set(gd, 'loadouts', ref(arr.id!));
  }

  /** Instance record by its save id. */
  instance(id: number): Rec | undefined {
    for (const r of this.byId.values()) if (isClass(r) && this.className(r) === 'UpgradeInstance' && this.num(r, 'id') === id) return r;
    return undefined;
  }

  // ---------- writing ----------
  save(): Uint8Array {
    const end = this.recs.pop()!;
    this.recs.push(...this.newTop, end);
    this.newTop = [];
    this.normalizeDefs();
    this.checkIds();
    const out = writeRecords(this.recs);
    readRecords(out); // must parse again
    return out;
  }

  private normalizeDefs() {
    const sig = (r: Rec) => `${r.ci!.name}|${r.ci!.members.join(',')}|${r.bts!.join(',')}|${JSON.stringify(r.extra)}`;
    const defs = new Map<number, Rec>([...this.meta, ...this.pendingDefs]);
    const seen = new Map<string, number>();
    const visit = (v: Value) => {
      if (!isRec(v)) return;
      if (v.t === RT.ClassTypes || v.t === RT.SysClassTypes) {
        const s = sig(v);
        if (seen.has(s)) {
          const id = v.ci!.id;
          const values = v.values!;
          const libs = v.libs;
          for (const k of Object.keys(v)) delete (v as unknown as Record<string, unknown>)[k];
          Object.assign(v, { t: RT.ClassWithId, id, meta: seen.get(s), values }, libs ? { libs } : {});
        } else seen.set(s, v.ci!.id);
      } else if (v.t === RT.ClassWithId) {
        const d = defs.get(v.meta!)!;
        const s = sig(d);
        if (seen.has(s)) v.meta = seen.get(s);
        else {
          const id = v.id!;
          const values = v.values!;
          const libs = v.libs;
          for (const k of Object.keys(v)) delete (v as unknown as Record<string, unknown>)[k];
          Object.assign(v, { t: d.t, ci: { id, name: d.ci!.name, members: [...d.ci!.members] }, bts: [...d.bts!], extra: structuredClone(d.extra) as Extra[], values },
            d.t === RT.ClassTypes ? { lib: d.lib } : {}, libs ? { libs } : {});
          seen.set(s, id);
        }
      }
      for (const x of v.values ?? []) visit(x);
      for (const x of v.items ?? []) visit(x);
    };
    for (const r of this.recs) visit(r);
  }

  private checkIds() {
    const seen = new Set<number>();
    const walk = (v: Value) => {
      if (!isRec(v)) return;
      const id = v.t === RT.ClassTypes || v.t === RT.SysClassTypes ? v.ci!.id : v.t !== RT.Header ? v.id : undefined;
      if (id !== undefined) {
        if (seen.has(Math.abs(id))) throw new Error(`object id ${id} used twice`);
        seen.add(Math.abs(id));
      }
      for (const x of v.values ?? []) walk(x);
      for (const x of v.items ?? []) walk(x);
    };
    for (const r of this.recs) walk(r);
  }
}

// ---------------------------------------------------------------- rolls

export interface RollStep {
  field: string | null;
  kind: 'apply' | 'next';
  min: boolean;
}
export type RollSteps = Record<string, RollStep[]>;

/** Random.NextFloat(): ((float)Next() * 2^-31 + 1) * 0.5 */
export function nextFloat(r: GameRandom): number {
  return (Math.fround(r.next() * 4.656612873077393e-10) + 1) * 0.5;
}

interface Dim {
  set: (v: number) => void;
  lo: number;
  hi: number;
}

/** Range dimensions of a stat field (OverrideData or plain Range, scalar or Vector2). */
function dims(holder: Record<string, unknown>, field: string): { method: number | null; dims: Dim[] } {
  let v = holder[field] as Record<string, unknown> | undefined;
  let method: number | null = null;
  if (v && typeof v === 'object' && 'data' in v && 'method' in v) {
    method = v.method as number;
    v = v.data as Record<string, unknown>;
  }
  if (!v || typeof v !== 'object' || !('min' in v) || !('max' in v)) return { method, dims: [] };
  const range = v as { min: unknown; max: unknown };
  if (typeof range.min === 'object' && range.min) {
    const mn = range.min as Record<string, number>;
    const mx = range.max as Record<string, number>;
    return {
      method,
      dims: Object.keys(mn).map((k) => ({ lo: mn[k], hi: mx[k], set: (x: number) => ((mn[k] = x), (mx[k] = x)) })),
    };
  }
  return { method, dims: [{ lo: Number(range.min), hi: Number(range.max), set: (x) => ((range.min = x), (range.max = x)) }] };
}

export interface RollResult {
  /** copy of the upgrade with every rolled range collapsed to the rolled value (for statRows) */
  upgrade: Upgrade;
  /** quality of each meaningful roll: 1 = the good end of the range */
  qualities: number[];
  worst: number;
  mean: number;
}

/** Reproduces the stat rolls of an instance (see saveedit/rolls.py). */
export function rollUpgrade(u: Upgrade, seed: number, steps: RollSteps): RollResult {
  const copy = structuredClone(u);
  const qualities: number[] = [];
  copy.props.forEach((p, i) => {
    const r = new GameRandom(modifyPropertySeed(seed, i + 1));
    for (const st of steps[p.type] ?? []) {
      if (st.kind === 'next') {
        r.next();
        continue;
      }
      const { method, dims: ds } = st.field ? dims(p.data as Record<string, unknown>, st.field) : { method: null, dims: [] };
      if (method === 0) continue; // OverrideData with method None does not roll
      if (!ds.length) {
        r.next();
        continue;
      }
      for (const d of ds) {
        const t = nextFloat(r);
        if (d.lo !== d.hi) {
          qualities.push(st.min ? 1 - t : t);
          const v = d.lo + (d.hi - d.lo) * t;
          // integer ranges (Range<int>) are rounded by the game
          d.set(Number.isInteger(d.lo) && Number.isInteger(d.hi) ? Math.round(v) : v);
        }
      }
    }
  });
  const worst = qualities.length ? Math.min(...qualities) : 1;
  const mean = qualities.length ? qualities.reduce((a, b) => a + b, 0) / qualities.length : 1;
  return { upgrade: copy, qualities, worst, mean };
}

/** Quality only (fast path for the seed search). */
export function seedQuality(u: Upgrade, seed: number, steps: RollSteps): [number, number] {
  let worst = 1;
  let sum = 0;
  let n = 0;
  u.props.forEach((p, i) => {
    const list = steps[p.type];
    if (!list?.length) return;
    const r = new GameRandom(modifyPropertySeed(seed, i + 1));
    for (const st of list) {
      if (st.kind === 'next') {
        r.next();
        continue;
      }
      const { method, dims: ds } = st.field ? dims(p.data as Record<string, unknown>, st.field) : { method: null, dims: [] };
      if (method === 0) continue;
      if (!ds.length) {
        r.next();
        continue;
      }
      for (const d of ds) {
        const t = nextFloat(r);
        if (d.lo === d.hi) continue;
        const q = st.min ? 1 - t : t;
        worst = Math.min(worst, q);
        sum += q;
        n++;
      }
    }
  });
  return n ? [worst, sum / n] : [1, 1];
}

export const expandDirection = (seed: number): 'column' | 'row' => (gameRandomNextBool(seed) ? 'column' : 'row');

export interface SeedWish {
  element?: string;
  expand?: 'column' | 'row';
  /** 0..1: wanted quality (1 = best rolls, 0 = worst) */
  target?: number;
  tries?: number;
  avoid?: Set<number>;
}

/** Searches a seed matching the wish (element, expander direction) with rolls closest to the target quality. */
export function findSeed(u: Upgrade, steps: RollSteps, wish: SeedWish = {}): { seed: number; worst: number; mean: number } {
  const target = wish.target ?? 1;
  const tries = wish.tries ?? 30000;
  let best: { seed: number; worst: number; mean: number; score: number } | null = null;
  let state = (Math.random() * 0x7fffffff) | 0;
  for (let checked = 0, guard = 0; checked < tries && guard < tries * 50; guard++) {
    state = new GameRandom(state).next();
    const seed = state & 0x7fffffff;
    if (wish.avoid?.has(seed)) continue;
    if (wish.element && u.elementRoll && seededElement(u, seed) !== wish.element) continue;
    if (wish.expand && expandDirection(seed) !== wish.expand) continue;
    checked++;
    const [worst, mean] = seedQuality(u, seed, steps);
    // best: maximise the worst roll; other targets: every roll close to the target
    const score = target >= 1 ? worst * 10 + mean : -Math.abs(mean - target) - Math.abs(worst - target) * 0.5;
    if (!best || score > best.score) {
      best = { seed, worst, mean, score };
      if (target >= 1 && worst > 0.999) break;
    }
  }
  if (!best) throw new Error('no seed satisfies the conditions');
  return { seed: best.seed, worst: best.worst, mean: best.mean };
}

export { BT };
