"""
Stat rolls of upgrade instances, reproduced from the game code, and a search for the best seed.

How the game rolls (IL of UpgradeProperty_*.Apply, Range`1.GetValue, OverrideData`1.ApplyTo, Random):
  * property i (0-based in Upgrade.properties) gets Random(Upgrade.ModifyPropertySeed(seed, i + 1));
  * every GetValue / ApplyTo on that Random draws t = NextFloat() and the value is Lerp(min, max, t);
    an OverrideData with method None returns without drawing; Vector2 ranges draw once per component;
  * BoostParams.minIsBetter (get_MinIsBetter before the call) marks stats where the minimum is the good end.
Quality of a draw: t (max is better) or 1 - t (min is better). Fixed ranges (min == max) do not matter.
"""
from __future__ import annotations

import json
import os
import re
import struct

import dnfile
from dnfile.enums import MetadataTables
from dncil.cil.body import CilMethodBody
from dncil.cil.body.reader import CilMethodBodyReaderBase
from dncil.clr.token import Token

M32 = 0xFFFFFFFF


def _i32(x):
    x &= M32
    return x - (1 << 32) if x & 0x80000000 else x


def _imul(a, b):
    return _i32((a & M32) * (b & M32))


C1, C2 = -1547330877, -1640531527


def game_hash(x):
    v = _i32(x ^ C1)
    v = _imul(v, C2)
    v ^= (v & M32) >> 16
    v = _imul(v, C2)
    v ^= (v & M32) >> 16
    return _imul(v, C2)


def squirrel3(a, b):
    v = _i32(_imul(a, -1255572915) + b)
    v ^= (v & M32) >> 8
    v = _i32(v + 1759714724)
    v = _i32(v ^ (v << 8))
    v = _imul(v, 458671337)
    v ^= (v & M32) >> 8
    return _imul(v, C2)


def property_seed(seed, index1):
    return squirrel3(seed, _imul(game_hash(_imul(index1 + 384, 71)), 43874))


class GameRandom:
    def __init__(self, state):
        self.state = state

    def next(self):
        self.state = game_hash(self.state)
        return self.state

    def next_float(self):
        # (float)Next() * 2^-31, + 1, * 0.5  (single precision)
        f = struct.unpack('<f', struct.pack('<f', float(self.next()) * 4.656612873077393e-10))[0]
        return (f + 1.0) * 0.5

    def next_range(self, lo, hi):
        return (((self.next() & M32) * ((hi - lo) & M32)) >> 32) + lo


EFFECT_KEYS = {0: 'normal', 1: 'fire', 2: 'shock', 3: 'acid', 8: 'bees', 10: 'cryo'}


def roll_effect(rand, func, count):
    if func == 'GetRandomEffectIncludingNormal':
        return rand.next_range(0, 4)
    if func == 'GetRandomEffectIncludingNormalAndCryo':
        v = rand.next_range(0, 5)
        return 10 if v == 4 else v
    if func == 'GetRandomEffectIncludingCryo':
        n = count or 3
        v = rand.next_range(1, n + 2)
        return 10 if v == n + 1 else v
    if func == 'GetRandomEffectIncludingCryoAndBees':
        v = rand.next_range(1, 6)
        return 10 if v == 5 else 8 if v == 4 else v
    return rand.next_range(1, 4)


# ---------------------------------------------------------------- IL analysis

class _R(CilMethodBodyReaderBase):
    def __init__(self, pe, row):
        self.pe, self.offset = pe, pe.get_offset_from_rva(row.Rva)

    def read(self, n):
        d = self.pe.get_data(self.pe.get_rva_from_offset(self.offset), n)
        self.offset += n
        return d

    def tell(self):
        return self.offset

    def seek(self, o):
        self.offset = o
        return o


_HELPER = re.compile(r'^(modify|turbocharged|stack|em[A-Z]|Icon$)|StackMult\d*$')


def build_roll_steps(dll_path: str) -> dict:
    """{PropertyType: [{'field': f|None, 'kind': 'apply'|'next', 'min': bool}]} for the property's Apply."""
    pe = dnfile.dnPE(dll_path)
    T = pe.net.mdtables
    types = list(T.TypeDef)
    field_owner, method_owner = {}, {}
    for t in types:
        for f in t.FieldList:
            field_owner[f.row_index] = t.TypeName.value
        for m in t.MethodList:
            method_owner[m.row_index] = t.TypeName.value

    def callee(tok):
        if tok.table == MetadataTables.MethodDef.value:
            return method_owner.get(tok.rid, '?'), T.MethodDef[tok.rid - 1].Name.value
        if tok.table == MetadataTables.MemberRef.value:
            mr = T.MemberRef[tok.rid - 1]
            cn = getattr(mr.Class.row, 'TypeName', None)
            return (cn.value if cn is not None else '?'), mr.Name.value
        if tok.table == MetadataTables.MethodSpec.value:
            row = T.MethodSpec[tok.rid - 1].Method.row
            nm = getattr(row, 'Name', None)
            return '?', nm.value if nm is not None else '?'
        return '?', '?'

    out = {}
    for t in types:
        owner = t.TypeName.value
        if not owner.startswith('UpgradeProperty_'):
            continue
        apply = next((m.row for m in t.MethodList if m.row.Name.value == 'Apply' and m.row.Rva), None)
        if apply is None:
            continue
        try:
            ins = list(CilMethodBody(_R(pe, apply)).instructions)
        except Exception:  # noqa: BLE001
            continue
        steps, last_field, pushed, min_better = [], None, False, False
        prev = None
        for x in ins:
            n = x.opcode.name
            if n in ('ldfld', 'ldflda') and isinstance(x.operand, Token) and x.operand.table == MetadataTables.Field.value:
                fname = T.Field[x.operand.rid - 1].Name.value
                if field_owner.get(x.operand.rid) == owner and not _HELPER.match(fname):
                    last_field = fname
            elif n == 'ldarg.3':
                pushed = True
            elif n == 'newobj' and isinstance(x.operand, Token) and callee(x.operand) == ('BoostParams', '.ctor'):
                min_better = prev is not None and prev.opcode.name == 'ldc.i4.1'
            elif n in ('call', 'callvirt') and isinstance(x.operand, Token):
                cls, meth = callee(x.operand)
                if cls == 'BoostParams' and meth == 'get_MinIsBetter':
                    min_better = True
                elif meth in ('ApplyTo', 'GetValue', 'GetValueWithEmMultiplier', 'ApplyToUniform') and pushed:
                    steps.append({'field': last_field, 'kind': 'apply', 'min': min_better})
                    pushed, min_better = False, False
                elif ((cls == 'Random' and meth.startswith('Next')) or meth.startswith('GetRandomEffect')) and pushed:
                    steps.append({'field': None, 'kind': 'next', 'min': False})
                    pushed, min_better = False, False
            prev = x
        out[owner.removeprefix('UpgradeProperty_')] = steps
    return out


# ---------------------------------------------------------------- per-upgrade model

def _range_dims(v):
    """(method, [(min, max), ...]) of a stat field value from game.json."""
    method = None
    if isinstance(v, dict) and 'data' in v and 'method' in v:
        method, v = v['method'], v['data']
    if isinstance(v, dict) and 'min' in v and 'max' in v:
        lo, hi = v['min'], v['max']
        if isinstance(lo, dict):
            return method, [(lo[k], hi[k]) for k in lo]
        return method, [(lo, hi)]
    return method, []


def upgrade_draws(u: dict, steps: dict) -> list[list[tuple[int, bool]]]:
    """Per property: list of (direction, matters) for every draw; direction +1 max-better, -1 min-better, 0 = not a stat."""
    out = []
    for p in u.get('props', []):
        seq = []
        for st in steps.get(p['type'], []):
            if st['kind'] == 'next':
                seq.append((0, False))
                continue
            method, dims = _range_dims(p['data'].get(st['field'])) if st['field'] else (None, [])
            if method == 0:
                continue
            if not dims:
                seq.append((0, False))
                continue
            for lo, hi in dims:
                seq.append((-1 if st['min'] else 1, isinstance(lo, (int, float)) and lo != hi))
        out.append(seq)
    return out


def seed_quality(seed: int, draws) -> tuple[float, float]:
    worst, total, n = 1.0, 0.0, 0
    for i, seq in enumerate(draws):
        if not any(m for _, m in seq):
            continue
        r = GameRandom(property_seed(seed, i + 1))
        for direction, matters in seq:
            t = r.next_float()
            if not matters or direction == 0:
                continue
            q = t if direction > 0 else 1 - t
            worst = min(worst, q)
            total += q
            n += 1
    return (worst, total / n) if n else (1.0, 1.0)


def seed_element(u: dict, seed: int):
    r = u.get('elementRoll')
    if not r:
        return None
    rand = GameRandom(property_seed(seed, r['prop'] + 1))
    for _ in range(r['draws']):
        rand.next()
    return EFFECT_KEYS.get(roll_effect(rand, r['func'], r.get('count')))


def best_seed(u: dict, steps: dict, element: str | None = None, tries: int = 40000, start: int = 1, avoid=(), accept=None) -> tuple[int, float, float]:
    draws = upgrade_draws(u, steps)
    best = None
    s = start
    checked = 0
    while checked < tries:
        s = game_hash(s)  # spread candidates over the int range
        seed = s & 0x7FFFFFFF
        if seed in avoid or (element and seed_element(u, seed) != element) or (accept and not accept(seed)):
            continue
        checked += 1
        w, m = seed_quality(seed, draws)
        if best is None or (w, m) > (best[1], best[2]):
            best = (seed, w, m)
            if w > 0.999:
                break
    return best


def load_steps(cache: str, dll: str) -> dict:
    if os.path.exists(cache) and os.path.getmtime(cache) > os.path.getmtime(dll):
        return json.load(open(cache, encoding='utf-8'))
    st = build_roll_steps(dll)
    json.dump(st, open(cache, 'w', encoding='utf-8'))
    return st
