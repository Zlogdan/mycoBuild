/**
 * Lossless reader/writer for .NET BinaryFormatter streams (MS-NRBF) - the format of Mycopunk saves.
 * Every record keeps all of its encoded details, so write(read(bytes)) reproduces the bytes exactly;
 * values can then be edited and objects added (see editor.ts). Port of saveedit/nrbf.py.
 */

export const enum RT {
  Header = 0,
  ClassWithId = 1,
  SysClassMembers = 2,
  ClassMembers = 3,
  SysClassTypes = 4,
  ClassTypes = 5,
  ObjString = 6,
  BinaryArray = 7,
  MemberPrimTyped = 8,
  MemberRef = 9,
  ObjNull = 10,
  MsgEnd = 11,
  BinaryLib = 12,
  NullMulti256 = 13,
  NullMulti = 14,
  ArrPrim = 15,
  ArrObj = 16,
  ArrStr = 17,
}

export const enum BT {
  Prim = 0,
  String = 1,
  Object = 2,
  SysClass = 3,
  Class = 4,
  ObjArr = 5,
  StrArr = 6,
  PrimArr = 7,
}

export type Prim = number | bigint | boolean | string | null;
export type Extra = number | string | [string, number] | null;

export interface ClassInfo {
  id: number;
  name: string;
  members: string[];
}

export interface Lib {
  id: number;
  name: string;
}

export interface Rec {
  t: number;
  libs?: Lib[];
  // header
  root?: number;
  hid?: number;
  major?: number;
  minor?: number;
  // class records
  ci?: ClassInfo;
  bts?: number[];
  extra?: Extra[];
  lib?: number;
  id?: number;
  meta?: number;
  values?: Value[];
  // strings / refs / nulls / typed primitives
  v?: Prim;
  ref?: number;
  count?: number;
  pt?: number;
  // arrays
  n?: number;
  kind?: number;
  rank?: number;
  lengths?: number[];
  lower?: number[] | null;
  bt?: number;
  ex?: Extra;
  items?: Value[];
}

export type Value = Prim | Rec;

const isNullRun = (v: Value): v is Rec => typeof v === 'object' && v !== null && (v.t === RT.NullMulti || v.t === RT.NullMulti256);

const utf8 = new TextDecoder();
const enc = new TextEncoder();

class Reader {
  p = 0;
  view: DataView;
  classes = new Map<number, { bts: number[]; extra: Extra[] }>();
  constructor(private d: Uint8Array) {
    this.view = new DataView(d.buffer, d.byteOffset, d.byteLength);
  }
  u8() {
    return this.d[this.p++];
  }
  i32() {
    const v = this.view.getInt32(this.p, true);
    this.p += 4;
    return v;
  }
  lps(): string {
    let n = 0;
    let shift = 0;
    for (;;) {
      const b = this.u8();
      n |= (b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7;
    }
    const s = utf8.decode(this.d.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  prim(pt: number): Prim {
    const v = this.view;
    const p = this.p;
    switch (pt) {
      case 1: this.p += 1; return v.getUint8(p) !== 0;
      case 2: this.p += 1; return v.getUint8(p);
      case 3: {
        const b = this.d[p];
        const n = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
        this.p += n;
        return utf8.decode(this.d.subarray(p, p + n));
      }
      case 5: case 18: return this.lps();
      case 6: this.p += 8; return v.getFloat64(p, true);
      case 7: this.p += 2; return v.getInt16(p, true);
      case 8: this.p += 4; return v.getInt32(p, true);
      case 9: case 12: case 13: this.p += 8; return v.getBigInt64(p, true);
      case 10: this.p += 1; return v.getInt8(p);
      case 11: this.p += 4; return v.getFloat32(p, true);
      case 14: this.p += 2; return v.getUint16(p, true);
      case 15: this.p += 4; return v.getUint32(p, true);
      case 16: this.p += 8; return v.getBigUint64(p, true);
      case 17: return null;
      default: throw new Error(`primitive type ${pt}`);
    }
  }
  classInfo(): ClassInfo {
    const id = this.i32();
    const name = this.lps();
    const n = this.i32();
    const members: string[] = [];
    for (let i = 0; i < n; i++) members.push(this.lps());
    return { id, name, members };
  }
  extraOne(bt: number): Extra {
    if (bt === BT.Prim || bt === BT.PrimArr) return this.u8();
    if (bt === BT.SysClass) return this.lps();
    if (bt === BT.Class) return [this.lps(), this.i32()];
    return null;
  }
  values(bts: number[], extra: Extra[]): Value[] {
    const out: Value[] = [];
    let i = 0;
    while (i < bts.length) {
      if (bts[i] === BT.Prim) {
        out.push(this.prim(extra[i] as number));
        i++;
        continue;
      }
      const r = this.record();
      out.push(r);
      i += isNullRun(r) ? r.count! : 1;
    }
    return out;
  }
  items(n: number, primType: number | null): Value[] {
    const out: Value[] = [];
    let i = 0;
    while (i < n) {
      if (primType !== null) {
        out.push(this.prim(primType));
        i++;
        continue;
      }
      const r = this.record();
      out.push(r);
      i += isNullRun(r) ? r.count! : 1;
    }
    return out;
  }
  record(): Rec {
    const t = this.u8();
    switch (t) {
      case RT.BinaryLib: {
        const lib = { id: this.i32(), name: this.lps() };
        const next = this.record();
        (next.libs ??= []).unshift(lib);
        return next;
      }
      case RT.Header:
        return { t, root: this.i32(), hid: this.i32(), major: this.i32(), minor: this.i32() };
      case RT.ClassTypes:
      case RT.SysClassTypes: {
        const ci = this.classInfo();
        const bts: number[] = [];
        for (let i = 0; i < ci.members.length; i++) bts.push(this.u8());
        const extra = bts.map((bt) => this.extraOne(bt));
        const r: Rec = { t, ci, bts, extra };
        if (t === RT.ClassTypes) r.lib = this.i32();
        this.classes.set(ci.id, { bts, extra });
        r.values = this.values(bts, extra);
        return r;
      }
      case RT.ClassWithId: {
        const id = this.i32();
        const meta = this.i32();
        const m = this.classes.get(meta);
        if (!m) throw new Error(`unknown class metadata ${meta}`);
        this.classes.set(id, m);
        return { t, id, meta, values: this.values(m.bts, m.extra) };
      }
      case RT.ObjString:
        return { t, id: this.i32(), v: this.lps() };
      case RT.MemberRef:
        return { t, ref: this.i32() };
      case RT.ObjNull:
      case RT.MsgEnd:
        return { t };
      case RT.NullMulti256:
        return { t, count: this.u8() };
      case RT.NullMulti:
        return { t, count: this.i32() };
      case RT.MemberPrimTyped: {
        const pt = this.u8();
        return { t, pt, v: this.prim(pt) };
      }
      case RT.ArrPrim: {
        const id = this.i32();
        const n = this.i32();
        const pt = this.u8();
        const items: Value[] = [];
        for (let i = 0; i < n; i++) items.push(this.prim(pt));
        return { t, id, pt, items };
      }
      case RT.ArrObj:
      case RT.ArrStr: {
        const id = this.i32();
        const n = this.i32();
        return { t, id, n, items: this.items(n, null) };
      }
      case RT.BinaryArray: {
        const id = this.i32();
        const kind = this.u8();
        const rank = this.i32();
        const lengths: number[] = [];
        for (let i = 0; i < rank; i++) lengths.push(this.i32());
        let lower: number[] | null = null;
        if (kind === 3 || kind === 4 || kind === 5) {
          lower = [];
          for (let i = 0; i < rank; i++) lower.push(this.i32());
        }
        const bt = this.u8();
        const ex = this.extraOne(bt);
        const total = lengths.reduce((a, b) => a * b, 1);
        return { t, id, kind, rank, lengths, lower, bt, ex, items: this.items(total, bt === BT.Prim ? (ex as number) : null) };
      }
      default:
        throw new Error(`unsupported record type ${t} at ${this.p - 1}`);
    }
  }
}

class Writer {
  buf = new Uint8Array(1 << 16);
  n = 0;
  classes = new Map<number, { bts: number[]; extra: Extra[] }>();
  private ensure(k: number) {
    if (this.n + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.n + k) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.n));
    this.buf = b;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.n);
    this.n += b.length;
  }
  u8(v: number) {
    this.ensure(1);
    this.buf[this.n++] = v & 0xff;
  }
  i32(v: number) {
    this.ensure(4);
    new DataView(this.buf.buffer).setInt32(this.n, v, true);
    this.n += 4;
  }
  lps(s: string) {
    const raw = enc.encode(s);
    let n = raw.length;
    for (;;) {
      const c = n & 0x7f;
      n >>>= 7;
      this.u8(n ? c | 0x80 : c);
      if (!n) break;
    }
    this.bytes(raw);
  }
  prim(pt: number, v: Prim) {
    this.ensure(8);
    const dv = new DataView(this.buf.buffer);
    const p = this.n;
    switch (pt) {
      case 1: dv.setUint8(p, v ? 1 : 0); this.n += 1; return;
      case 2: dv.setUint8(p, Number(v)); this.n += 1; return;
      case 3: this.bytes(enc.encode(String(v))); return;
      case 5: case 18: this.lps(String(v)); return;
      case 6: dv.setFloat64(p, Number(v), true); this.n += 8; return;
      case 7: dv.setInt16(p, Number(v), true); this.n += 2; return;
      case 8: dv.setInt32(p, Number(v), true); this.n += 4; return;
      case 9: case 12: case 13: dv.setBigInt64(p, BigInt(v as bigint), true); this.n += 8; return;
      case 10: dv.setInt8(p, Number(v)); this.n += 1; return;
      case 11: dv.setFloat32(p, Number(v), true); this.n += 4; return;
      case 14: dv.setUint16(p, Number(v), true); this.n += 2; return;
      case 15: dv.setUint32(p, Number(v), true); this.n += 4; return;
      case 16: dv.setBigUint64(p, BigInt(v as bigint), true); this.n += 8; return;
      case 17: return;
      default: throw new Error(`primitive type ${pt}`);
    }
  }
  extraOne(bt: number, ex: Extra) {
    if (bt === BT.Prim || bt === BT.PrimArr) this.u8(ex as number);
    else if (bt === BT.SysClass) this.lps(ex as string);
    else if (bt === BT.Class) {
      this.lps((ex as [string, number])[0]);
      this.i32((ex as [string, number])[1]);
    }
  }
  values(bts: number[], extra: Extra[], vals: Value[]) {
    let i = 0;
    for (const v of vals) {
      if (bts[i] === BT.Prim) {
        this.prim(extra[i] as number, v as Prim);
        i++;
      } else {
        const r = v as Rec;
        this.record(r);
        i += isNullRun(r) ? r.count! : 1;
      }
    }
  }
  record(r: Rec) {
    for (const lib of r.libs ?? []) {
      this.u8(RT.BinaryLib);
      this.i32(lib.id);
      this.lps(lib.name);
    }
    const t = r.t;
    this.u8(t);
    switch (t) {
      case RT.Header:
        this.i32(r.root!); this.i32(r.hid!); this.i32(r.major!); this.i32(r.minor!);
        return;
      case RT.ClassTypes:
      case RT.SysClassTypes: {
        const ci = r.ci!;
        this.i32(ci.id);
        this.lps(ci.name);
        this.i32(ci.members.length);
        for (const m of ci.members) this.lps(m);
        for (const bt of r.bts!) this.u8(bt);
        r.bts!.forEach((bt, i) => this.extraOne(bt, r.extra![i]));
        if (t === RT.ClassTypes) this.i32(r.lib!);
        this.classes.set(ci.id, { bts: r.bts!, extra: r.extra! });
        this.values(r.bts!, r.extra!, r.values!);
        return;
      }
      case RT.ClassWithId: {
        this.i32(r.id!);
        this.i32(r.meta!);
        const m = this.classes.get(r.meta!);
        if (!m) throw new Error(`class metadata ${r.meta} not written before object ${r.id}`);
        this.classes.set(r.id!, m);
        this.values(m.bts, m.extra, r.values!);
        return;
      }
      case RT.ObjString:
        this.i32(r.id!);
        this.lps(String(r.v));
        return;
      case RT.MemberRef:
        this.i32(r.ref!);
        return;
      case RT.ObjNull:
      case RT.MsgEnd:
        return;
      case RT.NullMulti256:
        this.u8(r.count!);
        return;
      case RT.NullMulti:
        this.i32(r.count!);
        return;
      case RT.MemberPrimTyped:
        this.u8(r.pt!);
        this.prim(r.pt!, r.v as Prim);
        return;
      case RT.ArrPrim:
        this.i32(r.id!);
        this.i32(r.items!.length);
        this.u8(r.pt!);
        for (const v of r.items!) this.prim(r.pt!, v as Prim);
        return;
      case RT.ArrObj:
      case RT.ArrStr:
        this.i32(r.id!);
        this.i32(r.n!);
        for (const v of r.items!) this.record(v as Rec);
        return;
      case RT.BinaryArray:
        this.i32(r.id!);
        this.u8(r.kind!);
        this.i32(r.rank!);
        for (const x of r.lengths!) this.i32(x);
        if (r.lower) for (const x of r.lower) this.i32(x);
        this.u8(r.bt!);
        this.extraOne(r.bt!, r.ex!);
        for (const v of r.items!) {
          if (r.bt === BT.Prim) this.prim(r.ex as number, v as Prim);
          else this.record(v as Rec);
        }
        return;
      default:
        throw new Error(`cannot write record type ${t}`);
    }
  }
}

/** Top-level records of the stream (header first, MessageEnd last). */
export function readRecords(data: Uint8Array): Rec[] {
  const r = new Reader(data);
  const out: Rec[] = [];
  for (;;) {
    const rec = r.record();
    out.push(rec);
    if (rec.t === RT.MsgEnd) break;
  }
  if (r.p !== data.length) throw new Error(`${data.length - r.p} trailing bytes`);
  return out;
}

export function writeRecords(records: Rec[]): Uint8Array {
  const w = new Writer();
  for (const r of records) w.record(r);
  return w.buf.slice(0, w.n);
}
