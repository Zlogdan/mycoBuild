"""
Lossless reader/writer for .NET BinaryFormatter streams (MS-NRBF), used by Mycopunk saves (*.saxon).

Every record is kept with all of its encoded details, so `write(read(b)) == b` holds byte for byte.
Values can then be edited in place (primitives), and objects can be cloned / referenced.

Record model (dicts):
  {'t': <record type>, ...fields...}
  class records carry 'values': list of member values; a member value is either a raw primitive
  (for members of primitive type) or a nested record. ObjectNullMultiple records inside 'values' or
  array 'items' stand for several null slots.
"""
from __future__ import annotations

import struct

# record types
HEADER, CLASS_WITH_ID, SYS_CLASS_MEMBERS, CLASS_MEMBERS, SYS_CLASS_TYPES, CLASS_TYPES = 0, 1, 2, 3, 4, 5
OBJ_STRING, BINARY_ARRAY, MEMBER_PRIM_TYPED, MEMBER_REF, OBJ_NULL, MSG_END, BINARY_LIB = 6, 7, 8, 9, 10, 11, 12
NULL_MULTI_256, NULL_MULTI, ARR_PRIM, ARR_OBJ, ARR_STR = 13, 14, 15, 16, 17

# binary type enum
BT_PRIM, BT_STRING, BT_OBJECT, BT_SYSCLASS, BT_CLASS, BT_OBJARR, BT_STRARR, BT_PRIMARR = range(8)

_PRIM = {  # primitive type -> struct format (None = special)
    1: '<?', 2: '<B', 3: None, 5: None, 6: '<d', 7: '<h', 8: '<i', 9: '<q', 10: '<b', 11: '<f',
    12: '<q', 13: '<q', 14: '<H', 15: '<I', 16: '<Q', 17: None, 18: None,
}


class Reader:
    def __init__(self, data: bytes):
        self.d = data
        self.p = 0
        self.classes: dict[int, dict] = {}  # objectId -> class record (for ClassWithId metadata)

    # ---- low level ----
    def u8(self):
        v = self.d[self.p]
        self.p += 1
        return v

    def i32(self):
        v = struct.unpack_from('<i', self.d, self.p)[0]
        self.p += 4
        return v

    def lps(self):
        n, shift = 0, 0
        while True:
            b = self.u8()
            n |= (b & 0x7F) << shift
            if not b & 0x80:
                break
            shift += 7
        s = self.d[self.p:self.p + n].decode('utf-8')
        self.p += n
        return s

    def prim(self, pt):
        if pt == 18 or pt == 5:
            return self.lps()
        if pt == 3:  # UTF-8 char
            b = self.d[self.p]
            n = 1 if b < 0x80 else 2 if b < 0xE0 else 3 if b < 0xF0 else 4
            s = self.d[self.p:self.p + n].decode('utf-8')
            self.p += n
            return s
        if pt == 17:
            return None
        fmt = _PRIM[pt]
        v = struct.unpack_from(fmt, self.d, self.p)[0]
        self.p += struct.calcsize(fmt)
        return v

    # ---- structures ----
    def class_info(self):
        oid = self.i32()
        name = self.lps()
        n = self.i32()
        return {'id': oid, 'name': name, 'members': [self.lps() for _ in range(n)]}

    def member_types(self, n):
        bts = [self.u8() for _ in range(n)]
        extra = []
        for bt in bts:
            if bt in (BT_PRIM, BT_PRIMARR):
                extra.append(self.u8())
            elif bt == BT_SYSCLASS:
                extra.append(self.lps())
            elif bt == BT_CLASS:
                extra.append((self.lps(), self.i32()))
            else:
                extra.append(None)
        return bts, extra

    def values(self, bts, extra):
        out, i = [], 0
        while i < len(bts):
            if bts[i] == BT_PRIM:
                out.append(self.prim(extra[i]))
                i += 1
                continue
            r = self.record()
            out.append(r)
            i += r['count'] if r['t'] in (NULL_MULTI, NULL_MULTI_256) else 1
        return out

    def items(self, n, prim_type=None):
        out, i = [], 0
        while i < n:
            if prim_type is not None:
                out.append(self.prim(prim_type))
                i += 1
                continue
            r = self.record()
            out.append(r)
            i += r['count'] if r['t'] in (NULL_MULTI, NULL_MULTI_256) else 1
        return out

    def record(self):
        t = self.u8()
        if t == BINARY_LIB:  # a library record precedes the actual value
            lib = {'t': t, 'id': self.i32(), 'name': self.lps()}
            nxt = self.record()
            nxt.setdefault('libs', []).insert(0, lib)
            return nxt
        if t == HEADER:
            return {'t': t, 'root': self.i32(), 'hid': self.i32(), 'major': self.i32(), 'minor': self.i32()}
        if t in (CLASS_TYPES, SYS_CLASS_TYPES):
            ci = self.class_info()
            bts, extra = self.member_types(len(ci['members']))
            r = {'t': t, 'ci': ci, 'bts': bts, 'extra': extra}
            if t == CLASS_TYPES:
                r['lib'] = self.i32()
            self.classes[ci['id']] = r
            r['values'] = self.values(bts, extra)
            return r
        if t == CLASS_WITH_ID:
            oid, meta = self.i32(), self.i32()
            m = self.classes[meta]
            r = {'t': t, 'id': oid, 'meta': meta}
            self.classes[oid] = {'ci': m['ci'], 'bts': m['bts'], 'extra': m['extra'], 'alias': meta}
            r['values'] = self.values(m['bts'], m['extra'])
            return r
        if t in (CLASS_MEMBERS, SYS_CLASS_MEMBERS):
            raise ValueError('ClassWithMembers without type info is not supported')
        if t == OBJ_STRING:
            return {'t': t, 'id': self.i32(), 'v': self.lps()}
        if t == MEMBER_REF:
            return {'t': t, 'ref': self.i32()}
        if t == OBJ_NULL:
            return {'t': t}
        if t == NULL_MULTI_256:
            return {'t': t, 'count': self.u8()}
        if t == NULL_MULTI:
            return {'t': t, 'count': self.i32()}
        if t == MEMBER_PRIM_TYPED:
            pt = self.u8()
            return {'t': t, 'pt': pt, 'v': self.prim(pt)}
        if t == ARR_PRIM:
            oid, n, pt = self.i32(), self.i32(), self.u8()
            return {'t': t, 'id': oid, 'pt': pt, 'items': [self.prim(pt) for _ in range(n)]}
        if t in (ARR_OBJ, ARR_STR):
            oid, n = self.i32(), self.i32()
            return {'t': t, 'id': oid, 'n': n, 'items': self.items(n)}
        if t == BINARY_ARRAY:
            oid, kind, rank = self.i32(), self.u8(), self.i32()
            lengths = [self.i32() for _ in range(rank)]
            lower = [self.i32() for _ in range(rank)] if kind in (3, 4, 5) else None
            bt = self.u8()
            (ex,) = self.member_types_one(bt)
            total = 1
            for x in lengths:
                total *= x
            r = {'t': t, 'id': oid, 'kind': kind, 'rank': rank, 'lengths': lengths, 'lower': lower, 'bt': bt, 'ex': ex}
            r['items'] = self.items(total, ex if bt == BT_PRIM else None)
            return r
        if t == MSG_END:
            return {'t': t}
        raise ValueError(f'unknown record type {t} at {self.p - 1}')

    def member_types_one(self, bt):
        if bt in (BT_PRIM, BT_PRIMARR):
            return (self.u8(),)
        if bt == BT_SYSCLASS:
            return (self.lps(),)
        if bt == BT_CLASS:
            return ((self.lps(), self.i32()),)
        return (None,)


class Writer:
    def __init__(self):
        self.b = bytearray()
        self.classes: dict[int, tuple] = {}

    def u8(self, v):
        self.b.append(v)

    def i32(self, v):
        self.b += struct.pack('<i', v)

    def lps(self, s):
        raw = s.encode('utf-8')
        n = len(raw)
        while True:
            c = n & 0x7F
            n >>= 7
            self.u8(c | 0x80 if n else c)
            if not n:
                break
        self.b += raw

    def prim(self, pt, v):
        if pt in (18, 5):
            self.lps(v)
        elif pt == 3:
            self.b += v.encode('utf-8')
        elif pt == 17:
            pass
        else:
            self.b += struct.pack(_PRIM[pt], v)

    def extra_one(self, bt, ex):
        if bt in (BT_PRIM, BT_PRIMARR):
            self.u8(ex)
        elif bt == BT_SYSCLASS:
            self.lps(ex)
        elif bt == BT_CLASS:
            self.lps(ex[0])
            self.i32(ex[1])

    def values(self, bts, extra, vals):
        i = 0
        for v in vals:
            if bts[i] == BT_PRIM:
                self.prim(extra[i], v)
                i += 1
            else:
                self.record(v)
                i += v['count'] if v['t'] in (NULL_MULTI, NULL_MULTI_256) else 1

    def record(self, r):
        for lib in r.get('libs', []):
            self.u8(BINARY_LIB)
            self.i32(lib['id'])
            self.lps(lib['name'])
        t = r['t']
        self.u8(t)
        if t == HEADER:
            for k in ('root', 'hid', 'major', 'minor'):
                self.i32(r[k])
        elif t in (CLASS_TYPES, SYS_CLASS_TYPES):
            ci = r['ci']
            self.i32(ci['id'])
            self.lps(ci['name'])
            self.i32(len(ci['members']))
            for m in ci['members']:
                self.lps(m)
            for bt in r['bts']:
                self.u8(bt)
            for bt, ex in zip(r['bts'], r['extra']):
                self.extra_one(bt, ex)
            if t == CLASS_TYPES:
                self.i32(r['lib'])
            self.classes[ci['id']] = (r['bts'], r['extra'])
            self.values(r['bts'], r['extra'], r['values'])
        elif t == CLASS_WITH_ID:
            self.i32(r['id'])
            self.i32(r['meta'])
            bts, extra = self.classes[r['meta']]
            self.classes[r['id']] = (bts, extra)
            self.values(bts, extra, r['values'])
        elif t == OBJ_STRING:
            self.i32(r['id'])
            self.lps(r['v'])
        elif t == MEMBER_REF:
            self.i32(r['ref'])
        elif t in (OBJ_NULL, MSG_END):
            pass
        elif t == NULL_MULTI_256:
            self.u8(r['count'])
        elif t == NULL_MULTI:
            self.i32(r['count'])
        elif t == MEMBER_PRIM_TYPED:
            self.u8(r['pt'])
            self.prim(r['pt'], r['v'])
        elif t == ARR_PRIM:
            self.i32(r['id'])
            self.i32(len(r['items']))
            self.u8(r['pt'])
            for v in r['items']:
                self.prim(r['pt'], v)
        elif t in (ARR_OBJ, ARR_STR):
            self.i32(r['id'])
            self.i32(r['n'])
            for v in r['items']:
                self.record(v)
        elif t == BINARY_ARRAY:
            self.i32(r['id'])
            self.u8(r['kind'])
            self.i32(r['rank'])
            for x in r['lengths']:
                self.i32(x)
            if r['lower'] is not None:
                for x in r['lower']:
                    self.i32(x)
            self.u8(r['bt'])
            self.extra_one(r['bt'], r['ex'])
            for v in r['items']:
                if r['bt'] == BT_PRIM:
                    self.prim(r['ex'], v)
                else:
                    self.record(v)
        else:
            raise ValueError(f'cannot write record type {t}')


def read(data: bytes) -> list[dict]:
    """Top-level records of the stream (header first, MessageEnd last)."""
    r = Reader(data)
    out = []
    while True:
        rec = r.record()
        out.append(rec)
        if rec['t'] == MSG_END:
            break
    if r.p != len(data):
        raise ValueError(f'{len(data) - r.p} trailing bytes')
    return out


def write(records: list[dict]) -> bytes:
    w = Writer()
    for rec in records:
        w.record(rec)
    return bytes(w.b)


class Doc:
    """Convenience view: objects by id, member access by name."""

    def __init__(self, records: list[dict]):
        self.records = records
        self.by_id: dict[int, dict] = {}
        self.meta: dict[int, dict] = {}
        self._walk(records)

    def _walk(self, recs):
        for r in recs:
            if not isinstance(r, dict):
                continue
            if r['t'] in (CLASS_TYPES, SYS_CLASS_TYPES):
                self.meta[r['ci']['id']] = r
                self.by_id[r['ci']['id']] = r
            elif 'id' in r and r['t'] != HEADER:
                self.by_id[r['id']] = r
            for key in ('values', 'items'):
                if key in r:
                    self._walk(r[key])

    def cls(self, r) -> dict:
        return self.meta[r['meta']] if r['t'] == CLASS_WITH_ID else r

    def class_name(self, r) -> str:
        return self.cls(r)['ci']['name']

    def index_of(self, r, member) -> int:
        """Position of a member in r['values'] (no null-multiple runs expected before it)."""
        members = self.cls(r)['ci']['members']
        i = members.index(member)
        pos, slot = 0, 0
        for v in r['values']:
            if slot == i:
                return pos
            slot += v['count'] if isinstance(v, dict) and v['t'] in (NULL_MULTI, NULL_MULTI_256) else 1
            pos += 1
        raise KeyError(member)

    def get(self, r, member):
        v = r['values'][self.index_of(r, member)]
        return self.deref(v)

    def set(self, r, member, value):
        r['values'][self.index_of(r, member)] = value

    def deref(self, v):
        if isinstance(v, dict) and v['t'] == MEMBER_REF:
            return self.by_id[v['ref']]
        return v

    def root(self):
        return self.by_id[self.records[0]['root']]
