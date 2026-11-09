/**
 * Minimal reader for MS-NRBF (.NET BinaryFormatter), the format of Mycopunk's PlayerData.saxon.
 * Produces plain JS values: class instances become objects with a `$class` field, arrays become arrays,
 * references are resolved after reading. Read-only; supports the record types the game save uses.
 */

export type NrbfValue = null | boolean | number | bigint | string | NrbfObject | NrbfValue[] | Uint8Array;
export interface NrbfObject {
  $class: string;
  [member: string]: NrbfValue;
}

class Ref {
  constructor(public id: number) {}
}

interface ClassInfo {
  name: string;
  members: string[];
  binaryTypes: number[] | null;
  extra: (number | string | null)[] | null;
}

const enum Rec {
  Header = 0,
  ClassWithId = 1,
  SystemClassWithMembers = 2,
  ClassWithMembers = 3,
  SystemClassWithMembersAndTypes = 4,
  ClassWithMembersAndTypes = 5,
  BinaryObjectString = 6,
  BinaryArray = 7,
  MemberPrimitiveTyped = 8,
  MemberReference = 9,
  ObjectNull = 10,
  MessageEnd = 11,
  BinaryLibrary = 12,
  ObjectNullMultiple256 = 13,
  ObjectNullMultiple = 14,
  ArraySinglePrimitive = 15,
  ArraySingleObject = 16,
  ArraySingleString = 17,
}

class Reader {
  p = 0;
  private dv: DataView;
  private td = new TextDecoder('utf-8');
  constructor(private b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get done() {
    return this.p >= this.b.length;
  }
  u8() {
    return this.b[this.p++];
  }
  i32() {
    const v = this.dv.getInt32(this.p, true);
    this.p += 4;
    return v;
  }
  str() {
    let n = 0;
    let shift = 0;
    for (;;) {
      const c = this.u8();
      n |= (c & 0x7f) << shift;
      shift += 7;
      if (!(c & 0x80)) break;
    }
    const s = this.td.decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  prim(t: number): NrbfValue {
    const dv = this.dv;
    const at = this.p;
    switch (t) {
      case 1: this.p += 1; return dv.getUint8(at) !== 0; // Boolean
      case 2: this.p += 1; return dv.getUint8(at); // Byte
      case 3: this.p += 1; return String.fromCharCode(dv.getUint8(at)); // Char (ASCII only)
      case 5: return this.str(); // Decimal (as string)
      case 6: this.p += 8; return dv.getFloat64(at, true);
      case 7: this.p += 2; return dv.getInt16(at, true);
      case 8: this.p += 4; return dv.getInt32(at, true);
      case 9: case 12: case 13: this.p += 8; return dv.getBigInt64(at, true); // Int64, TimeSpan, DateTime
      case 10: this.p += 1; return dv.getInt8(at);
      case 11: this.p += 4; return dv.getFloat32(at, true);
      case 14: this.p += 2; return dv.getUint16(at, true);
      case 15: this.p += 4; return dv.getUint32(at, true);
      case 16: this.p += 8; return dv.getBigUint64(at, true);
      case 18: return this.str();
      default: throw new Error(`NRBF: unsupported primitive type ${t} at ${at}`);
    }
  }
}

type Item = { kind: 'value'; v: NrbfValue | Ref } | { kind: 'nulls'; n: number } | { kind: 'skip' } | { kind: 'end' };

export function parseNrbf(bytes: Uint8Array): NrbfObject {
  const r = new Reader(bytes);
  const objects = new Map<number, NrbfValue>();
  const classes = new Map<number, ClassInfo>();
  let root: NrbfObject | null = null;

  const readClass = (t: number): ClassInfo & { id: number } => {
    if (t === Rec.ClassWithId) {
      const id = r.i32();
      const meta = r.i32();
      const c = classes.get(meta);
      if (!c) throw new Error(`NRBF: unknown class metadata ${meta}`);
      return { ...c, id };
    }
    const id = r.i32();
    const name = r.str();
    const n = r.i32();
    const members = Array.from({ length: n }, () => r.str());
    let binaryTypes: number[] | null = null;
    let extra: (number | string | null)[] | null = null;
    if (t === Rec.ClassWithMembersAndTypes || t === Rec.SystemClassWithMembersAndTypes) {
      binaryTypes = Array.from({ length: n }, () => r.u8());
      extra = binaryTypes.map((bt) => {
        if (bt === 0 || bt === 7) return r.u8();
        if (bt === 3) return r.str();
        if (bt === 4) {
          const s = r.str();
          r.i32();
          return s;
        }
        return null;
      });
    }
    if (t === Rec.ClassWithMembersAndTypes || t === Rec.ClassWithMembers) r.i32(); // library id
    const info = { name, members, binaryTypes, extra };
    classes.set(id, info);
    return { ...info, id };
  };

  const readArrayItems = (count: number, out: (NrbfValue | Ref)[]) => {
    while (out.length < count) {
      const it = readItem();
      if (it.kind === 'nulls') for (let i = 0; i < it.n; i++) out.push(null);
      else if (it.kind === 'value') out.push(it.v);
      else if (it.kind === 'end') throw new Error('NRBF: unexpected end inside array');
    }
  };

  const readValue = (): NrbfValue | Ref => {
    for (;;) {
      const it = readItem();
      if (it.kind === 'value') return it.v;
      if (it.kind === 'nulls') return null;
      if (it.kind === 'end') throw new Error('NRBF: unexpected end');
    }
  };

  function readItem(): Item {
    const t = r.u8();
    switch (t) {
      case Rec.Header:
        r.p += 16;
        return { kind: 'skip' };
      case Rec.BinaryLibrary:
        r.i32();
        r.str();
        return { kind: 'skip' };
      case Rec.MessageEnd:
        return { kind: 'end' };
      case Rec.ClassWithId:
      case Rec.SystemClassWithMembers:
      case Rec.ClassWithMembers:
      case Rec.SystemClassWithMembersAndTypes:
      case Rec.ClassWithMembersAndTypes: {
        const c = readClass(t);
        const o: NrbfObject = { $class: c.name };
        objects.set(c.id, o);
        if (!root) root = o; // the first object started is the root (members are read after it)
        c.members.forEach((m, i) => {
          o[m] = (c.binaryTypes && c.binaryTypes[i] === 0 ? r.prim(c.extra![i] as number) : readValue()) as NrbfValue;
        });
        return { kind: 'value', v: o };
      }
      case Rec.BinaryObjectString: {
        const id = r.i32();
        const s = r.str();
        objects.set(id, s);
        return { kind: 'value', v: s };
      }
      case Rec.MemberReference:
        return { kind: 'value', v: new Ref(r.i32()) };
      case Rec.ObjectNull:
        return { kind: 'value', v: null };
      case Rec.ObjectNullMultiple256:
        return { kind: 'nulls', n: r.u8() };
      case Rec.ObjectNullMultiple:
        return { kind: 'nulls', n: r.i32() };
      case Rec.MemberPrimitiveTyped:
        return { kind: 'value', v: r.prim(r.u8()) };
      case Rec.ArraySinglePrimitive: {
        const id = r.i32();
        const n = r.i32();
        const pt = r.u8();
        let arr: NrbfValue;
        if (pt === 2) {
          arr = bytes.slice(r.p, r.p + n);
          r.p += n;
        } else arr = Array.from({ length: n }, () => r.prim(pt));
        objects.set(id, arr);
        return { kind: 'value', v: arr };
      }
      case Rec.ArraySingleObject:
      case Rec.ArraySingleString: {
        const id = r.i32();
        const n = r.i32();
        const arr: (NrbfValue | Ref)[] = [];
        objects.set(id, arr as NrbfValue[]);
        readArrayItems(n, arr);
        return { kind: 'value', v: arr as NrbfValue[] };
      }
      case Rec.BinaryArray: {
        const id = r.i32();
        const arrayType = r.u8();
        const rank = r.i32();
        const lengths = Array.from({ length: rank }, () => r.i32());
        if (arrayType >= 3) for (let i = 0; i < rank; i++) r.i32(); // lower bounds
        const bt = r.u8();
        let ex: number | null = null;
        if (bt === 0 || bt === 7) ex = r.u8();
        else if (bt === 3) r.str();
        else if (bt === 4) {
          r.str();
          r.i32();
        }
        const total = lengths.reduce((a, b) => a * b, 1);
        const arr: (NrbfValue | Ref)[] = [];
        objects.set(id, arr as NrbfValue[]);
        if (bt === 0) for (let i = 0; i < total; i++) arr.push(r.prim(ex!));
        else readArrayItems(total, arr);
        return { kind: 'value', v: arr as NrbfValue[] };
      }
      default:
        throw new Error(`NRBF: unsupported record type ${t} at offset ${r.p - 1}`);
    }
  }

  while (!r.done) {
    const it = readItem();
    if (it.kind === 'end') break;
  }
  if (!root) throw new Error('NRBF: no root object');

  // resolve references (iteratively: saves can be deep)
  const seen = new Set<object>();
  const stack: (NrbfObject | (NrbfValue | Ref)[])[] = [root];
  const res = (v: NrbfValue | Ref): NrbfValue => (v instanceof Ref ? (objects.get(v.id) ?? null) : v);
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (Array.isArray(cur)) {
      for (let i = 0; i < cur.length; i++) {
        const v = (cur[i] = res(cur[i]));
        if (v && typeof v === 'object' && !(v instanceof Uint8Array)) stack.push(v as NrbfObject);
      }
    } else {
      for (const k of Object.keys(cur)) {
        const v = (cur[k] = res(cur[k] as NrbfValue | Ref));
        if (v && typeof v === 'object' && !(v instanceof Uint8Array)) stack.push(v as NrbfObject);
      }
    }
  }
  return root;
}
